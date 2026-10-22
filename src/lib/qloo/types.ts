// Types for the Qloo harness MCP tools (`qloo mcp`, @qloo/qloo-harness 0.1.26).
// Input types mirror the inputSchema each tool returns from tools/list (recorded
// in RESOURCES.md "API notes"). The result envelope mirrors the tools' shared
// outputSchema (result schema version 1.0-preview.1).

export const QLOO_TOOL_NAMES = [
  "qloo_capabilities",
  "qloo_recommend",
  "qloo_rank",
  "qloo_describe",
  "qloo_where_popular",
  "qloo_compare_audiences",
  "qloo_entity_tags",
  "qloo_audience_demographics",
  "qloo_trends",
  "qloo_find_tags",
] as const;
export type QlooToolName = (typeof QLOO_TOOL_NAMES)[number];

/** Insights entity types accepted by target_type / option_type. */
export type InsightsEntityType = "artist" | "book" | "brand" | "movie" | "person" | "place" | "podcast" | "tv_show" | "videogame";
/** Search entity types accepted by describe/entity_tags/audience_demographics. */
export type SearchEntityType = InsightsEntityType | "locality" | "actor" | "album" | "author" | "director";

type Op = "union" | "intersection";
/** Arrays of entity names or Qloo entity UUIDs: 1..10 items. */
type Names = string[];

export interface QlooToolInputs {
  qloo_capabilities: { operation_ids?: string[] };
  qloo_recommend: {
    target_type: InsightsEntityType;
    signals?: Names;
    signal_tags?: Names;
    signal_tags_operator?: Op;
    signal_location?: string;
    demographic?: string;
    filter_location?: string;
    include_tags?: Names;
    include_tags_operator?: Op;
    exclude_tags?: Names;
    exclude_tags_operator?: Op;
    explain?: boolean;
    /** 1..20, default 10 */
    limit?: number;
  };
  qloo_rank: {
    options: Names;
    option_type: InsightsEntityType;
    signals?: Names;
    signal_location?: string;
    demographic?: string;
    include_tags?: Names;
    exclude_tags?: Names;
  };
  qloo_describe: { entity: string; type?: SearchEntityType };
  qloo_where_popular: { entity: string; entity_type?: SearchEntityType; within: string; limit?: number };
  qloo_compare_audiences: { group_a: Names; group_b: Names; target_type?: InsightsEntityType; limit?: number };
  qloo_entity_tags: { entities: Names; entity_type?: SearchEntityType; limit?: number };
  qloo_audience_demographics: { entity: string; entity_type?: SearchEntityType; limit?: number };
  qloo_trends: { entities: string[]; entity_type: InsightsEntityType; start_date: string; end_date: string; limit?: number };
  qloo_find_tags: { query: string; semantic?: boolean; limit?: number };
}

export type QlooStatus = "ok" | "empty" | "needs_input" | "partial" | "degraded" | "error";

export interface QlooEnvelopeError {
  code: string;
  layer: string;
  retryable: boolean;
  recovery: string;
}

export interface QlooProvenanceRequest {
  method: "GET";
  path: string;
  query: unknown;
}

/** A candidate offered when an input is ambiguous (needs_input). */
export interface QlooCandidate {
  id: string;
  name: string;
  type?: string;
  popularity?: number;
  description?: string;
  release_year?: number;
  address?: unknown;
}

export interface QlooResolutionIssue {
  input: string;
  kind: string; // "ambiguous" | "not_found" | ...
  input_kind: "entity" | "tag";
  field: string;
  scope?: string;
  purpose?: string;
  candidates?: QlooCandidate[];
  warnings?: string[];
}

export interface QlooEnvelope {
  schema_version: string;
  operation: string;
  status: QlooStatus;
  summary?: string;
  interpretation?: unknown;
  results?: unknown;
  result_count?: number;
  warnings?: string[];
  resolution?: { issues?: QlooResolutionIssue[]; [key: string]: unknown };
  error?: QlooEnvelopeError;
  execution: { transport: "direct" | "cli" | "mcp"; transport_name: string; correlation_id: string; duration_ms: number };
  provenance?: {
    source: string;
    endpoint: string;
    documentation: string;
    transport?: string;
    requests?: QlooProvenanceRequest[];
  };
  [key: string]: unknown;
}

/** Compact entity as returned in `results` by describe/recommend/rank. */
export interface QlooResultEntity {
  entity_id: string;
  name: string;
  type?: string;
  subtype?: string;
  popularity?: number;
  affinity?: number;
  explainability?: unknown;
  properties?: {
    description?: string;
    short_description?: string;
    image?: { url?: string };
    address?: string;
    geocode?: unknown;
    [key: string]: unknown;
  };
}

/** Compact tag as returned in `results` by entity_tags/find_tags. */
export interface QlooResultTag {
  id: string;
  name: string;
  type?: string;
  popularity?: number;
  affinity?: number;
}

export type AgeBucket = "24_and_younger" | "25_to_29" | "30_to_34" | "35_to_44" | "45_to_54" | "55_and_older";

export const AGE_BUCKETS: AgeBucket[] = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];

/** Row in audience_demographics `results` (raw Insights urn:demographics row). */
export interface QlooDemographicsRow {
  entity_id: string;
  query: {
    age: Partial<Record<AgeBucket, number>>;
    gender: { male?: number; female?: number };
  };
}

export interface QlooToolCallRecord {
  tool: QlooToolName;
  args: Record<string, unknown>;
  status: QlooStatus | "failed";
  summary?: string;
  errorCode?: string;
  durationMs: number;
  /** Qloo API requests the harness reports in provenance (no credentials). */
  requests?: QlooProvenanceRequest[];
  attempts?: number;
}

export interface QlooTools {
  readonly mode: "live" | "mock";
  call<T extends QlooToolName>(tool: T, args: QlooToolInputs[T]): Promise<QlooEnvelope>;
}
