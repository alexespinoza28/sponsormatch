// Types for the Qloo endpoints SponsorMatch uses, shaped after the public
// Qloo docs (https://docs.qloo.com/reference/insights-api-deep-dive,
// /reference/get-search, /reference/search-tags, /reference/demographics-use-case,
// /reference/taste-analysis). Fields the docs mark as optional, or that differ
// between doc examples, are optional here and normalized in ./normalize.ts.

export const ENTITY_TYPES = {
  artist: "urn:entity:artist",
  brand: "urn:entity:brand",
  place: "urn:entity:place",
  locality: "urn:entity:locality",
} as const;

export const INSIGHT_TYPES = {
  ...ENTITY_TYPES,
  tag: "urn:tag",
  demographics: "urn:demographics",
} as const;

export type QlooEntityType = (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES];
export type QlooInsightType = (typeof INSIGHT_TYPES)[keyof typeof INSIGHT_TYPES];

/** A tag attached to an entity, e.g. `{ id: "urn:tag:genre:brand:fashion", ... }`. */
export interface QlooEntityTag {
  id: string;
  name: string;
  type?: string;
  value?: string;
}

/**
 * Per-result explainability (feature.explainability=true). The docs describe it
 * as "which input entities contributed to the recommendation, with normalized
 * scores between 0 and 1" but do not publish the exact JSON layout, so this
 * accepts the layout SponsorMatch assumes plus a warning string.
 */
export interface QlooExplainability {
  "signal.interests.entities"?: Array<{ entity_id: string; score: number }>;
  warning?: string;
  [key: string]: unknown;
}

export interface QlooEntityQuery {
  affinity?: number;
  explainability?: QlooExplainability;
  measurements?: Record<string, number>;
  [key: string]: unknown;
}

/** Properties vary by entity subtype. Brand fields come from the schema taxonomy page. */
export interface QlooEntityProperties {
  description?: string;
  short_description?: string;
  image?: { url: string };
  address?: string;
  geocode?: {
    name?: string;
    admin1_region?: string;
    country_code?: string;
    metro?: string;
  };
  official_site?: string;
  industry_categories?: string[];
  brand_personality?: string[];
  use_occasions?: string[];
  target_audience?: string[];
  psychographic_segments?: string[];
  complementary_brands?: string[];
  price_tier?: string[];
  business_rating?: number;
  [key: string]: unknown;
}

export interface QlooEntity {
  name: string;
  entity_id: string;
  type?: string; // "urn:entity"
  subtype?: string; // "urn:entity:brand", ...
  /** Some doc examples put affinity at top level; insights examples put it under query. */
  affinity?: number;
  popularity?: number;
  disambiguation?: string;
  properties?: QlooEntityProperties;
  tags?: QlooEntityTag[];
  query?: QlooEntityQuery;
  /** Brand schema example on the taxonomy page lists brand fields at top level. */
  [key: string]: unknown;
}

/** Tag rows returned by /v2/tags and by /v2/insights with filter.type=urn:tag. */
export interface QlooTag {
  tag_id?: string;
  id?: string;
  name: string;
  types?: string[];
  subtype?: string;
  tag_value?: string;
  popularity?: number;
  query?: { affinity?: number; [key: string]: unknown };
}

export type AgeBucket =
  | "24_and_younger"
  | "25_to_29"
  | "30_to_34"
  | "35_to_44"
  | "45_to_54"
  | "55_and_older";

export const AGE_BUCKETS: AgeBucket[] = [
  "24_and_younger",
  "25_to_29",
  "30_to_34",
  "35_to_44",
  "45_to_54",
  "55_and_older",
];

export interface QlooDemographicsRow {
  entity_id: string;
  query: {
    age: Partial<Record<AgeBucket, number>>;
    gender: { male?: number; female?: number };
  };
}

/** GET /search */
export interface QlooSearchResponse {
  success?: boolean;
  duration?: number;
  results: QlooEntity[];
}

/** GET /v2/insights */
export interface QlooInsightsResponse {
  success: boolean;
  duration?: number;
  results: {
    entities?: QlooEntity[];
    tags?: QlooTag[];
    demographics?: QlooDemographicsRow[];
  };
  query?: {
    explainability?: unknown;
    locality?: { signal?: unknown };
    [key: string]: unknown;
  };
}

/** GET /v2/tags */
export interface QlooTagsResponse {
  success?: boolean;
  duration?: number;
  results: { tags: QlooTag[] };
}

/** Error body documented for 4xx responses. */
export interface QlooErrorBody {
  code?: number;
  reason?: string;
  message?: string;
}

export type QueryValue = string | number | boolean | string[] | undefined;
export type QlooQuery = Record<string, QueryValue>;

export interface QlooRequestRecord {
  method: "GET";
  path: string;
  query: Record<string, string>;
  status?: number;
  durationMs?: number;
  cached?: boolean;
}

export interface QlooClient {
  readonly mode: "live" | "mock";
  search(query: QlooQuery): Promise<QlooSearchResponse>;
  insights(query: QlooQuery): Promise<QlooInsightsResponse>;
  tags(query: QlooQuery): Promise<QlooTagsResponse>;
}
