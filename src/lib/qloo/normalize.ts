import type {
  AgeBucket,
  QlooDemographicsRow,
  QlooEntity,
  QlooEntityProperties,
  QlooInsightsResponse,
  QlooSearchResponse,
  QlooTag,
  QlooTagsResponse,
} from "./types";
import { AGE_BUCKETS } from "./types";

// Doc examples disagree on where some fields live (insights examples nest
// properties and put affinity under `query`; the brand taxonomy example puts
// brand fields and affinity at top level). These helpers accept both.

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return out.length ? out : undefined;
}

export function entityAffinity(entity: QlooEntity): number | undefined {
  return num(entity.query?.affinity) ?? num(entity.affinity);
}

export type BrandListField =
  | "industry_categories"
  | "brand_personality"
  | "use_occasions"
  | "target_audience"
  | "psychographic_segments"
  | "complementary_brands"
  | "price_tier";

export function entityProperty(entity: QlooEntity, field: BrandListField): string[] | undefined {
  return strings(entity.properties?.[field]) ?? strings(entity[field]);
}

export function entityDescription(entity: QlooEntity): string | undefined {
  const p: QlooEntityProperties = entity.properties ?? {};
  const value = p.short_description ?? p.description ?? entity.description;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function entityAddress(entity: QlooEntity): string | undefined {
  const value = entity.properties?.address ?? entity.address;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function entityImage(entity: QlooEntity): string | undefined {
  const fromProps = entity.properties?.image?.url;
  if (typeof fromProps === "string") return fromProps;
  return typeof entity.url === "string" ? entity.url : undefined;
}

/** Map of input entity id -> contribution score from per-result explainability. */
export function entityExplainability(entity: QlooEntity): Map<string, number> {
  const out = new Map<string, number>();
  const rows = entity.query?.explainability?.["signal.interests.entities"];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (row && typeof row.entity_id === "string") {
      const score = num(row.score);
      if (score !== undefined) out.set(row.entity_id, score);
    }
  }
  return out;
}

export function tagId(tag: QlooTag): string | undefined {
  return tag.tag_id ?? tag.id ?? tag.tag_value;
}

export function tagAffinity(tag: QlooTag): number | undefined {
  return num(tag.query?.affinity);
}

export function searchResults(response: QlooSearchResponse): QlooEntity[] {
  // /search documents `results` as an array; tolerate `results.entities` too.
  const r = response?.results as unknown;
  if (Array.isArray(r)) return r as QlooEntity[];
  const nested = (r as { entities?: unknown })?.entities;
  return Array.isArray(nested) ? (nested as QlooEntity[]) : [];
}

export function insightEntities(response: QlooInsightsResponse): QlooEntity[] {
  const e = response?.results?.entities;
  return Array.isArray(e) ? e : [];
}

export function insightTags(response: QlooInsightsResponse | QlooTagsResponse): QlooTag[] {
  const t = response?.results?.tags;
  return Array.isArray(t) ? t : [];
}

export function insightDemographics(response: QlooInsightsResponse): QlooDemographicsRow[] {
  const d = response?.results?.demographics;
  return Array.isArray(d) ? d.filter((row) => row && typeof row.entity_id === "string" && row.query) : [];
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

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
