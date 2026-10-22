import {
  entityAddress,
  entityAffinity,
  entityDescription,
  entityExplainability,
  entityImage,
  entityProperty,
  round,
  searchResults,
  tagAffinity,
  tagId,
  type DemographicProfile,
} from "@/lib/qloo/normalize";
import type { QlooEntity, QlooSearchResponse, QlooTag } from "@/lib/qloo/types";
import { AGE_BUCKETS } from "@/lib/qloo/types";
import type { AudienceTag, BrandEvidence, Contributor, LocalPlace, ResolvedEntity } from "./types";

// Pure ranking and evidence logic. No I/O here, so every rule is unit-tested.

export const FIT_WEIGHTS = { affinity: 0.6, tags: 0.25, demographics: 0.15 } as const;

const EVENT_OCCASION_PATTERN = /concert|festival|event|music|nightlife|night out|live|celebration|party|outdoor/i;

export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^the /, "")
    .trim();
}

/**
 * Picks the entity for a free-text input from /search results: a unique exact
 * (normalized) name match wins; otherwise the first result is a best guess and
 * the rest are kept as alternatives for the UI. When `preferAddress` is given,
 * candidates whose address contains it are tried first.
 */
export function pickEntity(
  input: string,
  response: QlooSearchResponse,
  options: { preferAddress?: string } = {},
): ResolvedEntity | undefined {
  let candidates = searchResults(response).filter((e) => e && e.entity_id && e.name);
  if (!candidates.length) return undefined;
  if (options.preferAddress) {
    const want = normalizeName(options.preferAddress);
    const local = candidates.filter((c) => normalizeName(entityAddress(c) ?? "").includes(want));
    if (local.length) candidates = [...local, ...candidates.filter((c) => !local.includes(c))];
  }
  const target = normalizeName(input);
  let exact = candidates.filter((c) => normalizeName(c.name) === target);
  if (exact.length > 1 && options.preferAddress) {
    const want = normalizeName(options.preferAddress);
    const localExact = exact.filter((c) => normalizeName(entityAddress(c) ?? "").includes(want));
    if (localExact.length) exact = localExact;
  }
  const chosen = exact.length === 1 ? exact[0]! : candidates[0]!;
  return {
    input,
    id: chosen.entity_id,
    name: chosen.name,
    type: chosen.subtype ?? chosen.type ?? "urn:entity",
    match: exact.length === 1 ? "exact" : "best_guess",
    popularity: chosen.popularity,
    address: entityAddress(chosen),
    alternatives: candidates
      .filter((c) => c.entity_id !== chosen.entity_id)
      .slice(0, 3)
      .map((c) => ({ id: c.entity_id, name: c.name, popularity: c.popularity })),
  };
}

/** Prefers a tag in the brand genre taxonomy (urn:tag:genre:brand...). */
export function pickBrandCategoryTag(tags: QlooTag[]): { id: string; name: string } | undefined {
  const withIds = tags.map((t) => ({ id: tagId(t), name: t.name })).filter((t): t is { id: string; name: string } => !!t.id);
  return withIds.find((t) => t.id.startsWith("urn:tag:genre:brand")) ?? undefined;
}

export function toAudienceTags(tags: QlooTag[], limit = 15): AudienceTag[] {
  const seen = new Set<string>();
  const out: AudienceTag[] = [];
  for (const t of tags) {
    const id = tagId(t);
    const affinity = tagAffinity(t);
    if (!id || affinity === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: t.name, subtype: t.subtype, affinity: round(affinity, 3) });
  }
  return out.sort((a, b) => b.affinity - a.affinity).slice(0, limit);
}

/**
 * Average audience affinity across the brand's tags (tags the audience profile
 * does not contain count as 0). 1.0 means every brand tag is a top audience tag
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
 * dropped and the remaining weights renormalized, so a brand is never
 * penalized for data Qloo did not return.
 */
export function sponsorFit(parts: { affinity: number; tags: number; demographics?: number }): number {
  const comps: Array<[number, number]> = [
    [FIT_WEIGHTS.affinity, clamp01(parts.affinity)],
    [FIT_WEIGHTS.tags, clamp01(parts.tags)],
  ];
  if (parts.demographics !== undefined) comps.push([FIT_WEIGHTS.demographics, clamp01((parts.demographics + 1) / 2)]);
  const totalWeight = comps.reduce((s, [w]) => s + w, 0);
  const score = comps.reduce((s, [w, v]) => s + w * v, 0) / totalWeight;
  return round(score * 100, 1);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

export function contributorsFor(entity: QlooEntity, performers: ResolvedEntity[], venue?: ResolvedEntity): Contributor[] {
  const scores = entityExplainability(entity);
  const known = new Map<string, { name: string; kind: Contributor["kind"] }>(
    performers.map((p) => [p.id, { name: p.name, kind: "performer" }] as const),
  );
  if (venue) known.set(venue.id, { name: venue.name, kind: "venue" });
  return [...scores.entries()]
    .map(([id, score]) => ({ id, name: known.get(id)?.name ?? id, kind: known.get(id)?.kind ?? "other", score: round(score, 3) }))
    .sort((a, b) => b.score - a.score);
}

export function toLocalPlaces(entities: QlooEntity[], limit = 3): LocalPlace[] {
  return entities.slice(0, limit).map((e) => ({
    id: e.entity_id,
    name: e.name,
    address: entityAddress(e),
    affinity: entityAffinity(e) !== undefined ? round(entityAffinity(e)!, 3) : undefined,
  }));
}

export interface BuildEvidenceInput {
  brands: QlooEntity[];
  audienceTags: AudienceTag[];
  audienceDemographics?: DemographicProfile;
  brandDemographics?: Map<string, DemographicProfile>;
  localPresence?: Map<string, LocalPlace[]>;
  performers: ResolvedEntity[];
  venue?: ResolvedEntity;
}

/** Turns Qloo brand results plus audience evidence into ranked evidence cards. */
export function buildBrandEvidence(input: BuildEvidenceInput): BrandEvidence[] {
  const seen = new Set<string>();
  const cards: BrandEvidence[] = [];
  input.brands.forEach((entity, index) => {
    if (!entity?.entity_id || seen.has(entity.entity_id)) return;
    seen.add(entity.entity_id);
    const affinity = entityAffinity(entity);
    if (affinity === undefined) return;
    const brandTags = (entity.tags ?? []).filter((t) => t?.id).map((t) => ({ id: t.id, name: t.name }));
    const { overlapping, score } = tagOverlap(brandTags, input.audienceTags);
    const demographics = input.brandDemographics?.get(entity.entity_id);
    const alignment = demographicAlignment(input.audienceDemographics, demographics);
    const useOccasions = entityProperty(entity, "use_occasions") ?? [];
    const fitBreakdown = { affinity: round(affinity, 3), tags: score, demographics: alignment };
    cards.push({
      rank: 0,
      id: entity.entity_id,
      name: entity.name,
      description: entityDescription(entity),
      image: entityImage(entity),
      qlooRank: index + 1,
      qlooAffinity: round(affinity, 3),
      popularity: entity.popularity !== undefined ? round(entity.popularity, 3) : undefined,
      overlappingTags: overlapping,
      brandTags,
      tagOverlapScore: score,
      contributors: contributorsFor(entity, input.performers, input.venue),
      demographics,
      demographicAlignment: alignment,
      localPresence: input.localPresence?.get(entity.entity_id) ?? [],
      localPresenceChecked: input.localPresence?.has(entity.entity_id) ?? false,
      metadata: {
        useOccasions,
        targetAudience: entityProperty(entity, "target_audience") ?? [],
        psychographics: entityProperty(entity, "psychographic_segments") ?? [],
        personality: entityProperty(entity, "brand_personality") ?? [],
        industries: entityProperty(entity, "industry_categories") ?? [],
        priceTier: entityProperty(entity, "price_tier") ?? [],
      },
      eventOccasions: useOccasions.filter((o) => EVENT_OCCASION_PATTERN.test(o)),
      sponsorFit: sponsorFit(fitBreakdown),
      fitBreakdown,
    });
  });
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
