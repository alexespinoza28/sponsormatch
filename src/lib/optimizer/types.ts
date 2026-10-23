import type { QlooCandidate, QlooToolCallRecord } from "@/lib/qloo/types";

// Shared types for the lineup optimizer (producer side) and the event ranker
// (sponsor side). Every number in these types comes from a Qloo tool result or
// from documented arithmetic over Qloo results (see scoring.ts); none comes
// from the language model.

export type Goal = "sponsor_fit" | "momentum" | "cohesion";

export interface ActInput {
  name: string;
  /** Dates (YYYY-MM-DD) the act cannot play. */
  unavailable: string[];
}

export interface SlotInput {
  venue: string;
  city: string;
  /** YYYY-MM-DD */
  date?: string;
}

export interface OptimizeInput {
  /** Candidate acts. The first `billSize` acts are the producer's draft lineup. */
  acts: ActInput[];
  /** Venue/date options. The first one is the draft slot. */
  slots: SlotInput[];
  /** Target sponsors (1-3). The first is the primary target. */
  brands: string[];
  billSize: number;
  goal: Goal;
  /** Hard cap on Qloo MCP tool calls for the whole run. */
  budget: number;
  /** User-confirmed entity IDs for ambiguous inputs: input text -> Qloo entity ID. */
  pins?: Record<string, string>;
}

/** An ambiguous or unmatched input reported by a tool's needs_input envelope. */
export interface Choice {
  field: "act" | "venue" | "brand";
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
  /** Harness match kind (exact, identifier, ...), "confirmed" for a user pin, or "agent_pick". */
  match: string;
}

export interface TagAffinity {
  id: string;
  name: string;
  affinity: number;
}

export interface Momentum {
  /** Relative change over the window, clamped to [-1, 1]. Positive = rising. */
  value: number;
  /** Which Qloo trending field it was computed from. */
  metric: string;
  first: number;
  last: number;
  points: number;
}

export interface ActProfile {
  input: ActInput;
  entity: ResolvedEntity;
  /** Affinity of this act for the target brands' audience (one qloo_rank call, option_type artist, all acts at once). */
  brandAffinity?: number;
  /** Taste tags from qloo_entity_tags for this act alone. */
  tags: TagAffinity[];
  momentum?: Momentum;
}

export interface SlotProfile {
  input: SlotInput;
  entity?: ResolvedEntity;
  /** Affinity of the venue for the target brands' audience (qloo_rank, option_type place). */
  brandAffinity?: number;
  label: string;
}

export interface Lineup {
  /** Act entity IDs in bill order (headliner first). */
  acts: string[];
  /** Index into the slots list. */
  slot: number;
}

export interface BrandScore {
  id: string;
  name: string;
  affinity: number;
}

export interface ObjectiveParts {
  fit: number;
  cohesion?: number;
  momentum?: number;
}

/** One evaluated lineup. `brands` are the qloo_rank affinities for the target brands. */
export interface LineupScore {
  key: string;
  lineup: Lineup;
  brands: BrandScore[];
  parts: ObjectiveParts;
  /** 0-100, from scoring.objective(). */
  objective: number;
  /** Correlation ID of the qloo_rank envelope these brand affinities came from. */
  evidenceId: string;
}

export type Move = { kind: "swap"; out: string; in: string } | { kind: "slot"; to: number };

/** One row of a head-to-head qloo_compare_audiences result. */
export interface CompareRow {
  id: string;
  name: string;
  a?: number;
  b?: number;
  /** b - a: positive = leans toward group B. */
  delta?: number;
}

export interface HeadToHead {
  /** "parsed" = rows with a/b affinities; "unrecognized" = Qloo answered in a layout we could not read. */
  layout: "parsed" | "unrecognized" | "unavailable";
  rows: CompareRow[];
  /** Mean (b - a) across target brands found in the rows. */
  targetLean?: number;
  targetsFound: string[];
  /** Brands that lean most toward group B. */
  topGainers: CompareRow[];
  note?: string;
  evidenceId?: string;
}

export interface BudgetState {
  used: number;
  limit: number;
  /** Calls spent before the search loop started. */
  setup: number;
}

export interface IterationEvent {
  type: "iteration";
  iteration: number;
  phase: "proposal" | "evidence" | "decision";
  move: Move;
  moveText: string;
  proposer: "nemotron" | "heuristic";
  rationale?: string;
  proposerNote?: string;
  candidate?: LineupScore;
  headToHead?: HeadToHead;
  accepted?: boolean;
  reason?: string;
  explanation?: string;
  calls?: QlooToolCallRecord[];
  budget: BudgetState;
}

export interface SetupEvent {
  type: "setup";
  phase: "resolve" | "profile" | "baseline";
  status: "running" | "done" | "error";
  title: string;
  summary?: string;
  notes?: string[];
  warnings?: string[];
  choices?: Choice[];
  calls?: QlooToolCallRecord[];
  /** The draft lineup's score (baseline phase only). */
  score?: LineupScore;
  budget: BudgetState;
}

export interface NextSponsor {
  id: string;
  name: string;
  affinity: number;
  /** Explainability: which act drives this brand's affinity most. */
  drivers: Array<{ id: string; name: string; score: number }>;
}

export interface OptimizeResult {
  input: OptimizeInput;
  mode: { qloo: "live" | "mock"; proposer: "nemotron" | "heuristic"; model?: string };
  brands: ResolvedEntity[];
  acts: ActProfile[];
  slots: SlotProfile[];
  draft: LineupScore;
  best: LineupScore;
  /** Objective of every evaluated lineup, in order (baseline first). */
  history: Array<{ iteration: number; objective: number; accepted: boolean; best: number }>;
  acceptedMoves: Array<{ iteration: number; moveText: string; explanation: string }>;
  finalHeadToHead?: HeadToHead;
  nextSponsors: NextSponsor[];
  /** Shared top tags between act pairs in the final lineup (from qloo_entity_tags). */
  cohesionPairs: Array<{ a: string; b: string; overlap: number; shared: string[] }>;
  stopReason: string;
  budget: BudgetState;
  choices: Choice[];
}

export type OptimizerEvent =
  | SetupEvent
  | IterationEvent
  | { type: "stop"; reason: string; budget: BudgetState }
  | { type: "result"; result: OptimizeResult }
  | { type: "error"; message: string };

// --- Sponsor side -----------------------------------------------------------

export interface EventListing {
  name: string;
  acts: string[];
  venue?: string;
  city: string;
  date?: string;
  /** Sponsorship price the event asks, in USD (optional). */
  askUsd?: number;
}

export interface SponsorInput {
  brand: string;
  budgetUsd?: number;
  events: EventListing[];
  pins?: Record<string, string>;
}

export interface RankedEvent {
  listing: EventListing;
  rank: number;
  /** 0-1 blend of act and venue affinity for the brand's audience. */
  score: number;
  /** 100 = average of the pasted events. */
  index: number;
  actAffinity?: number;
  venueAffinity?: number;
  acts: Array<{ input: string; id?: string; name: string; affinity?: number; momentum?: Momentum }>;
  venue?: { input: string; id?: string; name: string; affinity?: number };
  withinBudget?: boolean;
}

export interface SponsorResult {
  input: SponsorInput;
  mode: { qloo: "live" | "mock" };
  brand: ResolvedEntity;
  events: RankedEvent[];
  recommendation?: { eventName: string; reason: string };
  /** qloo_compare_audiences: brand vs. the top event's lineup. */
  sharedTastes?: HeadToHead;
  toolCallCount: number;
  choices: Choice[];
  notes: string[];
}

export type SponsorEvent =
  | { type: "step"; step: string; status: "running" | "done" | "error"; summary?: string; notes?: string[]; calls?: QlooToolCallRecord[]; choices?: Choice[] }
  | { type: "result"; result: SponsorResult }
  | { type: "error"; message: string };
