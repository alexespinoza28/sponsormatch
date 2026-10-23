import { resultEntities } from "@/lib/qloo/normalize";
import type { QlooEnvelope } from "@/lib/qloo/types";
import { momentumFromPoints, round } from "./scoring";
import type { Momentum, TasteOverlap, TasteTag } from "./types";

// Readers for the two harness tools whose result layout the harness passes
// through from Qloo: qloo_compare_audiences (raw /v2/analysis/compare
// `results`) and qloo_trends (`series[].points[]`, raw /v2/trending rows).
// Layouts as seen in the Oct 22 live probe; both readers say when they cannot
// read a layout instead of guessing numbers.

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function tagRows(rows: unknown, field: "score" | "count"): TasteTag[] {
  if (!Array.isArray(rows)) return [];
  const out: TasteTag[] = [];
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const id = [r.tag_id, r.id, r.entity_id].find((v): v is string => typeof v === "string");
    if (!id || typeof r.name !== "string") continue;
    const v = num(isRecord(r.query) ? r.query[field] : undefined) ?? num(r[field]);
    out.push({ id, name: r.name, ...(v !== undefined ? { [field]: field === "score" ? round(v) : v } : {}) });
  }
  return out;
}

/**
 * qloo_compare_audiences (group A vs. group B) -> taste overlap.
 * Live layout: results = {tags: [{tag_id, name, query: {score}}], a: [...],
 * b: [...] (query.count), matchEntities: []}. target_type "brand" does not
 * add brand rows, so this is taste evidence, not brand fit.
 */
export function tasteOverlap(env: QlooEnvelope | undefined): TasteOverlap {
  const empty = { shared: [], onlyA: [], onlyB: [] };
  if (!env || (env.status !== "ok" && env.status !== "partial" && env.status !== "degraded")) {
    return { layout: "unavailable", ...empty, note: env ? `compare_audiences ${env.status}${env.summary ? `: ${env.summary}` : ""}` : "not run" };
  }
  const res = env.results;
  const shared = isRecord(res) ? tagRows(res.tags, "score").filter((t) => t.score !== undefined) : [];
  if (!isRecord(res) || !shared.length) {
    const keys = isRecord(res) ? Object.keys(res).join(", ") : Array.isArray(res) ? `array of ${res.length}` : typeof res;
    return { layout: "unrecognized", ...empty, note: `compare_audiences answered, but its layout was not recognized (results: ${keys}).`, evidenceId: env.execution?.correlation_id };
  }
  const a = tagRows(res.a, "count");
  const b = tagRows(res.b, "count");
  const sharedIds = new Set(shared.map((t) => t.id));
  const aIds = new Set(a.map((t) => t.id));
  const bIds = new Set(b.map((t) => t.id));
  return {
    layout: "parsed",
    shared: [...shared].sort((x, y) => y.score! - x.score!),
    onlyA: a.filter((t) => !sharedIds.has(t.id) && !bIds.has(t.id)),
    onlyB: b.filter((t) => !sharedIds.has(t.id) && !aIds.has(t.id)),
    meanScore: round(shared.reduce((s, t) => s + t.score!, 0) / shared.length),
    evidenceId: env.execution?.correlation_id,
  };
}

/** qloo_trends envelope -> momentum per entity ID. */
export function parseTrends(env: QlooEnvelope): Map<string, Momentum> {
  const out = new Map<string, Momentum>();
  const series = Array.isArray(env.series) ? env.series : Array.isArray(env.results) ? env.results : [];
  for (const s of series) {
    if (!isRecord(s)) continue;
    const entity = isRecord(s.entity) ? s.entity : undefined;
    const id = typeof entity?.entityId === "string" ? entity.entityId : typeof entity?.entity_id === "string" ? entity.entity_id : undefined;
    if (!id || !Array.isArray(s.points)) continue;
    const m = momentumFromPoints(s.points);
    if (m) out.set(id, m);
  }
  return out;
}

/** qloo_rank results -> affinity by entity ID, plus input -> ID from the interpretation. */
export function rankAffinities(env: QlooEnvelope): { byId: Map<string, number>; inputs: Map<string, { id: string; name: string; match: string }> } {
  const byId = new Map<string, number>();
  for (const e of resultEntities(env)) if (typeof e.affinity === "number" && Number.isFinite(e.affinity)) byId.set(e.entity_id, round(e.affinity));
  const inputs = new Map<string, { id: string; name: string; match: string }>();
  const options = isRecord(env.interpretation) ? env.interpretation.options : undefined;
  if (Array.isArray(options)) {
    for (const o of options) {
      if (isRecord(o) && typeof o.input === "string" && typeof o.entityId === "string") {
        inputs.set(o.input, { id: o.entityId, name: typeof o.name === "string" ? o.name : o.input, match: typeof o.match === "string" ? o.match : "resolved" });
      }
    }
  }
  return { byId, inputs };
}
