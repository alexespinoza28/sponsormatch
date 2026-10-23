import type { QlooTools } from "@/lib/qloo/types";
import { CallLog, QlooAuthError } from "./budget";
import { compareGroups, describeEntity, momentum, Notes, rankOptions, trendWindow } from "./qloo-steps";
import { round } from "./scoring";
import type { RankedEvent, SponsorEvent, SponsorInput, SponsorResult } from "./types";

// Sponsor side: "I'm a brand with $10K: which of these events over-index for
// my audience?" Qloo has no event listings, so the brand pastes the events it
// is considering (or uses the sample list). The ranking flips the producer
// view: the brand is the signal, and every act and venue across all events is
// ranked against it in as few qloo_rank calls as possible, so scores share one
// scale.

/** Hard cap on Qloo tool calls for one sponsor-side run (a typical run uses 5 or 6). */
export const SPONSOR_CALL_CAP = 12;

export const EVENT_WEIGHTS = { acts: 0.75, venue: 0.25 } as const;

/** Event score from act and venue affinities (renormalized when the venue is missing). */
export function eventScore(actAffinities: number[], venueAffinity?: number): { score: number; actAffinity?: number } {
  if (!actAffinities.length && venueAffinity === undefined) return { score: 0 };
  const actAffinity = actAffinities.length ? actAffinities.reduce((s, v) => s + v, 0) / actAffinities.length : undefined;
  const parts: Array<[number, number]> = [];
  if (actAffinity !== undefined) parts.push([EVENT_WEIGHTS.acts, actAffinity]);
  if (venueAffinity !== undefined) parts.push([EVENT_WEIGHTS.venue, venueAffinity]);
  const w = parts.reduce((s, [x]) => s + x, 0);
  return { score: round(parts.reduce((s, [x, v]) => s + x * v, 0) / w), actAffinity: actAffinity === undefined ? undefined : round(actAffinity) };
}

/** Ranks events; index 100 = mean score of the pasted list. Within-budget events come first. */
export function rankEvents(events: Array<Omit<RankedEvent, "rank" | "index" | "withinBudget">>, budgetUsd?: number): RankedEvent[] {
  const scored = events.filter((e) => e.score > 0);
  const mean = scored.length ? scored.reduce((s, e) => s + e.score, 0) / scored.length : 0;
  const ranked = events.map((e) => ({
    ...e,
    rank: 0,
    index: mean > 0 && e.score > 0 ? Math.round((e.score / mean) * 100) : 0,
    withinBudget: budgetUsd === undefined || e.listing.askUsd === undefined ? undefined : e.listing.askUsd <= budgetUsd,
  }));
  ranked.sort((a, b) => Number(b.withinBudget !== false) - Number(a.withinBudget !== false) || b.score - a.score);
  ranked.forEach((e, i) => (e.rank = i + 1));
  return ranked;
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

export async function runSponsorRanking(
  input: SponsorInput,
  deps: { qloo: QlooTools; log: CallLog; emit: (e: SponsorEvent) => void; now?: Date },
): Promise<SponsorResult> {
  const { qloo, log, emit } = deps;
  const pins = input.pins ?? {};
  const choices: SponsorResult["choices"] = [];
  const allNotes: string[] = [];
  const step = (name: string) => {
    emit({ type: "step", step: name, status: "running" });
    return new Notes();
  };
  const done = (name: string, summary: string, n: Notes, status: "done" | "error" = "done") => {
    const t = n.take();
    if (t.choices) choices.push(...t.choices);
    allNotes.push(...t.notes);
    emit({ type: "step", step: name, status, summary, notes: [...t.notes, ...(t.warnings ?? [])], choices: t.choices, calls: log.drain() });
  };

  try {
    let n = step("Resolve your brand");
    const brand = await describeEntity(qloo, n, input.brand, "brand", "brand", pins);
    if (!brand) {
      done("Resolve your brand", "Brand not found.", n, "error");
      throw new Error(`"${input.brand}" did not match a Qloo brand.`);
    }
    done("Resolve your brand", `${input.brand} -> ${brand.name}.`, n);

    n = step("Rank every act and venue for your audience");
    const actNames = [...new Set(input.events.flatMap((e) => e.acts))];
    const venueNames = [...new Set(input.events.flatMap((e) => (e.venue ? [e.venue] : [])))];
    const actRank = await rankOptions(qloo, n, { options: actNames, optionType: "artist", signals: [brand.id], pins, field: "act", label: "Rank acts" });
    const venueRank = venueNames.length
      ? await rankOptions(qloo, n, {
          options: venueNames,
          optionType: "place",
          signals: [brand.id],
          pins,
          field: "venue",
          label: "Rank venues",
          hints: Object.fromEntries(input.events.flatMap((e) => (e.venue ? [[e.venue, e.city]] : []))),
        })
      : new Map();
    n.notes.push("No location signal: events in different cities are scored on one scale for your brand's audience.");
    done("Rank every act and venue for your audience", `${actRank.size} of ${actNames.length} acts and ${venueRank.size} of ${venueNames.length} venues scored.`, n);

    const scored = input.events.map((listing) => {
      const acts = listing.acts.map((a) => {
        const r = actRank.get(a);
        return { input: a, id: r?.id, name: r?.name ?? a, affinity: r?.affinity };
      });
      const v = listing.venue ? venueRank.get(listing.venue) : undefined;
      const { score, actAffinity } = eventScore(
        acts.flatMap((a) => (a.affinity !== undefined ? [a.affinity] : [])),
        v?.affinity,
      );
      return {
        listing,
        score,
        actAffinity,
        venueAffinity: v?.affinity,
        acts,
        venue: listing.venue ? { input: listing.venue, id: v?.id, name: v?.name ?? listing.venue, affinity: v?.affinity } : undefined,
      };
    });
    const events = rankEvents(scored, input.budgetUsd);

    n = step("Check momentum and shared tastes for the top events");
    const top = events.filter((e) => e.score > 0).slice(0, 3);
    const headliners = [...new Set(top.flatMap((e) => (e.acts.find((a) => a.id)?.id ? [e.acts.find((a) => a.id)!.id!] : [])))].slice(0, 5);
    if (headliners.length) {
      const m = await momentum(qloo, n, headliners, "artist", trendWindow(deps.now ?? new Date()));
      for (const e of events) for (const a of e.acts) if (a.id && m.has(a.id)) Object.assign(a, { momentum: m.get(a.id) });
    }
    let sharedTastes: SponsorResult["sharedTastes"];
    const best = events[0];
    if (best && best.score > 0) {
      const ids = [...best.acts.flatMap((a) => (a.id ? [a.id] : [])), ...(best.venue?.id ? [best.venue.id] : [])];
      if (ids.length) sharedTastes = await compareGroups(qloo, n, [brand.id], ids, []);
    }
    done(
      "Check momentum and shared tastes for the top events",
      sharedTastes?.layout === "parsed" ? `Tastes your audience shares with ${best!.listing.name} found.` : "Momentum checked.",
      n,
    );

    let recommendation: SponsorResult["recommendation"];
    if (best && best.score > 0) {
      const higher = events.filter((e) => e.withinBudget === false && e.score > best.score);
      const lead = best.withinBudget === true ? `Best fit within your ${money(input.budgetUsd!)} budget: ` : "";
      recommendation = {
        eventName: best.listing.name,
        reason:
          `${lead}${best.listing.name} indexes ${best.index} against the events you pasted (100 = average)` +
          `${best.withinBudget === true ? ` and asks ${money(best.listing.askUsd!)}` : ""}. ` +
          `Its lineup's affinity for ${brand.name}'s audience is ${best.actAffinity?.toFixed(2) ?? "n/a"}${best.venueAffinity !== undefined ? ` and the venue's is ${best.venueAffinity.toFixed(2)}` : ""}.` +
          (higher.length ? ` ${higher.map((e) => `${e.listing.name} (index ${e.index})`).join(", ")} scores higher but asks more than your budget.` : ""),
      };
      if (events.every((e) => e.withinBudget === false)) recommendation.reason += " No event fits the budget; this is the best fit regardless.";
    }

    const result: SponsorResult = {
      input,
      mode: { qloo: qloo.mode },
      brand,
      events,
      recommendation,
      sharedTastes,
      toolCallCount: log.total,
      choices,
      notes: allNotes,
    };
    emit({ type: "result", result });
    return result;
  } catch (error) {
    const message =
      error instanceof QlooAuthError
        ? `Qloo rejected the credential, so the agent stopped and will not call Qloo again for five minutes. ${error.message}`
        : error instanceof Error
          ? error.message
          : "Unexpected error";
    emit({ type: "error", message });
    throw error;
  }
}
