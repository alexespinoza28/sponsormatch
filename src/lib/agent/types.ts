import type { DemographicProfile } from "@/lib/qloo/normalize";
import type { QlooRequestRecord } from "@/lib/qloo/types";

export interface EventInput {
  performers: string[];
  venue?: string;
  city: string;
  /** YYYY-MM-DD */
  date?: string;
  /** Optional sponsor category, e.g. "beverage" or "outdoor apparel". */
  category?: string;
}

export interface ResolvedEntity {
  input: string;
  id: string;
  name: string;
  type: string;
  match: "exact" | "best_guess";
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

export interface LocalPlace {
  id: string;
  name: string;
  address?: string;
  affinity?: number;
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
  brandTags: Array<{ id: string; name: string }>;
  tagOverlapScore: number;
  contributors: Contributor[];
  demographics?: DemographicProfile;
  demographicAlignment?: number;
  localPresence: LocalPlace[];
  localPresenceChecked: boolean;
  metadata: {
    useOccasions: string[];
    targetAudience: string[];
    psychographics: string[];
    personality: string[];
    industries: string[];
    priceTier: string[];
  };
  eventOccasions: string[];
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
  requests?: QlooRequestRecord[];
}

export interface AgentResult {
  input: EventInput;
  mode: { qloo: "live" | "mock"; llm: "nemotron" | "template"; model?: string };
  resolution: Resolution;
  audience: AudienceProfile;
  brands: BrandEvidence[];
  pitches: Pitch[];
  requestCount: number;
}

export type AgentEvent =
  | StepEvent
  | { type: "result"; result: AgentResult }
  | { type: "error"; message: string; step?: StepId };
