import {
  entityDescription,
  entityImage,
  explainabilityScores,
  round,
  type DemographicProfile,
} from "@/lib/qloo/normalize";
import type { QlooResultEntity, QlooResultTag } from "@/lib/qloo/types";
import { AGE_BUCKETS } from "@/lib/qloo/types";
import type { AudienceTag, BrandEvidence, Contributor, Hotspot, ResolvedEntity } from "./types";

// Pure ranking and evidence logic over harness tool results. No I/O here.

export const FIT_WEIGHTS = { affinity: 0.6, tags: 0.25, demographics: 0.15 } as const;

/** Picks a tag in the brand genre taxonomy (urn:tag:genre:brand...) from qloo_find_tags results. */
export function pickBrandCategoryTag(tags: QlooResultTag[]): { id: string; name: string } | undefined {
  const t = tags.find((x) => x.id.startsWith("urn:tag:genre:brand"));
  return t ? { id: t.id, name: t.name } : undefined;
}

/** qloo_entity_tags results -> deduped tags with affinity, strongest first. */
export function toAudienceTags(tags: QlooResultTag[], limit = 20): AudienceTag[] {
  const seen = new Set<string>();
  const out: AudienceTag[] = [];
  for (const t of tags) {
    if (typeof t.affinity !== "number" || !Number.isFinite(t.affinity) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ id: t.id, name: t.name, subtype: t.type, affinity: round(t.affinity, 3) });
  }
  return out.sort((a, b) => b.affinity - a.affinity).slice(0, limit);
}

/**
 * Average audience affinity across the brand's tags (brand tags missing from
 * the audience profile count as 0). 1.0 = every brand tag is an audience tag
 * with affinity 1.
 */
export function tagOverlap(
  brandTags: Array<{ id: string; name: string }>,
  audience: AudienceTag[],
): { overlapping: BrandEvidence["overlappingTags"]; score: number } {
  if (!brandTags.length || !audience.length) return { overlapping: [], score: 0 };
  const byId = new Map(audience.map((t) => [t.id, t]));
  const overlapping = brandTags
    .map((t) => byId.get(t.id))
    .filter((t): t is AudienceTag => !!t)
    .map((t) => ({ id: t.id, name: t.name, audienceAffinity: t.affinity }))
    .sort((a, b) => b.audienceAffinity - a.audienceAffinity);
  const sum = overlapping.reduce((s, t) => s + t.audienceAffinity, 0);
  return { overlapping, score: round(Math.min(1, sum / brandTags.length), 3) };
}

function demoVector(p: DemographicProfile): number[] {
  return [...AGE_BUCKETS.map((b) => p.age[b] ?? 0), p.gender.male ?? 0];
}

/** Cosine similarity of two demographic affinity profiles, in [-1, 1]. */
export function demographicAlignment(a?: DemographicProfile, b?: DemographicProfile): number | undefined {
  if (!a || !b) return undefined;
  const x = demoVector(a);
  const y = demoVector(b);
  const dot = x.reduce((s, v, i) => s + v * y[i]!, 0);
  const nx = Math.hypot(...x);
  const ny = Math.hypot(...y);
  if (nx === 0 || ny === 0) return undefined;
  return round(dot / (nx * ny), 3);
}

/**
 * Sponsor fit, 0-100: weighted blend of Qloo affinity, audience tag overlap and
 * demographic alignment (mapped from [-1,1] to [0,1]). Missing components are
 * dropped and the remaining weights renormalized.
 */
export function sponsorFit(parts: { affinity: number; tags?: number; demographics?: number }): number {
  const comps: Array<[number, number]> = [[FIT_WEIGHTS.affinity, clamp01(parts.affinity)]];
  if (parts.tags !== undefined) comps.push([FIT_WEIGHTS.tags, clamp01(parts.tags)]);
  if (parts.demographics !== undefined) comps.push([FIT_WEIGHTS.demographics, clamp01((parts.demographics + 1) / 2)]);
  const totalWeight = comps.reduce((s, [w]) => s + w, 0);
  const score = comps.reduce((s, [w, v]) => s + w * v, 0) / totalWeight;
  return round(score * 100, 1);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

export function contributorsFor(entity: QlooResultEntity, performers: ResolvedEntity[], venue?: ResolvedEntity): Contributor[] {
  const known = new Map<string, { name: string; kind: Contributor["kind"] }>(
    performers.map((p) => [p.id, { name: p.name, kind: "performer" }] as const),
  );
  if (venue) known.set(venue.id, { name: venue.name, kind: "venue" });
  return [...explainabilityScores(entity).entries()]
    .map(([id, score]) => ({ id, name: known.get(id)?.name ?? id, kind: known.get(id)?.kind ?? "other", score: round(score, 3) }))
    .sort((a, b) => b.score - a.score);
}

/** qloo_where_popular results (heatmap points) -> hotspots, strongest first. */
export function toHotspots(points: unknown[], limit = 3): Hotspot[] {
  const out: Hotspot[] = [];
  for (const p of points) {
    const loc = (p as { location?: Record<string, unknown> })?.location;
    const q = (p as { query?: Record<string, unknown> })?.query;
    const lat = loc?.latitude;
    const lon = loc?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    out.push({
      latitude: lat,
      longitude: lon,
      geohash: typeof loc?.geohash === "string" ? loc.geohash : undefined,
      affinity: typeof q?.affinity === "number" ? round(q.affinity, 3) : undefined,
      popularity: typeof q?.popularity === "number" ? round(q.popularity, 3) : undefined,
    });
  }
  return out.sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).slice(0, limit);
}

export interface BuildEvidenceInput {
  brands: QlooResultEntity[];
  audienceTags: AudienceTag[];
  audienceDemographics?: DemographicProfile;
  brandDemographics?: Map<string, DemographicProfile>;
  brandTags?: Map<string, AudienceTag[]>;
  hotspots?: Map<string, Hotspot[]>;
  sources?: Map<string, BrandEvidence["source"]>;
  /** Raw Qloo order (recommend order) used for the "Qloo #n" label. */
  qlooOrder?: string[];
  performers: ResolvedEntity[];
  venue?: ResolvedEntity;
}

/** Turns Qloo brand results plus audience evidence into ranked evidence cards. */
export function buildBrandEvidence(input: BuildEvidenceInput): BrandEvidence[] {
  const seen = new Set<string>();
  const cards: BrandEvidence[] = [];
  const order = input.qlooOrder ?? input.brands.map((b) => b.entity_id);
  for (const entity of input.brands) {
    if (!entity?.entity_id || seen.has(entity.entity_id)) continue;
    seen.add(entity.entity_id);
    const affinity = typeof entity.affinity === "number" && Number.isFinite(entity.affinity) ? entity.affinity : undefined;
    if (affinity === undefined) continue;
    const tags = input.brandTags?.get(entity.entity_id);
    const brandTags = (tags ?? []).map((t) => ({ id: t.id, name: t.name, affinity: t.affinity }));
    const { overlapping, score } = tagOverlap(brandTags, input.audienceTags);
    const demographics = input.brandDemographics?.get(entity.entity_id);
    const alignment = demographicAlignment(input.audienceDemographics, demographics);
    const fitBreakdown = { affinity: round(affinity, 3), tags: tags ? score : undefined, demographics: alignment };
    const qlooIndex = order.indexOf(entity.entity_id);
    cards.push({
      rank: 0,
      id: entity.entity_id,
      name: entity.name,
      description: entityDescription(entity),
      image: entityImage(entity),
      qlooRank: qlooIndex === -1 ? order.length + cards.length + 1 : qlooIndex + 1,
      qlooAffinity: round(affinity, 3),
      popularity: typeof entity.popularity === "number" ? round(entity.popularity, 3) : undefined,
      overlappingTags: overlapping,
      brandTags,
      brandTagsChecked: tags !== undefined,
      tagOverlapScore: score,
      contributors: contributorsFor(entity, input.performers, input.venue),
      demographics,
      demographicAlignment: alignment,
      hotspots: input.hotspots?.get(entity.entity_id) ?? [],
      hotspotsChecked: input.hotspots?.has(entity.entity_id) ?? false,
      source: input.sources?.get(entity.entity_id) ?? "recommended",
      sponsorFit: sponsorFit(fitBreakdown),
      fitBreakdown: { affinity: fitBreakdown.affinity, tags: score, demographics: alignment },
    });
  }
  cards.sort((a, b) => b.sponsorFit - a.sponsorFit || b.qlooAffinity - a.qlooAffinity || a.qlooRank - b.qlooRank);
  cards.forEach((c, i) => (c.rank = i + 1));
  return cards;
}

/** Strongest age bucket and gender lean, for plain-language summaries. */
export function describeDemographics(p?: DemographicProfile): { topAge?: string; genderLean?: string } {
  if (!p) return {};
  const [topBucket, topValue] = AGE_BUCKETS.map((b) => [b, p.age[b] ?? 0] as const).sort((a, b) => b[1] - a[1])[0]!;
  const lean = p.gender.female - p.gender.male;
  return {
    topAge: topValue > 0 ? AGE_LABELS[topBucket] : undefined,
    genderLean: Math.abs(lean) < 0.05 ? "balanced" : lean > 0 ? "female-leaning" : "male-leaning",
  };
}

export const AGE_LABELS: Record<(typeof AGE_BUCKETS)[number], string> = {
  "24_and_younger": "24 and younger",
  "25_to_29": "25-29",
  "30_to_34": "30-34",
  "35_to_44": "35-44",
  "45_to_54": "45-54",
  "55_and_older": "55+",
};
