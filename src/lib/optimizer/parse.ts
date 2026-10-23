import { resultEntities } from "@/lib/qloo/normalize";
import type { QlooEnvelope } from "@/lib/qloo/types";
import { momentumFromPoints, round } from "./scoring";
import type { CompareRow, HeadToHead, Momentum } from "./types";

// Readers for the two harness tools whose result layout is passed through
// from Qloo and not fixed by the harness: qloo_compare_audiences (raw
// /v2/analysis/compare `results`) and qloo_trends (`series[].points[]`, raw
// /v2/trending rows). Both readers are defensive and say when they cannot
// read a layout instead of guessing numbers.

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (isRecord(v) && typeof v.affinity === "number" && Number.isFinite(v.affinity)) return v.affinity;
  return undefined;
}

function first(rec: Record<string, unknown>, paths: string[][]): number | undefined {
  for (const path of paths) {
    let cur: unknown = rec;
    for (const key of path) cur = isRecord(cur) ? cur[key] : undefined;
    const n = num(cur);
    if (n !== undefined) return n;
  }
  return undefined;
}

const A_PATHS = [["query", "a"], ["a"], ["group_a"], ["query", "group_a"], ["affinity_a"], ["query", "affinity_a"], ["query", "affinity", "a"]];
const B_PATHS = [["query", "b"], ["b"], ["group_b"], ["query", "group_b"], ["affinity_b"], ["query", "affinity_b"], ["query", "affinity", "b"]];
const DELTA_PATHS = [["query", "delta"], ["delta"], ["query", "affinity_delta"], ["affinity_delta"], ["query", "difference"], ["difference"]];

/** The rows of a compare result: an array, or the first array inside a results object. */
function compareRows(results: unknown): unknown[] {
  if (Array.isArray(results)) return results;
  if (!isRecord(results)) return [];
  for (const key of ["entities", "tags", "results", "comparison", "items"]) if (Array.isArray(results[key])) return results[key] as unknown[];
  for (const v of Object.values(results)) if (Array.isArray(v)) return v;
  return [];
}

export function parseCompareRows(results: unknown): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const raw of compareRows(results)) {
    if (!isRecord(raw)) continue;
    const id = [raw.entity_id, raw.tag_id, raw.id].find((v): v is string => typeof v === "string");
    const name = typeof raw.name === "string" ? raw.name : undefined;
    if (!id || !name) continue;
    const a = first(raw, A_PATHS);
    const b = first(raw, B_PATHS);
    // With both sides present, compute b - a ourselves; a delta-only layout is
    // read as b - a (sign convention to confirm against the live API).
    const delta = a !== undefined && b !== undefined ? round(b - a) : first(raw, DELTA_PATHS);
    rows.push({ id, name, ...(a !== undefined ? { a: round(a) } : {}), ...(b !== undefined ? { b: round(b) } : {}), ...(delta !== undefined ? { delta: round(delta) } : {}) });
  }
  return rows;
}

/**
 * Turns a qloo_compare_audiences envelope (group A = current, group B =
 * proposed) into head-to-head evidence for the target brands.
 */
export function headToHead(env: QlooEnvelope | undefined, targetIds: string[]): HeadToHead {
  if (!env || (env.status !== "ok" && env.status !== "partial" && env.status !== "degraded")) {
    return { layout: "unavailable", rows: [], targetsFound: [], topGainers: [], note: env ? `compare_audiences ${env.status}${env.summary ? `: ${env.summary}` : ""}` : "not run" };
  }
  const rows = parseCompareRows(env.results);
  const withDelta = rows.filter((r) => r.delta !== undefined);
  if (!withDelta.length) {
    const keys = isRecord(env.results) ? Object.keys(env.results).join(", ") : Array.isArray(env.results) ? `array of ${env.results.length}` : typeof env.results;
    return { layout: "unrecognized", rows, targetsFound: [], topGainers: [], note: `compare_audiences answered, but its layout was not recognized (results: ${keys}).`, evidenceId: env.execution?.correlation_id };
  }
  const targets = withDelta.filter((r) => targetIds.includes(r.id));
  const targetLean = targets.length ? round(targets.reduce((s, r) => s + r.delta!, 0) / targets.length) : undefined;
  return {
    layout: "parsed",
    rows: withDelta,
    targetLean,
    targetsFound: targets.map((t) => t.id),
    topGainers: [...withDelta].sort((x, y) => y.delta! - x.delta!).filter((r) => r.delta! > 0).slice(0, 3),
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
