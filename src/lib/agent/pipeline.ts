import { QlooApiError } from "@/lib/qloo/client";
import {
  averageDemographics,
  insightDemographics,
  insightEntities,
  insightTags,
  type DemographicProfile,
} from "@/lib/qloo/normalize";
import { ENTITY_TYPES, INSIGHT_TYPES, type QlooClient, type QlooEntity, type QlooQuery, type QlooRequestRecord } from "@/lib/qloo/types";
import { buildPitchEvidence, draftPitches, type DraftOptions } from "@/lib/llm/pitch";
import {
  buildBrandEvidence,
  describeDemographics,
  pickBrandCategoryTag,
  pickEntity,
  toAudienceTags,
  toLocalPlaces,
} from "./evidence";
import type {
  AgentEvent,
  AgentResult,
  AudienceProfile,
  BrandEvidence,
  EventInput,
  LocalPlace,
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

/** Collects Qloo request records so each step can report the calls it made. */
export class RequestLog {
  #pending: QlooRequestRecord[] = [];
  total = 0;
  readonly push = (record: QlooRequestRecord) => {
    this.#pending.push(record);
    this.total += 1;
  };
  drain(): QlooRequestRecord[] {
    const out = this.#pending;
    this.#pending = [];
    return out;
  }
}

export interface AgentDeps {
  qloo: QlooClient;
  log: RequestLog;
  emit: (event: AgentEvent) => void;
  llm: DraftOptions & { enabled: boolean };
  /** Brands that get full evidence (demographics + local presence). */
  topN?: number;
  /** Brands that get a pitch draft. */
  pitchN?: number;
}

const STEP_TITLES: Record<StepId, string> = {
  resolve: "Resolve the event to Qloo entities",
  profile: "Profile the audience",
  rank: "Rank brands by audience affinity",
  explain: "Explain each brand with evidence",
  draft: "Draft sponsor pitches",
};

function isFatal(error: unknown): boolean {
  return error instanceof QlooApiError && (error.code === "QLOO_AUTH" || error.code === "QLOO_AUTH_BLOCKED");
}

/** Runs an optional lookup; auth failures still abort the whole run. */
async function soft<T>(work: Promise<T>, onError: (message: string) => void): Promise<T | undefined> {
  try {
    return await work;
  } catch (error) {
    if (isFatal(error)) throw error;
    onError(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function fmt(n: number | undefined, digits = 2): string {
  return n === undefined ? "n/a" : n.toFixed(digits);
}

export function validateInput(raw: unknown): EventInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const performers = (Array.isArray(body.performers) ? body.performers : String(body.performers ?? "").split(/\n|,/))
    .map((p) => String(p).trim())
    .filter(Boolean)
    .slice(0, 5);
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const city = text(body.city, 80);
  const date = text(body.date, 10);
  if (!performers.length) throw new AgentError("resolve", "Add at least one performer.");
  if (!city) throw new AgentError("resolve", "Add the event's city.");
  if (performers.some((p) => p.length > 100)) throw new AgentError("resolve", "Performer names must be under 100 characters.");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AgentError("resolve", "Date must be YYYY-MM-DD.");
  return {
    performers,
    city,
    venue: text(body.venue, 100) || undefined,
    date: date || undefined,
    category: text(body.category, 60) || undefined,
  };
}

export async function runAgent(input: EventInput, deps: AgentDeps): Promise<AgentResult> {
  const { qloo, log, emit } = deps;
  const topN = deps.topN ?? 6;
  const pitchN = deps.pitchN ?? 5;
  let current: StepId = "resolve";

  const start = (step: StepId) => {
    current = step;
    log.drain();
    emit({ type: "step", step, status: "running", title: STEP_TITLES[step] });
  };
  const finish = (step: StepId, summary: string, decisions: string[], status: StepEvent["status"] = "done") => {
    emit({ type: "step", step, status, title: STEP_TITLES[step], summary, decisions, requests: log.drain() });
  };

  try {
    // 1. RESOLVE ---------------------------------------------------------------
    start("resolve");
    const decisions: string[] = [];
    const performerResults = await Promise.all(
      input.performers.map(async (name) => {
        const res = await soft(qloo.search({ query: name, types: [ENTITY_TYPES.artist], take: 5 }), (m) =>
          decisions.push(`Search for "${name}" failed (${m}); skipping it.`),
        );
        return res ? pickEntity(name, res) : undefined;
      }),
    );
    const performers: ResolvedEntity[] = [];
    const unresolved: string[] = [];
    performerResults.forEach((p, i) => {
      const name = input.performers[i]!;
      if (!p) {
        unresolved.push(name);
        decisions.push(`"${name}": no Qloo artist found; left out of the signals.`);
      } else if (performers.some((x) => x.id === p.id)) {
        decisions.push(`"${name}" resolved to ${p.name}, already in the lineup; deduplicated.`);
      } else {
        performers.push(p);
        decisions.push(
          p.match === "exact"
            ? `"${name}" -> ${p.name} (exact match, popularity ${fmt(p.popularity)}).`
            : `"${name}" -> ${p.name} (best guess; alternatives: ${p.alternatives.map((a) => a.name).join(", ") || "none"}).`,
        );
      }
    });

    const [localityRes, venueRes, categoryRes] = await Promise.all([
      soft(qloo.search({ query: input.city, types: [ENTITY_TYPES.locality], take: 3 }), (m) =>
        decisions.push(`Locality lookup failed (${m}); using the city name as a text location.`),
      ),
      input.venue
        ? soft(qloo.search({ query: input.venue, types: [ENTITY_TYPES.place], "filter.address": input.city, take: 5 }), (m) =>
            decisions.push(`Venue lookup failed (${m}).`),
          )
        : Promise.resolve(undefined),
      input.category
        ? soft(qloo.tags({ "filter.query": input.category, "filter.parents.types": [ENTITY_TYPES.brand], take: 10 }), (m) =>
            decisions.push(`Category tag lookup failed (${m}); ranking all brand categories.`),
          )
        : Promise.resolve(undefined),
    ]);

    const locality = localityRes ? pickEntity(input.city, localityRes) : undefined;
    decisions.push(
      locality
        ? `City "${input.city}" -> locality ${locality.name} (${locality.match === "exact" ? "exact" : "best guess"}); used as signal.location.`
        : `City "${input.city}" not resolved to a locality; using signal.location.query="${input.city}".`,
    );

    let venue: ResolvedEntity | undefined;
    if (input.venue) {
      let picked = venueRes ? pickEntity(input.venue, venueRes, { preferAddress: input.city }) : undefined;
      if (!picked && venueRes) {
        decisions.push(`No venue named "${input.venue}" with an address in ${input.city}; retrying without the address filter.`);
        const retry = await soft(qloo.search({ query: input.venue, types: [ENTITY_TYPES.place], take: 5 }), () => undefined);
        picked = retry ? pickEntity(input.venue, retry, { preferAddress: input.city }) : undefined;
      }
      venue = picked;
      decisions.push(
        venue
          ? `Venue "${input.venue}" -> ${venue.name}${venue.address ? ` (${venue.address})` : ""}; added as a signal.`
          : `Venue "${input.venue}" not found in Qloo; continuing with performers only.`,
      );
    }

    let category: Resolution["category"];
    if (input.category && categoryRes) {
      const tag = pickBrandCategoryTag(insightTags(categoryRes));
      if (tag) {
        category = { input: input.category, ...tag };
        decisions.push(`Category "${input.category}" -> brand tag ${tag.name} (${tag.id}); used as filter.tags.`);
      } else {
        decisions.push(`No brand-genre tag matched "${input.category}"; ranking all brand categories.`);
      }
    }

    if (!performers.length) {
      finish("resolve", "No performers could be matched to Qloo artists.", decisions, "error");
      throw new AgentError("resolve", "None of the performers matched a Qloo artist. Check spelling or try a better-known act.");
    }
    const resolution: Resolution = { performers, unresolved, venue, locality, category };
    finish(
      "resolve",
      `${performers.length} performer${performers.length > 1 ? "s" : ""} resolved${venue ? ", venue found" : ""}${locality ? `, city -> ${locality.name}` : ""}.`,
      decisions,
    );

    const signalIds = [...performers.map((p) => p.id), ...(venue ? [venue.id] : [])];
    const performerIds = performers.map((p) => p.id);
    const location: QlooQuery = locality ? { "signal.location": locality.id } : { "signal.location.query": input.city };
    const placeFilter: QlooQuery = locality ? { "filter.location": locality.id } : { "filter.location.query": input.city };

    // 2. PROFILE ---------------------------------------------------------------
    start("profile");
    const profileDecisions: string[] = [];
    const tagQuery: QlooQuery = {
      "filter.type": INSIGHT_TYPES.tag,
      "signal.interests.entities": signalIds,
      "filter.parents.types": [ENTITY_TYPES.brand],
      take: 25,
    };
    const [demoRes, tagRes] = await Promise.all([
      soft(qloo.insights({ "filter.type": INSIGHT_TYPES.demographics, "signal.interests.entities": performerIds }), (m) =>
        profileDecisions.push(`Demographics unavailable (${m}); fit score will skip demographic alignment.`),
      ),
      soft(qloo.insights({ ...tagQuery, ...location }), (m) => profileDecisions.push(`Localized taste tags failed (${m}).`)),
    ]);
    let tagRows = tagRes ? insightTags(tagRes) : [];
    if (!tagRows.length) {
      profileDecisions.push("No localized brand taste tags came back; retrying without the location signal.");
      const retry = await soft(qloo.insights(tagQuery), (m) => profileDecisions.push(`Retry failed (${m}).`));
      tagRows = retry ? insightTags(retry) : [];
    }
    const audienceDemo: DemographicProfile | undefined = demoRes
      ? averageDemographics(insightDemographics(demoRes).filter((r) => performerIds.includes(r.entity_id)))
      : undefined;
    const audience: AudienceProfile = { demographics: audienceDemo, tags: toAudienceTags(tagRows) };
    const demoText = describeDemographics(audienceDemo);
    if (audience.tags.length) {
      profileDecisions.push(
        `Top audience brand-taste tags: ${audience.tags
          .slice(0, 5)
          .map((t) => `${t.name} (${fmt(t.affinity)})`)
          .join(", ")}.`,
      );
    }
    if (demoText.topAge) profileDecisions.push(`Audience skews ${demoText.topAge}, ${demoText.genderLean}.`);
    finish(
      "profile",
      `${audience.tags.length} taste tags${audienceDemo ? " and an age/gender affinity profile" : ""} for this lineup in ${locality?.name ?? input.city}.`,
      profileDecisions,
    );

    // 3. RANK ------------------------------------------------------------------
    start("rank");
    const rankDecisions: string[] = [];
    const baseBrandQuery: QlooQuery = {
      "filter.type": ENTITY_TYPES.brand,
      "signal.interests.entities": signalIds,
      "feature.explainability": true,
      take: 20,
    };
    const attempts: Array<{ query: QlooQuery; label: string }> = [
      { query: { ...baseBrandQuery, ...location, ...(category ? { "filter.tags": [category.id] } : {}) }, label: "with location" },
      { query: { ...baseBrandQuery, ...(category ? { "filter.tags": [category.id] } : {}) }, label: "without location" },
    ];
    if (category) attempts.push({ query: baseBrandQuery, label: "without location or category" });
    let brandEntities: QlooEntity[] = [];
    for (const [i, attempt] of attempts.entries()) {
      const res = await soft(qloo.insights(attempt.query), (m) => rankDecisions.push(`Brand insights ${attempt.label} failed (${m}).`));
      brandEntities = res ? insightEntities(res) : [];
      if (brandEntities.length) {
        if (i > 0) rankDecisions.push(`Got ${brandEntities.length} brands ${attempt.label}.`);
        break;
      }
      if (i < attempts.length - 1) rankDecisions.push(`No brands ${attempt.label}; relaxing the query.`);
    }
    if (!brandEntities.length) {
      finish("rank", "Qloo returned no brands for these signals.", rankDecisions, "error");
      throw new AgentError("rank", "Qloo returned no brand affinities for this lineup.");
    }
    rankDecisions.push(
      `Top by Qloo affinity: ${brandEntities
        .slice(0, 5)
        .map((b) => `${b.name} (${fmt(b.query?.affinity ?? (b.affinity as number | undefined))})`)
        .join(", ")}.`,
    );
    finish("rank", `${brandEntities.length} brands ranked by affinity to the lineup${category ? ` in ${category.name}` : ""}.`, rankDecisions);

    // 4. EXPLAIN ---------------------------------------------------------------
    start("explain");
    const explainDecisions: string[] = [];
    const top = brandEntities.slice(0, topN);
    const topIds = top.map((b) => b.entity_id);
    const [brandDemoRes, ...placeResults] = await Promise.all([
      soft(qloo.insights({ "filter.type": INSIGHT_TYPES.demographics, "signal.interests.entities": topIds }), (m) =>
        explainDecisions.push(`Brand demographics unavailable (${m}).`),
      ),
      ...top.map((b) =>
        soft(
          qloo.insights({
            "filter.type": ENTITY_TYPES.place,
            "filter.references_brand": [b.entity_id],
            ...placeFilter,
            "signal.interests.entities": performerIds,
            take: 3,
          }),
          (m) => explainDecisions.push(`Local presence check for ${b.name} failed (${m}).`),
        ),
      ),
    ]);
    const brandDemographics = new Map<string, DemographicProfile>();
    for (const row of brandDemoRes ? insightDemographics(brandDemoRes) : []) {
      const avg = averageDemographics([row]);
      if (avg) brandDemographics.set(row.entity_id, avg);
    }
    const localPresence = new Map<string, LocalPlace[]>();
    top.forEach((b, i) => {
      const res = placeResults[i];
      if (res) localPresence.set(b.entity_id, toLocalPlaces(insightEntities(res)));
    });
    const brands: BrandEvidence[] = buildBrandEvidence({
      brands: top,
      audienceTags: audience.tags,
      audienceDemographics: audienceDemo,
      brandDemographics,
      localPresence,
      performers,
      venue,
    });
    for (const b of brands) {
      explainDecisions.push(
        `${b.name}: fit ${b.sponsorFit} = affinity ${fmt(b.qlooAffinity)}, tag overlap ${fmt(b.tagOverlapScore)} (${b.overlappingTags.length} shared)` +
          `${b.demographicAlignment !== undefined ? `, demo alignment ${fmt(b.demographicAlignment)}` : ""}` +
          `${b.localPresence.length ? `, ${b.localPresence.length} local location${b.localPresence.length > 1 ? "s" : ""}` : ""}.`,
      );
    }
    const moved = brands.filter((b) => b.rank !== b.qlooRank).length;
    if (moved) explainDecisions.push(`${moved} brands re-ordered from raw Qloo affinity by audience-specific evidence.`);
    finish("explain", `Evidence built for the top ${brands.length} brands.`, explainDecisions);

    // 5. DRAFT -----------------------------------------------------------------
    start("draft");
    const toPitch = brands.slice(0, pitchN);
    const pitches = await draftPitches(
      toPitch.map((b) => ({ brandId: b.id, evidence: buildPitchEvidence(input, b, audience) })),
      deps.llm.enabled ? deps.llm : { ...deps.llm, apiKey: undefined },
    );
    const draftDecisions = pitches.map((p) => {
      const name = toPitch.find((b) => b.id === p.brandId)?.name ?? p.brandId;
      return p.source === "nemotron" ? `${name}: drafted by ${p.model}.` : `${name}: template draft${p.note ? ` (${p.note})` : ""}.`;
    });
    const nemotronCount = pitches.filter((p) => p.source === "nemotron").length;
    finish(
      "draft",
      nemotronCount ? `${nemotronCount} of ${pitches.length} pitches drafted by Nemotron from evidence only.` : `${pitches.length} template pitches drafted from evidence.`,
      draftDecisions,
    );

    const result: AgentResult = {
      input,
      mode: { qloo: qloo.mode, llm: deps.llm.enabled ? "nemotron" : "template", model: deps.llm.enabled ? deps.llm.model : undefined },
      resolution,
      audience,
      brands,
      pitches,
      requestCount: log.total,
    };
    emit({ type: "result", result });
    return result;
  } catch (error) {
    const message =
      error instanceof AgentError
        ? error.message
        : isFatal(error)
          ? "Qloo rejected the API key. Check QLOO_API_KEY (hackathon keys only work on hackathon.api.qloo.com)."
          : error instanceof Error
            ? error.message
            : "Unexpected error";
    emit({ type: "error", message, step: error instanceof AgentError ? error.step : current });
    throw error;
  }
}
