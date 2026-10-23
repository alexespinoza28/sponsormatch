import type { ActProfile, BrandScore, Goal, Lineup, LineupScore, Momentum, ObjectiveParts, TagAffinity } from "./types";

// Pure scoring math. Inputs are Qloo tool results (already parsed); outputs
// are documented blends of them. No I/O and no model output here.

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
}

/** Objective weights per producer goal. Missing parts are dropped and the rest renormalized. */
export const GOAL_WEIGHTS: Record<Goal, { fit: number; cohesion: number; momentum: number }> = {
  sponsor_fit: { fit: 0.7, cohesion: 0.15, momentum: 0.15 },
  momentum: { fit: 0.4, cohesion: 0.15, momentum: 0.45 },
  cohesion: { fit: 0.45, cohesion: 0.4, momentum: 0.15 },
};

export const GOAL_LABELS: Record<Goal, string> = {
  sponsor_fit: "Sponsor fit",
  momentum: "Momentum",
  cohesion: "Cohesive bill",
};

/**
 * Brand fit of one lineup: weighted mean of the target brands' qloo_rank
 * affinities. The primary target (first) counts double.
 */
export function brandFit(brands: BrandScore[], primaryId?: string): number {
  if (!brands.length) return 0;
  let total = 0;
  let weight = 0;
  for (const b of brands) {
    const w = b.id === primaryId ? 2 : 1;
    total += w * clamp(b.affinity, 0, 1);
    weight += w;
  }
  return round(total / weight);
}

/**
 * Weighted Jaccard overlap of two qloo_entity_tags profiles:
 * sum(min) / sum(max) over the union of tags (a missing tag counts as 0). 0..1.
 */
export function tagOverlap(a: TagAffinity[], b: TagAffinity[]): { overlap: number; shared: string[] } {
  if (!a.length || !b.length) return { overlap: 0, shared: [] };
  const ma = new Map(a.map((t) => [t.id, t]));
  const mb = new Map(b.map((t) => [t.id, t]));
  let num = 0;
  let den = 0;
  const shared: Array<{ name: string; w: number }> = [];
  for (const id of new Set([...ma.keys(), ...mb.keys()])) {
    const x = clamp(ma.get(id)?.affinity ?? 0, 0, 1);
    const y = clamp(mb.get(id)?.affinity ?? 0, 0, 1);
    num += Math.min(x, y);
    den += Math.max(x, y);
    if (x > 0 && y > 0) shared.push({ name: (ma.get(id) ?? mb.get(id))!.name, w: Math.min(x, y) });
  }
  return { overlap: den === 0 ? 0 : round(num / den), shared: shared.sort((p, q) => q.w - p.w).map((s) => s.name) };
}

/** Mean pairwise tag overlap of the acts on a bill, or undefined if fewer than two acts have tags. */
export function cohesion(acts: ActProfile[]): number | undefined {
  const withTags = acts.filter((a) => a.tags.length);
  if (withTags.length < 2) return undefined;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < withTags.length; i += 1) {
    for (let j = i + 1; j < withTags.length; j += 1) {
      sum += tagOverlap(withTags[i]!.tags, withTags[j]!.tags).overlap;
      n += 1;
    }
  }
  return round(sum / n);
}

/**
 * Mean act momentum mapped from [-1, 1] to [0, 1]. With `neutralMissing`
 * (some candidate act has trend data), an act without trend points counts as
 * flat (0) so a swap is neither helped nor blocked by missing data; otherwise
 * undefined when no act on the bill has a trend.
 */
export function lineupMomentum(acts: ActProfile[], neutralMissing = false): number | undefined {
  const values = acts.flatMap((a) => (a.momentum ? [a.momentum.value] : neutralMissing ? [0] : []));
  if (!values.length || (!neutralMissing && !acts.some((a) => a.momentum))) return undefined;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return round((clamp(mean, -1, 1) + 1) / 2);
}

/** Objective on 0-100: goal-weighted blend of the parts present. */
export function objective(parts: ObjectiveParts, goal: Goal): number {
  const w = GOAL_WEIGHTS[goal];
  const comps: Array<[number, number]> = [[w.fit, clamp(parts.fit, 0, 1)]];
  if (parts.cohesion !== undefined) comps.push([w.cohesion, clamp(parts.cohesion, 0, 1)]);
  if (parts.momentum !== undefined) comps.push([w.momentum, clamp(parts.momentum, 0, 1)]);
  const total = comps.reduce((s, [x]) => s + x, 0);
  return round((comps.reduce((s, [x, v]) => s + x * v, 0) / total) * 100, 1);
}

export function lineupKey(lineup: Lineup): string {
  return `${[...lineup.acts].sort().join("+")}@${lineup.slot}`;
}

/** Percent change from before to after, rounded to a whole number. */
export function pctChange(before: number, after: number): number {
  if (before === 0) return 0;
  return Math.round(((after - before) / Math.abs(before)) * 100);
}

/**
 * Momentum from a qloo_trends series (live points: date,
 * population_percentile 0..1, population_rank as a string, velocities; newest
 * first). Sorts by date, uses population_percentile when present, else
 * population_rank (lower is better, so the sign flips). Compares the mean of
 * the first and last third of the window to smooth weekly noise. Returns
 * undefined with fewer than 2 points (e.g. the empty series Qloo returns for
 * recent windows).
 */
const TREND_FIELDS: Array<{ key: string; lowerIsBetter: boolean }> = [
  { key: "population_percentile", lowerIsBetter: false },
  { key: "popularity", lowerIsBetter: false },
  { key: "population_rank", lowerIsBetter: true },
  { key: "rank", lowerIsBetter: true },
  { key: "value", lowerIsBetter: false },
  { key: "score", lowerIsBetter: false },
];

function numberAt(point: unknown, key: string): number | undefined {
  if (!point || typeof point !== "object") return undefined;
  const p = point as Record<string, unknown>;
  const v = p[key] ?? (p.query && typeof p.query === "object" ? (p.query as Record<string, unknown>)[key] : undefined);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // The live API returns population_rank as a string.
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

export function momentumFromPoints(points: unknown[]): Momentum | undefined {
  if (points.length < 2) return undefined;
  const sorted = [...points].sort((x, y) => String((x as { date?: string })?.date ?? "").localeCompare(String((y as { date?: string })?.date ?? "")));
  for (const field of TREND_FIELDS) {
    const values = sorted.map((p) => numberAt(p, field.key)).filter((v): v is number => v !== undefined);
    if (values.length < 2) continue;
    const third = Math.max(1, Math.floor(values.length / 3));
    const first = values.slice(0, third).reduce((s, v) => s + v, 0) / third;
    const last = values.slice(-third).reduce((s, v) => s + v, 0) / third;
    if (first === 0) continue;
    const raw = field.lowerIsBetter ? (first - last) / Math.abs(first) : (last - first) / Math.abs(first);
    return { value: round(clamp(raw, -1, 1)), metric: field.key, first: round(first), last: round(last), points: values.length };
  }
  return undefined;
}

/** Scores one evaluated lineup from its qloo_rank brand affinities plus cached act evidence. */
export function scoreLineup(args: {
  lineup: Lineup;
  brands: BrandScore[];
  acts: ActProfile[];
  goal: Goal;
  primaryId?: string;
  evidenceId: string;
}): LineupScore {
  const members = args.lineup.acts.map((id) => args.acts.find((a) => a.entity.id === id)).filter((a): a is ActProfile => !!a);
  const neutral = args.acts.some((a) => a.momentum);
  const parts: ObjectiveParts = { fit: brandFit(args.brands, args.primaryId), cohesion: cohesion(members), momentum: lineupMomentum(members, neutral) };
  return {
    key: lineupKey(args.lineup),
    lineup: args.lineup,
    brands: args.brands,
    parts,
    objective: objective(parts, args.goal),
    evidenceId: args.evidenceId,
  };
}

/**
 * Cheap prior for a lineup from setup evidence only (no new Qloo call), used
 * to order proposals: act-level brand affinity (one comparable qloo_rank call)
 * stands in for fit, blended with the venue's brand affinity when known.
 */
export function priorObjective(args: { lineup: Lineup; acts: ActProfile[]; slotAffinity?: number; goal: Goal }): number {
  const members = args.lineup.acts.map((id) => args.acts.find((a) => a.entity.id === id)).filter((a): a is ActProfile => !!a);
  const vals = members.flatMap((m) => (m.brandAffinity !== undefined ? [m.brandAffinity] : []));
  const actPart = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  const fit = args.slotAffinity !== undefined ? 0.8 * actPart + 0.2 * args.slotAffinity : actPart;
  return objective({ fit, cohesion: cohesion(members), momentum: lineupMomentum(members, args.acts.some((a) => a.momentum)) }, args.goal);
}
