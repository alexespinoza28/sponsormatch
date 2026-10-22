import { buildPitchEvidence, draftPitches, type DraftOptions } from "@/lib/llm/pitch";
import {
  averageDemographics,
  entityAddress,
  interpretedEntity,
  issueCandidates,
  resolutionIssues,
  resultDemographics,
  resultEntities,
  resultTags,
  type DemographicProfile,
} from "@/lib/qloo/normalize";
import type {
  QlooEnvelope,
  QlooResultEntity,
  QlooToolCallRecord,
  QlooToolInputs,
  QlooTools,
  SearchEntityType,
} from "@/lib/qloo/types";
import { buildBrandEvidence, describeDemographics, pickBrandCategoryTag, toAudienceTags, toHotspots } from "./evidence";
import type {
  AgentEvent,
  AgentResult,
  AudienceProfile,
  AudienceTag,
  BrandEvidence,
  Choice,
  EventInput,
  Hotspot,
  Resolution,
  ResolvedEntity,
  StepEvent,
  StepId,
} from "./types";

export class AgentError extends Error {
  readonly step: StepId;
  constructor(step: StepId, message: string) {
    super(message);
    this.name = "AgentError";
    this.step = step;
  }
}

/** Thrown when Qloo rejects the credential: the run stops. */
export class QlooAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QlooAuthError";
  }
}

/** Collects MCP tool-call records so each step can report the calls it made. */
export class CallLog {
  #pending: QlooToolCallRecord[] = [];
  total = 0;
  readonly push = (record: QlooToolCallRecord) => {
    this.#pending.push(record);
    this.total += 1;
  };
  drain(): QlooToolCallRecord[] {
    const out = this.#pending;
    this.#pending = [];
    return out;
  }
}

export interface AgentDeps {
  qloo: QlooTools;
  log: CallLog;
  emit: (event: AgentEvent) => void;
  llm: DraftOptions & { enabled: boolean };
  /** Recommended brands that get full evidence (tags + demographics). */
  topN?: number;
  /** Brands that also get a qloo_where_popular heatmap. */
  hotspotN?: number;
  /** Brands that get a pitch draft. */
  pitchN?: number;
  /** Parallel MCP tool calls. */
  concurrency?: number;
}

const STEP_TITLES: Record<StepId, string> = {
  resolve: "Resolve the event to Qloo entities",
  profile: "Profile the audience",
  rank: "Rank brands by audience affinity",
  explain: "Explain each brand with evidence",
  draft: "Draft sponsor pitches",
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function fmt(n: number | undefined, digits = 2): string {
  return n === undefined ? "n/a" : n.toFixed(digits);
}

const ID_PATTERN = /^[A-Za-z0-9:_-]{8,80}$/;

export function validateInput(raw: unknown): EventInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const list = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : String(v ?? "").split(/\n|,/))
      .map((p) => String(p).trim())
      .filter(Boolean)
      .slice(0, max);
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const performers = list(body.performers, 5);
  const brands = list(body.brands, 5);
  const city = text(body.city, 80);
  const date = text(body.date, 10);
  if (!performers.length) throw new AgentError("resolve", "Add at least one performer.");
  if (!city) throw new AgentError("resolve", "Add the event's city.");
  if ([...performers, ...brands].some((p) => p.length > 100)) throw new AgentError("resolve", "Names must be under 100 characters.");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AgentError("resolve", "Date must be YYYY-MM-DD.");
  const pins: Record<string, string> = {};
  if (body.pins && typeof body.pins === "object" && !Array.isArray(body.pins)) {
    for (const [k, v] of Object.entries(body.pins as Record<string, unknown>).slice(0, 12)) {
      if (typeof v === "string" && ID_PATTERN.test(v) && k.length <= 100) pins[k] = v;
    }
  }
  return {
    performers,
    city,
    venue: text(body.venue, 100) || undefined,
    date: date || undefined,
    category: text(body.category, 60) || undefined,
    brands: brands.length ? brands : undefined,
    pins: Object.keys(pins).length ? pins : undefined,
  };
}

/** Per-step bookkeeping for envelope statuses. */
class StepNotes {
  decisions: string[] = [];
  warnings: string[] = [];
  choices: Choice[] = [];

  /**
   * Classifies an envelope. partial/degraded count as usable but their summary
   * is surfaced; QLOO_AUTH stops the run; other errors are reported and skipped.
   */
  check(env: QlooEnvelope, label: string): "ok" | "empty" | "needs_input" | "error" {
    for (const w of env.warnings ?? []) this.warnings.push(`${label}: ${w}`);
    switch (env.status) {
      case "ok":
        return "ok";
      case "partial":
      case "degraded":
        this.warnings.push(`${label} (${env.status}): ${env.summary ?? "reduced result"}`);
        return "ok";
      case "empty":
        this.decisions.push(`${label}: Qloo returned no results${env.summary ? ` (${env.summary})` : ""}.`);
        return "empty";
      case "needs_input":
        return "needs_input";
      case "error":
      default: {
        const code = env.error?.code ?? "UNKNOWN";
        if (code === "QLOO_AUTH" || code === "QLOO_AUTH_BLOCKED") {
          throw new QlooAuthError(`${env.summary ?? "Qloo rejected the credential."} ${env.error?.recovery ?? ""}`.trim());
        }
        this.decisions.push(`${label} failed (${code}): ${env.summary ?? "error"}${env.error?.recovery ? ` Recovery: ${env.error.recovery}` : ""}`);
        return "error";
      }
    }
  }
}

export async function runAgent(input: EventInput, deps: AgentDeps): Promise<AgentResult> {
  const { qloo, log, emit } = deps;
  const topN = deps.topN ?? 5;
  const hotspotN = deps.hotspotN ?? 3;
  const pitchN = deps.pitchN ?? 5;
  const concurrency = deps.concurrency ?? 4;
  const pins = input.pins ?? {};
  let current: StepId = "resolve";

  const start = (step: StepId) => {
    current = step;
    log.drain();
    emit({ type: "step", step, status: "running", title: STEP_TITLES[step] });
    return new StepNotes();
  };
  const finish = (step: StepId, summary: string, notes: StepNotes, status: StepEvent["status"] = "done") => {
    emit({
      type: "step",
      step,
      status,
      title: STEP_TITLES[step],
      summary,
      decisions: notes.decisions,
      warnings: notes.warnings.length ? notes.warnings : undefined,
      choices: notes.choices.length ? notes.choices : undefined,
      calls: log.drain(),
    });
  };

  /** qloo_describe with needs_input handling; continues with the top candidate and records the choice. */
  async function resolveEntity(notes: StepNotes, text: string, type: SearchEntityType, field: Choice["field"]): Promise<ResolvedEntity | undefined> {
    const pinned = pins[text];
    const env = await qloo.call("qloo_describe", { entity: pinned ?? text, type });
    const status = notes.check(env, `Describe "${text}"`);
    if (status === "ok") {
      const e = interpretedEntity(env);
      const r = resultEntities(env)[0];
      const id = e?.entityId ?? r?.entity_id;
      const name = e?.name ?? r?.name;
      if (!id || !name) return undefined;
      return {
        input: text,
        id,
        name,
        type: r?.subtype ?? e?.type ?? type,
        match: pinned ? "confirmed" : (e?.match ?? "resolved"),
        popularity: r?.popularity,
        address: r ? entityAddress(r) : undefined,
        alternatives: [],
      };
    }
    if (status === "needs_input") {
      const issue = resolutionIssues(env)[0];
      const candidates = issue ? issueCandidates(issue) : [];
      const choice: Choice = { field, input: text, kind: issue?.kind ?? "needs_input", candidates };
      notes.choices.push(choice);
      const top = candidates[0];
      if (top) {
        choice.chosen = { id: top.id, name: top.name };
        notes.decisions.push(`"${text}" is ${choice.kind}; continuing with the first candidate, ${top.name}. Pick another in the list to re-run.`);
        return {
          input: text,
          id: top.id,
          name: top.name,
          type: top.type ?? type,
          match: "agent_pick",
          popularity: top.popularity,
          alternatives: candidates.slice(1).map((c) => ({ id: c.id, name: c.name, popularity: c.popularity })),
        };
      }
      notes.decisions.push(`"${text}" needs input (${env.summary ?? choice.kind}) and Qloo offered no candidates.`);
    }
    return undefined;
  }

  try {
    // 1. RESOLVE ---------------------------------------------------------------
    let notes = start("resolve");
    const performerResults = await mapLimit(input.performers, concurrency, (p) => resolveEntity(notes, p, "artist", "performer"));
    const performers: ResolvedEntity[] = [];
    const unresolved: string[] = [];
    performerResults.forEach((p, i) => {
      const name = input.performers[i]!;
      if (!p) {
        unresolved.push(name);
        notes.decisions.push(`"${name}": no Qloo artist; left out of the signals.`);
      } else if (performers.some((x) => x.id === p.id)) {
        notes.decisions.push(`"${name}" resolved to ${p.name}, already in the lineup; deduplicated.`);
      } else {
        performers.push(p);
        if (p.match !== "agent_pick") notes.decisions.push(`"${name}" -> ${p.name} (${p.match}, popularity ${fmt(p.popularity)}).`);
      }
    });

    const [locality, venue, categoryEnv] = await Promise.all([
      resolveEntity(notes, input.city, "locality", "city"),
      input.venue ? resolveEntity(notes, input.venue, "place", "venue") : Promise.resolve(undefined),
      input.category ? qloo.call("qloo_find_tags", { query: input.category, limit: 10 }) : Promise.resolve(undefined),
    ]);
    const signalLocation = locality?.name ?? input.city;
    notes.decisions.push(
      locality
        ? `City "${input.city}" -> ${locality.name}; passed to Qloo as signal_location.`
        : `City "${input.city}" not resolved; passing the text as signal_location.`,
    );
    if (input.venue) {
      notes.decisions.push(venue ? `Venue "${input.venue}" -> ${venue.name}; added as a signal.` : `Venue "${input.venue}" not found; using performers only.`);
    }

    let category: Resolution["category"];
    if (input.category && categoryEnv) {
      const status = notes.check(categoryEnv, `Find tags "${input.category}"`);
      const tags = status === "ok" ? resultTags(categoryEnv) : [];
      const tag = pickBrandCategoryTag(tags);
      if (tag) {
        category = { input: input.category, ...tag };
        notes.decisions.push(`Category "${input.category}" -> ${tag.name} (${tag.id}); used as include_tags.`);
      } else {
        notes.decisions.push(`No brand-genre tag matched "${input.category}"; ranking all brand categories.`);
        if (tags.length) {
          notes.choices.push({
            field: "category",
            input: input.category,
            kind: "no_brand_tag",
            candidates: tags.slice(0, 5).map((t) => ({ id: t.id, name: t.name, type: t.type })),
          });
        }
      }
    }

    if (!performers.length) {
      finish("resolve", "No performers could be matched to Qloo artists.", notes, "error");
      throw new AgentError("resolve", "None of the performers matched a Qloo artist. Check spelling or try a better-known act.");
    }
    const resolution: Resolution = { performers, unresolved, choices: [...notes.choices], venue, locality, category };
    finish(
      "resolve",
      `${performers.length} performer${performers.length > 1 ? "s" : ""} resolved${venue ? ", venue found" : ""}${locality ? `, city -> ${locality.name}` : ""}${notes.choices.length ? `; ${notes.choices.length} input${notes.choices.length > 1 ? "s" : ""} need confirmation` : ""}.`,
      notes,
    );

    const performerIds = performers.map((p) => p.id);
    const signalIds = [...performerIds, ...(venue ? [venue.id] : [])];

    // 2. PROFILE ---------------------------------------------------------------
    notes = start("profile");
    const [demoEnvs, tagEnv] = await Promise.all([
      mapLimit(performers, concurrency, (p) => qloo.call("qloo_audience_demographics", { entity: p.id, entity_type: "artist" })),
      qloo.call("qloo_entity_tags", { entities: signalIds, limit: 20 }),
    ]);
    const demoRows = demoEnvs.flatMap((env, i) =>
      notes.check(env, `Demographics for ${performers[i]!.name}`) === "ok"
        ? resultDemographics(env).filter((r) => r.entity_id === performers[i]!.id || resultDemographics(env).length === 1)
        : [],
    );
    const audienceDemo = averageDemographics(demoRows);
    const audienceTags: AudienceTag[] = notes.check(tagEnv, "Audience taste tags") === "ok" ? toAudienceTags(resultTags(tagEnv)) : [];
    const audience: AudienceProfile = { demographics: audienceDemo, tags: audienceTags };
    const demoText = describeDemographics(audienceDemo);
    if (audienceTags.length) {
      notes.decisions.push(`Top audience taste tags: ${audienceTags.slice(0, 5).map((t) => `${t.name} (${fmt(t.affinity)})`).join(", ")}.`);
    }
    if (demoText.topAge) notes.decisions.push(`Audience skews ${demoText.topAge}, ${demoText.genderLean}.`);
    if (!audienceDemo) notes.decisions.push("No demographics; sponsor fit will skip demographic alignment.");
    finish("profile", `${audienceTags.length} taste tags${audienceDemo ? " and an age/gender affinity profile" : ""} for this lineup.`, notes);

    // 3. RANK ------------------------------------------------------------------
    notes = start("rank");
    const base: QlooToolInputs["qloo_recommend"] = { target_type: "brand", signals: signalIds, explain: true, limit: 20 };
    const attempts: Array<{ args: QlooToolInputs["qloo_recommend"]; label: string }> = [
      { args: { ...base, signal_location: signalLocation, ...(category ? { include_tags: [category.id] } : {}) }, label: `in ${signalLocation}${category ? ` within ${category.name}` : ""}` },
    ];
    if (category) attempts.push({ args: { ...base, signal_location: signalLocation }, label: `in ${signalLocation}, any category` });
    attempts.push({ args: base, label: "without location" });
    let recommended: QlooResultEntity[] = [];
    for (const [i, attempt] of attempts.entries()) {
      const env = await qloo.call("qloo_recommend", attempt.args);
      const status = notes.check(env, `Recommend brands ${attempt.label}`);
      if (status === "needs_input") {
        for (const issue of resolutionIssues(env)) {
          notes.choices.push({ field: issue.input_kind === "tag" ? "category" : "performer", input: issue.input, kind: issue.kind, candidates: issueCandidates(issue) });
        }
        notes.decisions.push(`Recommend ${attempt.label} needs input: ${env.summary ?? "ambiguous input"}.`);
      }
      recommended = status === "ok" ? resultEntities(env) : [];
      if (recommended.length) {
        notes.decisions.push(`${recommended.length} brands recommended ${attempt.label}.`);
        break;
      }
      if (i < attempts.length - 1) notes.decisions.push(`No brands ${attempt.label}; relaxing the query.`);
    }

    let requested: QlooResultEntity[] = [];
    if (input.brands?.length) {
      let options = input.brands.map((b) => pins[b] ?? b);
      for (let attempt = 1; attempt <= 2 && options.length; attempt += 1) {
        const env = await qloo.call("qloo_rank", { options, option_type: "brand", signals: signalIds, signal_location: signalLocation });
        const status = notes.check(env, `Rank your brands (${options.length})`);
        if (status === "ok") {
          requested = resultEntities(env);
          notes.decisions.push(`Ranked your brands: ${requested.map((b) => `${b.name} (${fmt(b.affinity)})`).join(", ")}.`);
          break;
        }
        if (status !== "needs_input") break;
        const issues = resolutionIssues(env).filter((i) => i.field === "options");
        for (const issue of issues) notes.choices.push({ field: "brand", input: issue.input, kind: issue.kind, candidates: issueCandidates(issue) });
        const bad = new Set(issues.map((i) => i.input));
        const next = options.filter((o) => !bad.has(o));
        if (!bad.size || next.length === options.length) break;
        notes.decisions.push(`Qloo could not match ${[...bad].map((b) => `"${b}"`).join(", ")}; ranking the rest.`);
        options = next;
      }
    }

    const sources = new Map<string, BrandEvidence["source"]>();
    const candidates: QlooResultEntity[] = [];
    for (const b of recommended.slice(0, topN)) {
      sources.set(b.entity_id, "recommended");
      candidates.push(b);
    }
    for (const b of requested) {
      if (sources.has(b.entity_id)) sources.set(b.entity_id, "both");
      else {
        sources.set(b.entity_id, "requested");
        candidates.push(b);
      }
    }
    if (!candidates.length) {
      finish("rank", "Qloo returned no brands for these signals.", notes, "error");
      throw new AgentError("rank", "Qloo returned no brand affinities for this lineup.");
    }
    notes.decisions.push(`Top by Qloo affinity: ${recommended.slice(0, 5).map((b) => `${b.name} (${fmt(b.affinity)})`).join(", ") || "none"}.`);
    finish("rank", `${recommended.length} brands recommended${requested.length ? `, ${requested.length} of yours ranked` : ""}.`, notes);

    // 4. EXPLAIN ---------------------------------------------------------------
    notes = start("explain");
    const brandTags = new Map<string, AudienceTag[]>();
    const brandDemographics = new Map<string, DemographicProfile>();
    const hotspots = new Map<string, Hotspot[]>();
    const hotspotIds = new Set(
      [...candidates]
        .sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))
        .slice(0, hotspotN)
        .map((b) => b.entity_id),
    );
    type Job = { kind: "tags" | "demo" | "hot"; brand: QlooResultEntity };
    const jobs: Job[] = candidates.flatMap((b) => [
      { kind: "tags" as const, brand: b },
      { kind: "demo" as const, brand: b },
      ...(hotspotIds.has(b.entity_id) ? [{ kind: "hot" as const, brand: b }] : []),
    ]);
    await mapLimit(jobs, concurrency, async ({ kind, brand }) => {
      if (kind === "tags") {
        const env = await qloo.call("qloo_entity_tags", { entities: [brand.entity_id], entity_type: "brand", limit: 15 });
        if (notes.check(env, `Tags for ${brand.name}`) === "ok") brandTags.set(brand.entity_id, toAudienceTags(resultTags(env), 15));
      } else if (kind === "demo") {
        const env = await qloo.call("qloo_audience_demographics", { entity: brand.entity_id, entity_type: "brand" });
        const avg = notes.check(env, `Demographics for ${brand.name}`) === "ok" ? averageDemographics(resultDemographics(env)) : undefined;
        if (avg) brandDemographics.set(brand.entity_id, avg);
      } else {
        const env = await qloo.call("qloo_where_popular", { entity: brand.entity_id, entity_type: "brand", within: signalLocation, limit: 3 });
        const status = notes.check(env, `Hotspots for ${brand.name} in ${signalLocation}`);
        hotspots.set(brand.entity_id, status === "ok" && Array.isArray(env.results) ? toHotspots(env.results) : []);
      }
    });
    const brands = buildBrandEvidence({
      brands: candidates,
      audienceTags,
      audienceDemographics: audienceDemo,
      brandDemographics,
      brandTags,
      hotspots,
      sources,
      qlooOrder: recommended.map((b) => b.entity_id),
      performers,
      venue,
    });
    for (const b of brands) {
      notes.decisions.push(
        `${b.name}: fit ${b.sponsorFit} = affinity ${fmt(b.qlooAffinity)}, tag overlap ${fmt(b.tagOverlapScore)} (${b.overlappingTags.length} shared)` +
          `${b.demographicAlignment !== undefined ? `, demo alignment ${fmt(b.demographicAlignment)}` : ""}` +
          `${b.hotspots.length ? `, ${b.hotspots.length} local hotspot${b.hotspots.length > 1 ? "s" : ""}` : ""}.`,
      );
    }
    const moved = brands.filter((b) => b.source !== "requested" && b.rank !== b.qlooRank).length;
    if (moved) notes.decisions.push(`${moved} brands re-ordered from raw Qloo affinity by audience-specific evidence.`);
    finish("explain", `Evidence built for ${brands.length} brands.`, notes);

    // 5. DRAFT -----------------------------------------------------------------
    notes = start("draft");
    const toPitch = brands.slice(0, pitchN);
    const pitches = await draftPitches(
      toPitch.map((b) => ({ brandId: b.id, evidence: buildPitchEvidence(input, b, audience) })),
      deps.llm.enabled ? deps.llm : { ...deps.llm, apiKey: undefined },
    );
    for (const p of pitches) {
      const name = toPitch.find((b) => b.id === p.brandId)?.name ?? p.brandId;
      notes.decisions.push(p.source === "nemotron" ? `${name}: drafted by ${p.model}.` : `${name}: template draft${p.note ? ` (${p.note})` : ""}.`);
    }
    const nemotronCount = pitches.filter((p) => p.source === "nemotron").length;
    finish(
      "draft",
      nemotronCount ? `${nemotronCount} of ${pitches.length} pitches drafted by Nemotron from evidence only.` : `${pitches.length} template pitches drafted from evidence.`,
      notes,
    );

    resolution.choices = [...resolution.choices];
    const result: AgentResult = {
      input,
      mode: { qloo: qloo.mode, llm: deps.llm.enabled ? "nemotron" : "template", model: deps.llm.enabled ? deps.llm.model : undefined },
      resolution,
      audience,
      brands,
      pitches,
      toolCallCount: log.total,
    };
    emit({ type: "result", result });
    return result;
  } catch (error) {
    const message =
      error instanceof AgentError
        ? error.message
        : error instanceof QlooAuthError
          ? `Qloo rejected the credential, so the agent stopped and will not call Qloo again for five minutes. ${error.message}`
          : error instanceof Error
            ? error.message
            : "Unexpected error";
    emit({ type: "error", message, step: error instanceof AgentError ? error.step : current });
    throw error;
  }
}
