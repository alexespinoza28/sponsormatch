import { chatCompletion, type ChatMessage } from "@/lib/llm/nemotron";
import { GOAL_LABELS, lineupKey, priorObjective } from "./scoring";
import type { ActProfile, Goal, Lineup, LineupScore, Move, ResolvedEntity, SlotProfile } from "./types";

// Who picks the next change to test. Nemotron proposes (and may decide to
// stop) when NVIDIA_API_KEY is set; otherwise, or when its reply is unusable,
// a deterministic heuristic does. Either way the proposer only picks a move:
// the move is scored by Qloo, and the accept/reject decision is made in code
// from Qloo results (search.ts). Nothing the model writes becomes a score.

export interface ProposalContext {
  acts: ActProfile[];
  slots: SlotProfile[];
  brands: ResolvedEntity[];
  goal: Goal;
  current: LineupScore;
  /** Lineup keys already evaluated (never re-proposed). */
  tried: Set<string>;
  history: Array<{ iteration: number; moveText: string; accepted: boolean; before: number; after?: number; reason: string }>;
  remaining: number;
  iteration: number;
  consecutiveRejects: number;
}

export interface Proposal {
  move?: Move;
  stop?: string;
  proposer: "nemotron" | "heuristic";
  rationale?: string;
  note?: string;
}

export function applyMove(lineup: Lineup, move: Move): Lineup {
  if (move.kind === "slot") return { acts: [...lineup.acts], slot: move.to };
  return { acts: lineup.acts.map((id) => (id === move.out ? move.in : id)), slot: lineup.slot };
}

function available(act: ActProfile | undefined, slot: SlotProfile | undefined): boolean {
  return !!act && !(slot?.input.date && act.input.unavailable.includes(slot.input.date));
}

/** Every legal move from the current lineup whose result has not been evaluated yet. */
export function legalMoves(ctx: Pick<ProposalContext, "acts" | "slots" | "current" | "tried">): Array<{ move: Move; lineup: Lineup }> {
  const cur = ctx.current.lineup;
  const slot = ctx.slots[cur.slot];
  const out: Array<{ move: Move; lineup: Lineup }> = [];
  const bench = ctx.acts.filter((a) => !cur.acts.includes(a.entity.id) && available(a, slot));
  for (const outId of cur.acts) {
    for (const b of bench) {
      const move: Move = { kind: "swap", out: outId, in: b.entity.id };
      const lineup = applyMove(cur, move);
      if (!ctx.tried.has(lineupKey(lineup))) out.push({ move, lineup });
    }
  }
  ctx.slots.forEach((s, i) => {
    if (i === cur.slot) return;
    if (!cur.acts.every((id) => available(ctx.acts.find((a) => a.entity.id === id), s))) return;
    const move: Move = { kind: "slot", to: i };
    const lineup = applyMove(cur, move);
    if (!ctx.tried.has(lineupKey(lineup))) out.push({ move, lineup });
  });
  return out;
}

export function describeMove(move: Move, acts: ActProfile[], slots: SlotProfile[]): string {
  const name = (id: string) => acts.find((a) => a.entity.id === id)?.entity.name ?? id;
  return move.kind === "swap" ? `Swap ${name(move.out)} for ${name(move.in)}` : `Move to ${slots[move.to]?.label ?? `slot ${move.to + 1}`}`;
}

/** Legal moves ordered by a prior computed only from setup Qloo evidence. */
export function rankMovesByPrior(ctx: ProposalContext): Array<{ move: Move; lineup: Lineup; prior: number }> {
  return legalMoves(ctx)
    .map((m) => ({ ...m, prior: priorObjective({ lineup: m.lineup, acts: ctx.acts, slotAffinity: ctx.slots[m.lineup.slot]?.brandAffinity, goal: ctx.goal }) }))
    .sort((a, b) => b.prior - a.prior);
}

export const HEURISTIC_MAX_REJECTS = 3;
/** Hard stop for any proposer, including Nemotron. */
export const MAX_CONSECUTIVE_REJECTS = 4;

export function heuristicPropose(ctx: ProposalContext): Proposal {
  const ranked = rankMovesByPrior(ctx);
  if (!ranked.length) return { proposer: "heuristic", stop: "No untried legal moves remain." };
  if (ctx.consecutiveRejects >= HEURISTIC_MAX_REJECTS) {
    return { proposer: "heuristic", stop: `${ctx.consecutiveRejects} proposals in a row were rejected by Qloo evidence; the current lineup looks locally best.` };
  }
  const currentPrior = priorObjective({ lineup: ctx.current.lineup, acts: ctx.acts, slotAffinity: ctx.slots[ctx.current.lineup.slot]?.brandAffinity, goal: ctx.goal });
  const best = ranked[0]!;
  if (best.prior < currentPrior - 2 && ctx.iteration > 1) {
    return { proposer: "heuristic", stop: "No untried move looks promising from the act-level Qloo evidence." };
  }
  return { proposer: "heuristic", move: best.move, rationale: "Highest prior from act-level Qloo evidence (brand affinity, tag overlap, momentum) among untried moves." };
}

// --- Nemotron proposer ------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are the planning step of a lineup-optimization agent for a live-event producer.",
  "Each turn you choose ONE change to test next, or decide to stop. A separate system measures every change with Qloo taste-graph data and accepts or rejects it; you never produce scores.",
  "Use the state JSON: the producer's goal, the target sponsor brands, the current bill, bench acts with their Qloo evidence, venue/date slots, and the history of tested moves.",
  "Prefer changes that the evidence suggests will raise the goal. Do not repeat a tested lineup. Respect act unavailability dates.",
  "Stop when the remaining options look unlikely to beat the current lineup, or after repeated rejections, or when the budget is nearly spent.",
  'Reply with JSON only, no prose, in one of these forms: {"action":"swap","out":"<act on the bill>","in":"<bench act>","why":"<one short sentence>"} | {"action":"slot","to":"<slot label>","why":"<one short sentence>"} | {"action":"stop","why":"<one short sentence>"}.',
  "Do not put numbers in why.",
].join(" ");

export function buildProposalMessages(ctx: ProposalContext): ChatMessage[] {
  const cur = ctx.current.lineup;
  const actView = (a: ActProfile) => ({
    name: a.entity.name,
    brand_affinity: a.brandAffinity,
    momentum: a.momentum?.value,
    top_tags: a.tags.slice(0, 4).map((t) => t.name),
    unavailable: a.input.unavailable.length ? a.input.unavailable : undefined,
  });
  const state = {
    goal: GOAL_LABELS[ctx.goal],
    target_brands: ctx.brands.map((b) => b.name),
    current: {
      bill: cur.acts.map((id) => ctx.acts.find((a) => a.entity.id === id)).filter(Boolean).map((a) => actView(a!)),
      slot: ctx.slots[cur.slot]?.label,
      objective: ctx.current.objective,
      parts: ctx.current.parts,
      brand_affinity: ctx.current.brands.map((b) => ({ brand: b.name, affinity: b.affinity })),
    },
    bench: ctx.acts.filter((a) => !cur.acts.includes(a.entity.id)).map(actView),
    slots: ctx.slots.map((s) => ({ label: s.label, venue_brand_affinity: s.brandAffinity })),
    history: ctx.history.slice(-8).map((h) => ({ move: h.moveText, accepted: h.accepted, objective_before: h.before, objective_after: h.after, reason: h.reason })),
    suggestions_from_prior: rankMovesByPrior(ctx)
      .slice(0, 5)
      .map((m) => describeMove(m.move, ctx.acts, ctx.slots)),
    qloo_calls_left: ctx.remaining,
  };
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `STATE:\n${JSON.stringify(state)}\n\nChoose the next move.` },
  ];
}

/** Extracts the first JSON object from a model reply. */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Maps a parsed model reply to a legal move, or explains why it cannot. */
export function interpretReply(reply: Record<string, unknown> | undefined, ctx: ProposalContext): { move?: Move; stop?: string; why?: string; error?: string } {
  if (!reply) return { error: "reply was not JSON" };
  const why = typeof reply.why === "string" ? reply.why.trim().slice(0, 200) : undefined;
  const action = norm(reply.action);
  if (action === "stop") return { stop: why || "Nemotron decided to stop.", why };
  const legal = legalMoves(ctx);
  const byName = (name: unknown) => ctx.acts.find((a) => norm(a.entity.name) === norm(name) || norm(a.input.name) === norm(name));
  if (action === "swap") {
    const out = byName(reply.out);
    const inn = byName(reply.in);
    if (!out || !inn) return { error: `unknown act in swap (${String(reply.out)} / ${String(reply.in)})` };
    const hit = legal.find((m) => m.move.kind === "swap" && m.move.out === out.entity.id && m.move.in === inn.entity.id);
    return hit ? { move: hit.move, why } : { error: `swap ${out.entity.name} for ${inn.entity.name} is not legal or was already tested` };
  }
  if (action === "slot" || action === "venue") {
    const to = ctx.slots.findIndex((s) => norm(s.label) === norm(reply.to) || norm(s.input.venue) === norm(reply.to));
    const hit = legal.find((m) => m.move.kind === "slot" && m.move.to === to);
    return hit ? { move: hit.move, why } : { error: `slot "${String(reply.to)}" is not legal or was already tested` };
  }
  return { error: `unknown action "${String(reply.action)}"` };
}

export async function nemotronPropose(ctx: ProposalContext, options: { apiKey: string; model: string; fetch?: typeof fetch }): Promise<Proposal> {
  let reply: Record<string, unknown> | undefined;
  try {
    const text = await chatCompletion({ apiKey: options.apiKey, model: options.model, messages: buildProposalMessages(ctx), maxTokens: 200, temperature: 0.2, fetch: options.fetch, timeoutMs: 20_000 });
    reply = extractJson(text);
  } catch (error) {
    return { ...heuristicPropose(ctx), note: `Nemotron unavailable (${error instanceof Error ? error.message : "error"}); heuristic proposal used.` };
  }
  const r = interpretReply(reply, ctx);
  // Model text is shown as a rationale only, and only if it cites no numbers.
  const rationale = r.why && !/\d/.test(r.why) ? r.why : undefined;
  const dropped = r.why && !rationale ? " (rationale hidden: it cited numbers)" : "";
  if (r.stop) {
    if (ctx.history.length === 0) {
      return { ...heuristicPropose(ctx), note: "Nemotron wanted to stop before testing any move; heuristic proposal used." };
    }
    return { proposer: "nemotron", stop: rationale ?? "Nemotron decided to stop.", note: dropped || undefined };
  }
  if (r.move) return { proposer: "nemotron", move: r.move, rationale, note: dropped || undefined };
  return { ...heuristicPropose(ctx), note: `Nemotron's reply was unusable (${r.error}); heuristic proposal used.` };
}
