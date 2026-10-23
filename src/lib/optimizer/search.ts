import { explainabilityScores, resultEntities } from "@/lib/qloo/normalize";
import type { QlooToolCallRecord } from "@/lib/qloo/types";
import { BudgetedQloo, CallLog, classify, QlooAuthError } from "./budget";
import { compareTastes, describeEntity, entityTags, momentum, Notes, rankOptions, trendWindow } from "./qloo-steps";
import { applyMove, describeMove, heuristicPropose, MAX_CONSECUTIVE_REJECTS, nemotronPropose, type Proposal, type ProposalContext } from "./proposer";
import { lineupKey, pctChange, round, scoreLineup, tagOverlap } from "./scoring";
import type {
  ActProfile,
  BudgetState,
  BrandScore,
  Choice,
  ComparableCheck,
  TasteOverlap,
  IterationEvent,
  Lineup,
  LineupScore,
  Move,
  NextSponsor,
  OptimizeInput,
  OptimizeResult,
  OptimizerEvent,
  ResolvedEntity,
  SetupEvent,
  SlotProfile,
} from "./types";

// The lineup optimizer's agent loop.
//
//   setup:    resolve brands, acts and venues once (IDs from then on); one
//             qloo_rank call scores all acts, one all venues, against the
//             brands on a shared scale; then per-act taste tags and momentum;
//             then score the draft lineup.
//   loop:     propose one move (Nemotron or heuristic) -> score the new
//             lineup with qloo_rank -> if it beats the current one, confirm
//             the fit gain on the shared setup scale -> accept or reject;
//             for accepted moves, qloo_compare_audiences shows how the
//             audience's tastes change.
//   stop:     the proposer stops, the budget runs out, no legal moves remain,
//             too many rejections in a row, or the iteration cap.
//   final:    qloo_recommend for further sponsors (with explainability) and a
//             draft-vs-final taste comparison.
//
// Invariant: a move is accepted only with an ok qloo_rank result for the new
// lineup that beats the current objective, and never when the comparable
// (single-call) Qloo scores contradict its fit gain.

export class OptimizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizerError";
  }
}

export interface OptimizerDeps {
  qloo: BudgetedQloo;
  log: CallLog;
  emit: (event: OptimizerEvent) => void;
  llm: { enabled: boolean; apiKey?: string; model: string; fetch?: typeof fetch };
  now?: Date;
  maxIterations?: number;
  /** Minimum objective gain (0-100 scale) for a move to count as better. */
  minGain?: number;
  concurrency?: number;
}

/** Calls kept back for the final recommendation step. */
const FINAL_RESERVE = 1;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function slotLabel(s: { venue: string; city: string; date?: string }): string {
  return `${s.venue}, ${s.city}${s.date ? ` (${s.date})` : ""}`;
}

export async function runOptimizer(input: OptimizeInput, deps: OptimizerDeps): Promise<OptimizeResult> {
  const { qloo, log, emit } = deps;
  const pins = input.pins ?? {};
  const maxIterations = deps.maxIterations ?? 10;
  const minGain = deps.minGain ?? 0.3;
  const concurrency = deps.concurrency ?? 4;
  const allChoices: Choice[] = [];
  let setupCalls = 0;
  const budget = (): BudgetState => ({ used: qloo.used, limit: qloo.limit, setup: setupCalls || qloo.used });

  const setup = (phase: SetupEvent["phase"], title: string) => {
    emit({ type: "setup", phase, status: "running", title, budget: budget() });
    return new Notes();
  };
  const setupDone = (phase: SetupEvent["phase"], title: string, summary: string, notes: Notes, status: SetupEvent["status"] = "done", score?: LineupScore) => {
    const t = notes.take();
    if (t.choices) allChoices.push(...t.choices);
    emit({ type: "setup", phase, status, title, summary, ...t, calls: log.drain(), ...(score ? { score } : {}), budget: budget() });
  };

  try {
    // 1. RESOLVE ---------------------------------------------------------------
    let title = "Resolve sponsors, acts and venues";
    let notes = setup("resolve", title);
    const brands = (await mapLimit(input.brands, concurrency, (b) => describeEntity(qloo, notes, b, "brand", "brand", pins))).filter(
      (b): b is ResolvedEntity => !!b,
    );
    if (!brands.length) {
      setupDone("resolve", title, "No target brand matched a Qloo brand.", notes, "error");
      throw new OptimizerError("None of the target brands matched a Qloo brand. Check the spelling.");
    }
    const brandIds = brands.map((b) => b.id);
    const draftCity = input.slots[0]!.city;
    // One qloo_rank call scores every candidate act against the brands'
    // audience on one comparable scale, and resolves the acts to IDs.
    const actRank = await rankOptions(qloo, notes, {
      options: input.acts.map((a) => a.name),
      optionType: "artist",
      signals: brandIds,
      signalLocation: draftCity,
      pins,
      field: "act",
      label: "Rank acts for the brands' audience",
    });
    const venueNames = [...new Set(input.slots.map((s) => s.venue))];
    const venueRank = await rankOptions(qloo, notes, {
      options: venueNames,
      optionType: "place",
      signals: brandIds,
      pins,
      field: "venue",
      label: "Rank venues for the brands' audience",
      hints: Object.fromEntries(input.slots.map((s) => [s.venue, s.city])),
    });
    const acts: ActProfile[] = [];
    for (const a of input.acts) {
      const r = actRank.get(a.name);
      if (!r) {
        notes.notes.push(`"${a.name}" could not be scored by Qloo; left out.`);
        continue;
      }
      if (acts.some((x) => x.entity.id === r.id)) {
        notes.notes.push(`"${a.name}" resolved to ${r.name}, already listed; deduplicated.`);
        continue;
      }
      acts.push({ input: a, entity: { input: a.name, id: r.id, name: r.name, match: r.match }, brandAffinity: r.affinity, tags: [] });
    }
    const slots: SlotProfile[] = input.slots.map((s) => {
      const v = venueRank.get(s.venue);
      return { input: s, label: slotLabel(s), ...(v ? { entity: { input: s.venue, id: v.id, name: v.name, match: v.match }, brandAffinity: v.affinity } : {}) };
    });
    if (acts.length < input.billSize + 1) {
      setupDone("resolve", title, `Only ${acts.length} acts resolved.`, notes, "error");
      throw new OptimizerError(`Only ${acts.length} acts resolved in Qloo; the optimizer needs at least ${input.billSize + 1}.`);
    }
    notes.notes.push(`Brands: ${brands.map((b) => b.name).join(", ")}.`);
    notes.notes.push(`Act affinity for the brands' audience: ${[...acts].sort((x, y) => y.brandAffinity! - x.brandAffinity!).map((a) => `${a.entity.name} ${a.brandAffinity!.toFixed(2)}`).join(", ")}.`);
    for (const s of slots) if (!s.entity) notes.notes.push(`Venue "${s.input.venue}" not scored; that slot uses its city only.`);
    setupDone("resolve", title, `${brands.length} brand${brands.length > 1 ? "s" : ""}, ${acts.length} acts, ${slots.filter((s) => s.entity).length} of ${slots.length} venues resolved.`, notes);

    // 2. PROFILE ---------------------------------------------------------------
    title = "Profile each act: taste tags and momentum";
    notes = setup("profile", title);
    await mapLimit(acts, concurrency, async (a) => {
      a.tags = await entityTags(qloo, notes, a.entity.id, a.entity.name);
    });
    const window = trendWindow(deps.now ?? new Date());
    const trends = await momentum(qloo, notes, acts.map((a) => a.entity.id), "artist", window);
    for (const a of acts) a.momentum = trends.get(a.entity.id);
    const rising = acts.filter((a) => a.momentum).sort((x, y) => y.momentum!.value - x.momentum!.value);
    const noData = acts.filter((a) => !a.momentum);
    if (rising.length) notes.notes.push(`Momentum ${window.start} to ${window.end} (Qloo trend data lags, so the window ends months back): ${rising.map((a) => `${a.entity.name} ${a.momentum!.value >= 0 ? "+" : ""}${Math.round(a.momentum!.value * 100)}%`).join(", ")}.`);
    if (noData.length && rising.length) notes.notes.push(`No recent trend data for ${noData.map((a) => a.entity.name).join(", ")}; counted as flat so it neither helps nor blocks a move.`);
    if (!rising.length) notes.notes.push("No recent trend data for any act; momentum is left out of the objective.");
    setupDone("profile", title, `${acts.filter((a) => a.tags.length).length} tag profiles, ${trends.size} trend series.`, notes);

    // 3. BASELINE --------------------------------------------------------------
    title = "Score your draft lineup";
    notes = setup("baseline", title);
    const cache = new Map<string, LineupScore>();
    const primaryId = brands[0]!.id;

    /** One qloo_rank call: the target brands ranked for this lineup's audience. */
    async function evaluate(lineup: Lineup, n: Notes): Promise<{ score?: LineupScore; reason?: string }> {
      const key = lineupKey(lineup);
      const hit = cache.get(key);
      if (hit) return { score: hit };
      const slot = slots[lineup.slot]!;
      const env = await qloo.call("qloo_rank", {
        options: brandIds,
        option_type: "brand",
        signals: [...lineup.acts, ...(slot.entity ? [slot.entity.id] : [])],
        signal_location: slot.input.city,
      });
      const c = classify(env);
      if (c.warning) n.warnings.push(`Rank brands: ${c.warning}`);
      if (c.status !== "ok") return { reason: c.status === "error" ? c.error : `qloo_rank returned ${c.status}` };
      const found = new Map(resultEntities(env).map((e) => [e.entity_id, e]));
      const scores: BrandScore[] = brands.flatMap((b) => {
        const e = found.get(b.id);
        return e && typeof e.affinity === "number" && Number.isFinite(e.affinity) ? [{ id: b.id, name: b.name, affinity: round(e.affinity) }] : [];
      });
      if (!scores.length) return { reason: "qloo_rank returned no affinity for the target brands" };
      const score = scoreLineup({ lineup, brands: scores, acts, goal: input.goal, primaryId, evidenceId: env.execution?.correlation_id ?? "?" });
      cache.set(key, score);
      return { score };
    }

    const draftActs = acts.slice(0, input.billSize).map((a) => a.entity.id);
    const draftResolved = input.acts.slice(0, input.billSize).every((a) => acts.some((x) => x.input.name === a.name));
    if (!draftResolved) notes.notes.push("Part of the draft lineup did not resolve; the draft uses the first resolved acts instead.");
    const draftEval = await evaluate({ acts: draftActs, slot: 0 }, notes);
    if (!draftEval.score) {
      setupDone("baseline", title, "Qloo could not score the draft.", notes, "error");
      throw new OptimizerError(`Qloo could not score the draft lineup (${draftEval.reason}).`);
    }
    const draft = draftEval.score;
    notes.notes.push(
      `Draft objective ${draft.objective}: fit ${draft.parts.fit.toFixed(2)}${draft.parts.cohesion !== undefined ? `, cohesion ${draft.parts.cohesion.toFixed(2)}` : ""}${draft.parts.momentum !== undefined ? `, momentum ${draft.parts.momentum.toFixed(2)}` : ""}.`,
    );
    setupCalls = qloo.used;
    setupDone("baseline", title, `Draft scores ${draft.objective} / 100.`, notes, "done", draft);

    // 4. SEARCH LOOP -----------------------------------------------------------
    let current = draft;
    const tried = new Set<string>([draft.key]);
    const history: OptimizeResult["history"] = [{ iteration: 0, objective: draft.objective, accepted: true, best: draft.objective }];
    const ctxHistory: ProposalContext["history"] = [];
    const accepted: OptimizeResult["acceptedMoves"] = [];
    const tasteShifts = new Map<string, TasteOverlap>();
    let consecutiveRejects = 0;
    let stopReason = `Reached the ${maxIterations}-iteration cap.`;
    const actName = (id: string) => acts.find((a) => a.entity.id === id)?.entity.name ?? id;
    const group = (s: LineupScore) => [...s.lineup.acts, ...(slots[s.lineup.slot]?.entity ? [slots[s.lineup.slot]!.entity!.id] : [])];

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (qloo.remaining < 1 + FINAL_RESERVE) {
        stopReason = `Qloo call budget nearly spent (${qloo.used}/${qloo.limit}); keeping ${FINAL_RESERVE} for the final step.`;
        break;
      }
      if (consecutiveRejects >= MAX_CONSECUTIVE_REJECTS) {
        stopReason = `${consecutiveRejects} rejections in a row.`;
        break;
      }
      const ctx: ProposalContext = { acts, slots, brands, goal: input.goal, current, tried, history: ctxHistory, remaining: qloo.remaining, iteration, consecutiveRejects };
      const proposal: Proposal =
        deps.llm.enabled && deps.llm.apiKey ? await nemotronPropose(ctx, { apiKey: deps.llm.apiKey, model: deps.llm.model, fetch: deps.llm.fetch }) : heuristicPropose(ctx);
      if (proposal.stop || !proposal.move) {
        stopReason = proposal.stop ?? "No proposal.";
        if (proposal.note) stopReason += ` (${proposal.note})`;
        break;
      }
      const move = proposal.move;
      const moveText = describeMove(move, acts, slots);
      const base: Omit<IterationEvent, "phase" | "budget"> = {
        type: "iteration",
        iteration,
        move,
        moveText,
        proposer: proposal.proposer,
        rationale: proposal.rationale,
        proposerNote: proposal.note,
      };
      emit({ ...base, phase: "proposal", budget: budget() });

      const n = new Notes();
      const nextLineup = applyMove(current.lineup, move);
      tried.add(lineupKey(nextLineup));
      const ev = await evaluate(nextLineup, n);
      const calls: QlooToolCallRecord[] = log.drain();
      emit({ ...base, phase: "evidence", candidate: ev.score, calls, budget: budget() });

      let ok = false;
      let reason: string;
      let comparable: ComparableCheck | undefined;
      let tastes: TasteOverlap | undefined;
      if (!ev.score) {
        reason = `Rejected: no Qloo evidence for the new lineup (${ev.reason}).`;
      } else if (ev.score.objective < current.objective + minGain) {
        reason = `Rejected: Qloo scores it ${ev.score.objective} vs. current ${current.objective}.`;
      } else {
        // Per-lineup qloo_rank scores come from separate calls, which Qloo
        // says are not directly comparable. Confirm a fit gain against the
        // one setup call that scored every act (or venue) on one scale.
        comparable = comparableCheck(move, current, ev.score, acts, slots);
        if (comparable.contradicts) {
          reason = `Rejected: per-lineup qloo_rank says ${ev.score.objective} vs. ${current.objective}, but ${comparable.note}`;
        } else {
          ok = true;
          reason = `Accepted: objective ${current.objective} -> ${ev.score.objective}; ${comparable.note}`;
          // Taste evidence for the trace: how the audience changes (one compare_audiences call).
          if (qloo.remaining >= 1 + FINAL_RESERVE) {
            tastes = await compareTastes(qloo, n, group(current), group(ev.score));
            tasteShifts.set(`${current.key}>${ev.score.key}`, tastes);
          }
        }
      }

      const explanation = ok && ev.score ? explainMove(moveText, current, ev.score, tastes, brands[0]!.name) : undefined;
      ctxHistory.push({ iteration, moveText, accepted: ok, before: current.objective, after: ev.score?.objective, reason });
      if (ok && ev.score) {
        current = ev.score;
        consecutiveRejects = 0;
        accepted.push({ iteration, moveText, explanation: explanation! });
      } else {
        consecutiveRejects += 1;
      }
      history.push({ iteration, objective: ev.score?.objective ?? current.objective, accepted: ok, best: current.objective });
      if (n.warnings.length) reason += ` Warnings: ${n.warnings.join("; ")}`;
      emit({ ...base, phase: "decision", candidate: ev.score, comparable, tasteOverlap: tastes, accepted: ok, reason, explanation, calls: log.drain(), budget: budget() });
      if (iteration === maxIterations) stopReason = `Reached the ${maxIterations}-iteration cap.`;
    }
    emit({ type: "stop", reason: stopReason, budget: budget() });

    // 5. FINAL -----------------------------------------------------------------
    const fn = new Notes();
    const best = current;
    const bestSlot = slots[best.lineup.slot]!;
    let nextSponsors: NextSponsor[] = [];
    if (qloo.remaining >= 1) {
      const env = await qloo.call("qloo_recommend", {
        target_type: "brand",
        signals: group(best),
        signal_location: bestSlot.input.city,
        explain: true,
        limit: 10,
      });
      if (classify(env).status === "ok") {
        nextSponsors = resultEntities(env)
          .filter((e) => !brandIds.includes(e.entity_id) && typeof e.affinity === "number")
          .slice(0, 5)
          .map((e) => ({
            id: e.entity_id,
            name: e.name,
            affinity: round(e.affinity!),
            drivers: [...explainabilityScores(e).entries()]
              .map(([id, score]) => ({ id, name: id === bestSlot.entity?.id ? bestSlot.entity.name : actName(id), score: round(score) }))
              .sort((a, b) => b.score - a.score),
          }));
      }
    }
    let finalTasteShift: TasteOverlap | undefined;
    if (best.key !== draft.key) {
      finalTasteShift = tasteShifts.get(`${draft.key}>${best.key}`);
      if (!finalTasteShift && qloo.remaining >= 1) finalTasteShift = await compareTastes(qloo, fn, group(draft), group(best));
    }
    const members = best.lineup.acts.map((id) => acts.find((a) => a.entity.id === id)!).filter(Boolean);
    const cohesionPairs: OptimizeResult["cohesionPairs"] = [];
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const o = tagOverlap(members[i]!.tags, members[j]!.tags);
        cohesionPairs.push({ a: members[i]!.entity.name, b: members[j]!.entity.name, overlap: o.overlap, shared: o.shared.slice(0, 3) });
      }
    }
    log.drain();
    const result: OptimizeResult = {
      input,
      mode: { qloo: qloo.mode, proposer: deps.llm.enabled && deps.llm.apiKey ? "nemotron" : "heuristic", model: deps.llm.enabled ? deps.llm.model : undefined },
      brands,
      acts,
      slots,
      draft,
      best,
      history,
      acceptedMoves: accepted,
      finalTasteShift,
      nextSponsors,
      cohesionPairs,
      stopReason,
      budget: budget(),
      choices: allChoices,
    };
    emit({ type: "result", result });
    return result;
  } catch (error) {
    const message =
      error instanceof OptimizerError
        ? error.message
        : error instanceof QlooAuthError
          ? `Qloo rejected the credential, so the agent stopped and will not call Qloo again for five minutes. ${error.message}`
          : error instanceof Error
            ? error.message
            : "Unexpected error";
    emit({ type: "error", message });
    throw error;
  }
}

/**
 * Confirms a move's fit gain on one comparable Qloo scale: the setup qloo_rank
 * call that scored all candidate acts (option_type artist) or all venues
 * (option_type place) against the target brands together. A move whose
 * per-lineup fit rose is rejected if, in that one call, the incoming act or
 * venue scored clearly below the one it replaces. Moves that win on cohesion
 * or momentum alone (fit not up) need no fit confirmation.
 */
export const COMPARABLE_TOLERANCE = 0.02;

export function comparableCheck(move: Move, before: LineupScore, after: LineupScore, acts: ActProfile[], slots: SlotProfile[]): ComparableCheck {
  const fitUp = after.parts.fit > before.parts.fit;
  let outName: string | undefined;
  let inName: string | undefined;
  let outAffinity: number | undefined;
  let inAffinity: number | undefined;
  let kind: ComparableCheck["kind"];
  if (move.kind === "swap") {
    const o = acts.find((a) => a.entity.id === move.out);
    const i = acts.find((a) => a.entity.id === move.in);
    kind = "acts";
    outName = o?.entity.name;
    inName = i?.entity.name;
    outAffinity = o?.brandAffinity;
    inAffinity = i?.brandAffinity;
  } else {
    const o = slots[before.lineup.slot];
    const i = slots[move.to];
    kind = "venues";
    outName = o?.entity?.name ?? o?.input.venue;
    inName = i?.entity?.name ?? i?.input.venue;
    outAffinity = o?.brandAffinity;
    inAffinity = i?.brandAffinity;
  }
  if (outAffinity === undefined || inAffinity === undefined) {
    return { kind: "none", outName, inName, contradicts: false, note: `no comparable ${kind === "acts" ? "act" : "venue"} scores, so the per-lineup qloo_rank decides.` };
  }
  const base = { kind, outName, inName, outAffinity, inAffinity };
  const scale = `in one qloo_rank call ${inName} scores ${inAffinity.toFixed(2)} vs. ${outName} ${outAffinity.toFixed(2)} for these brands`;
  if (!fitUp) return { ...base, contradicts: false, note: `the gain comes from cohesion/momentum, not fit (${scale}).` };
  if (inAffinity < outAffinity - COMPARABLE_TOLERANCE) return { ...base, contradicts: true, note: `${scale}, so the fit gain is not confirmed.` };
  return { ...base, contradicts: false, note: `comparable check agrees (${scale}).` };
}

/** "Swap X for Y: fit with Z rises 18% (0.62 -> 0.73) ..." from Qloo numbers only. */
export function explainMove(moveText: string, before: LineupScore, after: LineupScore, tastes: TasteOverlap | undefined, primaryName: string): string {
  const parts: string[] = [];
  const b0 = before.brands.find((b) => b.name === primaryName);
  const b1 = after.brands.find((b) => b.name === primaryName);
  if (b0 && b1) {
    const pct = pctChange(b0.affinity, b1.affinity);
    parts.push(`fit with ${primaryName} ${pct >= 0 ? "rises" : "falls"} ${Math.abs(pct)}% (${b0.affinity.toFixed(2)} -> ${b1.affinity.toFixed(2)})`);
  }
  for (const b of after.brands) {
    if (b.name === primaryName) continue;
    const prev = before.brands.find((x) => x.id === b.id);
    if (prev && Math.abs(pctChange(prev.affinity, b.affinity)) >= 5) {
      const pct = pctChange(prev.affinity, b.affinity);
      parts.push(`${b.name} ${pct >= 0 ? "+" : ""}${pct}%`);
    }
  }
  const dc = before.parts.cohesion !== undefined && after.parts.cohesion !== undefined ? after.parts.cohesion - before.parts.cohesion : 0;
  if (Math.abs(dc) >= 0.01) parts.push(`bill cohesion ${dc > 0 ? "up" : "down"} ${Math.abs(dc).toFixed(2)}`);
  const dm = before.parts.momentum !== undefined && after.parts.momentum !== undefined ? after.parts.momentum - before.parts.momentum : 0;
  if (Math.abs(dm) >= 0.01) parts.push(`momentum ${dm > 0 ? "up" : "down"} ${Math.abs(dm).toFixed(2)}`);
  let text = `${moveText}: ${parts.join(", ") || "objective rises"}; objective ${before.objective} -> ${after.objective}.`;
  if (tastes?.layout === "parsed") {
    if (tastes.onlyB.length) text += ` New tastes in the audience: ${tastes.onlyB.slice(0, 3).map((t) => t.name).join(", ")}.`;
    if (tastes.meanScore !== undefined) text += ` Shared-taste similarity with the previous bill ${tastes.meanScore.toFixed(2)}.`;
  }
  return text;
}
