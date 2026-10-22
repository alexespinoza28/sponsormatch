import type {
  AgeBucket,
  QlooCandidate,
  QlooDemographicsRow,
  QlooEnvelope,
  QlooResolutionIssue,
  QlooResultEntity,
  QlooResultTag,
} from "./types";
import { AGE_BUCKETS } from "./types";

// Readers for the harness result envelope. Everything is defensive: the
// envelope's `results` and `interpretation` are typed `unknown` in the
// published output schema.

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function resultArray(env: QlooEnvelope): unknown[] {
  return Array.isArray(env.results) ? env.results : [];
}

export function resultEntities(env: QlooEnvelope): QlooResultEntity[] {
  return resultArray(env).filter(
    (r): r is QlooResultEntity => isRecord(r) && typeof r.entity_id === "string" && typeof r.name === "string",
  );
}

export function resultTags(env: QlooEnvelope): QlooResultTag[] {
  return resultArray(env).filter((r): r is QlooResultTag => isRecord(r) && typeof r.id === "string" && typeof r.name === "string");
}

export function resultDemographics(env: QlooEnvelope): QlooDemographicsRow[] {
  return resultArray(env).filter(
    (r): r is QlooDemographicsRow => isRecord(r) && typeof r.entity_id === "string" && isRecord(r.query) && isRecord(r.query.age),
  );
}

export function resolutionIssues(env: QlooEnvelope): QlooResolutionIssue[] {
  const issues = env.resolution?.issues;
  return Array.isArray(issues) ? issues.filter((i): i is QlooResolutionIssue => isRecord(i) && typeof i.input === "string") : [];
}

export function issueCandidates(issue: QlooResolutionIssue): QlooCandidate[] {
  return (issue.candidates ?? []).filter((c) => isRecord(c) && typeof c.id === "string" && typeof c.name === "string");
}

/** describe: the resolved entity from `interpretation.entity`. */
export function interpretedEntity(env: QlooEnvelope): { entityId: string; name: string; type?: string; match?: string } | undefined {
  const entity = isRecord(env.interpretation) ? env.interpretation.entity : undefined;
  if (!isRecord(entity) || typeof entity.entityId !== "string" || typeof entity.name !== "string") return undefined;
  return {
    entityId: entity.entityId,
    name: entity.name,
    type: typeof entity.type === "string" ? entity.type : undefined,
    match: typeof entity.match === "string" ? entity.match : undefined,
  };
}

export function entityDescription(e: QlooResultEntity): string | undefined {
  const v = e.properties?.short_description ?? e.properties?.description;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function entityAddress(e: QlooResultEntity): string | undefined {
  const v = e.properties?.address;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function entityImage(e: QlooResultEntity): string | undefined {
  const v = e.properties?.image?.url;
  return typeof v === "string" ? v : undefined;
}

/**
 * Per-result explainability -> map of input entity id to contribution score.
 * Qloo documents the meaning (normalized 0-1 contribution per input entity) but
 * not the exact layout, so this accepts an array of {entity_id, score} either
 * directly or under "signal.interests.entities", or an {id: score} object.
 */
export function explainabilityScores(e: QlooResultEntity): Map<string, number> {
  const out = new Map<string, number>();
  const x = e.explainability;
  const rows = Array.isArray(x) ? x : isRecord(x) ? x["signal.interests.entities"] : undefined;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (isRecord(row) && typeof row.entity_id === "string" && num(row.score) !== undefined) out.set(row.entity_id, num(row.score)!);
    }
  } else if (isRecord(rows)) {
    for (const [k, v] of Object.entries(rows)) if (num(v) !== undefined) out.set(k, num(v)!);
  }
  return out;
}

export interface DemographicProfile {
  age: Record<AgeBucket, number>;
  gender: { male: number; female: number };
}

/** Averages demographic affinity rows (values are relative, -1..1). */
export function averageDemographics(rows: QlooDemographicsRow[]): DemographicProfile | undefined {
  if (!rows.length) return undefined;
  const age = Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])) as Record<AgeBucket, number>;
  let male = 0;
  let female = 0;
  for (const row of rows) {
    for (const bucket of AGE_BUCKETS) age[bucket] += num(row.query.age?.[bucket]) ?? 0;
    male += num(row.query.gender?.male) ?? 0;
    female += num(row.query.gender?.female) ?? 0;
  }
  const n = rows.length;
  for (const bucket of AGE_BUCKETS) age[bucket] = round(age[bucket] / n, 2);
  return { age, gender: { male: round(male / n, 2), female: round(female / n, 2) } };
}
