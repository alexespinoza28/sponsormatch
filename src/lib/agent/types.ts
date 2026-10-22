import type { DemographicProfile } from "@/lib/qloo/normalize";
import type { QlooCandidate, QlooToolCallRecord } from "@/lib/qloo/types";

export interface EventInput {
  performers: string[];
  venue?: string;
  city: string;
  /** YYYY-MM-DD */
  date?: string;
  /** Optional sponsor category, e.g. "beverage" or "outdoor apparel". */
  category?: string;
  /** Optional brands the producer already wants scored (ranked with qloo_rank). */
  brands?: string[];
  /** User-confirmed entity IDs for inputs that were ambiguous: input text -> Qloo entity ID. */
  pins?: Record<string, string>;
}

/** An ambiguous or unmatched input reported by a tool's needs_input envelope. */
export interface Choice {
  field: "performer" | "venue" | "city" | "category" | "brand";
  input: string;
  kind: string;
  /** What the agent went with, if it continued. */
  chosen?: { id: string; name: string };
  candidates: QlooCandidate[];
}

export interface ResolvedEntity {
  input: string;
  id: string;
  name: string;
  type: string;
  /** Harness match kind (exact, semantic, identifier, ...) or the agent's own fallback. */
  match: string;
  popularity?: number;
  address?: string;
  alternatives: Array<{ id: string; name: string; popularity?: number }>;
}

export interface ResolvedTag {
  input: string;
  id: string;
  name: string;
}

export interface Resolution {
  performers: ResolvedEntity[];
  unresolved: string[];
  choices: Choice[];
  venue?: ResolvedEntity;
  locality?: ResolvedEntity;
  category?: ResolvedTag;
}

export interface AudienceTag {
  id: string;
  name: string;
  subtype?: string;
  affinity: number;
}

export interface AudienceProfile {
  demographics?: DemographicProfile;
  tags: AudienceTag[];
}

export interface Contributor {
  id: string;
  name: string;
  kind: "performer" | "venue" | "other";
  score: number;
}

/** A heatmap point from qloo_where_popular. */
export interface Hotspot {
  latitude: number;
  longitude: number;
  geohash?: string;
  affinity?: number;
  popularity?: number;
}

export interface BrandEvidence {
  rank: number;
  id: string;
  name: string;
  description?: string;
  image?: string;
  qlooRank: number;
  qlooAffinity: number;
  popularity?: number;
  overlappingTags: Array<{ id: string; name: string; audienceAffinity: number }>;
  brandTags: Array<{ id: string; name: string; affinity?: number }>;
  tagOverlapScore: number;
  contributors: Contributor[];
  demographics?: DemographicProfile;
  demographicAlignment?: number;
  hotspots: Hotspot[];
  hotspotsChecked: boolean;
  brandTagsChecked: boolean;
  /** recommended = from qloo_recommend; requested = the producer asked to score it (qloo_rank). */
  source: "recommended" | "requested" | "both";
  sponsorFit: number;
  fitBreakdown: { affinity: number; tags: number; demographics?: number };
}

export interface Pitch {
  brandId: string;
  text: string;
  source: "nemotron" | "template";
  model?: string;
  note?: string;
}

export type StepId = "resolve" | "profile" | "rank" | "explain" | "draft";

export interface StepEvent {
  type: "step";
  step: StepId;
  status: "running" | "done" | "error" | "skipped";
  title: string;
  summary?: string;
  decisions?: string[];
  /** partial/degraded summaries and resolution warnings from the harness. */
  warnings?: string[];
  choices?: Choice[];
  calls?: QlooToolCallRecord[];
}

export interface AgentResult {
  input: EventInput;
  mode: { qloo: "live" | "mock"; llm: "nemotron" | "template"; model?: string };
  resolution: Resolution;
  audience: AudienceProfile;
  brands: BrandEvidence[];
  pitches: Pitch[];
  toolCallCount: number;
}

export type AgentEvent =
  | StepEvent
  | { type: "result"; result: AgentResult }
  | { type: "error"; message: string; step?: StepId };
