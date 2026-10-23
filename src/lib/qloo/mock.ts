import catalog from "./fixtures/catalog.json";
import type {
  QlooCandidate,
  QlooEnvelope,
  QlooProvenanceRequest,
  QlooResolutionIssue,
  QlooResultEntity,
  QlooResultTag,
  QlooStatus,
  QlooToolCallRecord,
  QlooToolInputs,
  QlooToolName,
  QlooTools,
} from "./types";
import { QLOO_TOOL_NAMES } from "./types";

// Mock mode, used when QLOO_API_KEY is unset. It never spawns the harness or
// touches the network. Each tool returns the harness's result envelope
// (schema 1.0-preview.1) with compact results like the real workflows. All
// data is SYNTHETIC: the brands in ./fixtures/catalog.json are fictional, and
// every ID and score is a deterministic function of the inputs.
//
// To keep the optimizer's behavior meaningful offline, every entity gets a
// synthetic taste vector over the catalog's tag pool. Affinity, tag profiles,
// audience comparisons and explainability are all derived from those
// vectors, so swapping an act changes every score consistently.
//
// The mock mirrors behavior confirmed in the Oct 22 live test: a bare artist
// name passed in `signals` (no type scope) comes back as needs_input with an
// artist and a person candidate, so callers must resolve once and pass IDs.

interface CatalogBrand {
  name: string;
  entity_id: string;
  subtype: string;
  properties: { short_description: string };
  popularity: number;
  tags: Array<{ id: string; name: string; type: string }>;
}
interface CatalogTag {
  tag_id: string;
  name: string;
  subtype: string;
}

const BRANDS = catalog.brands as CatalogBrand[];
/** Brand-genre tags plus synthetic music/lifestyle tags, all invented. */
const TAG_POOL = [...(catalog.tagPool as CatalogTag[]), ...(catalog.tasteTags as CatalogTag[])];
const TAG_IDS = TAG_POOL.map((t) => t.tag_id);

/** Names that the mock treats as ambiguous among artists, to exercise needs_input. */
export const MOCK_AMBIGUOUS_ARTISTS = ["phoenix", "low", "america", "bush"];

export function hash01(input: string): number {
  // FNV-1a 32-bit, mapped to [0, 1).
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

export function fakeUuid(seed: string): string {
  const hex = Array.from({ length: 4 }, (_, i) =>
    Math.floor(hash01(`${seed}#${i}`) * 0x1_0000_0000)
      .toString(16)
      .padStart(8, "0"),
  )
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-A${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function titleCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w.length > 3 || /^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

const TYPE_URN: Record<string, string> = {
  artist: "urn:entity:artist",
  brand: "urn:entity:brand",
  place: "urn:entity:place",
  locality: "urn:entity:locality",
  person: "urn:entity:person",
};

function centeredCosine(a: number[], b: number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

let correlation = 0;

/** Trend data lags: the live API returned no points for a window ending today (Oct 22 probe). */
export const TRENDS_LAG_DAYS = 100;

export class MockQlooTools implements QlooTools {
  readonly mode = "mock" as const;
  readonly #onCall?: (record: QlooToolCallRecord) => void;
  readonly #latencyMs: number;
  /** Entities this mock has "resolved", by id, so later calls can use ids. */
  readonly #known = new Map<string, QlooResultEntity>();
  readonly #vectors = new Map<string, number[]>();

  readonly #today: Date;

  constructor(options: { onCall?: (record: QlooToolCallRecord) => void; latencyMs?: number; today?: Date } = {}) {
    this.#onCall = options.onCall;
    this.#latencyMs = options.latencyMs ?? 0;
    this.#today = options.today ?? new Date();
    for (const b of BRANDS) this.#known.set(b.entity_id, this.#compactBrand(b));
    for (const key of MOCK_AMBIGUOUS_ARTISTS) this.#ambiguousCandidates(key);
  }

  async call<T extends QlooToolName>(tool: T, args: QlooToolInputs[T]): Promise<QlooEnvelope> {
    if (this.#latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
    const env = this.#dispatch(tool, args as Record<string, unknown>);
    this.#onCall?.({
      tool,
      args: args as Record<string, unknown>,
      status: env.status,
      summary: env.summary,
      errorCode: env.error?.code,
      durationMs: this.#latencyMs,
      requests: env.provenance?.requests,
      attempts: 1,
    });
    return env;
  }

  // ---------------------------------------------------------------------------

  #dispatch(tool: QlooToolName, a: Record<string, unknown>): QlooEnvelope {
    switch (tool) {
      case "qloo_capabilities":
        return this.#capabilities();
      case "qloo_describe":
        return this.#describe(String(a.entity), a.type as string | undefined);
      case "qloo_find_tags":
        return this.#findTags(String(a.query), Number(a.limit ?? 10));
      case "qloo_entity_tags":
        return this.#entityTags(a.entities as string[], Number(a.limit ?? 10));
      case "qloo_recommend":
        return this.#recommend(a as QlooToolInputs["qloo_recommend"]);
      case "qloo_rank":
        return this.#rank(a as QlooToolInputs["qloo_rank"]);
      case "qloo_compare_audiences":
        return this.#compare(a as QlooToolInputs["qloo_compare_audiences"]);
      case "qloo_trends":
        return this.#trends(a as QlooToolInputs["qloo_trends"]);
      default:
        return envelope(tool, "error", {
          summary: `${tool} is not implemented in mock mode.`,
          error: { code: "MOCK_UNSUPPORTED", layer: "sponsormatch", retryable: false, recovery: "Set QLOO_API_KEY to use the real harness." },
        });
    }
  }

  #capabilities(): QlooEnvelope {
    const ops = QLOO_TOOL_NAMES.filter((t) => t !== "qloo_capabilities").map((t) => t.replace(/^qloo_/, ""));
    return {
      ...envelope("capabilities", "ok", {}),
      adapter: { ready: true, supported_operation_ids: ops },
      contract_version: "1.0.0",
    };
  }

  #compactBrand(b: CatalogBrand, affinity?: number, explainability?: unknown): QlooResultEntity {
    return {
      entity_id: b.entity_id,
      name: b.name,
      type: "urn:entity",
      subtype: b.subtype,
      popularity: b.popularity,
      ...(affinity !== undefined ? { affinity } : {}),
      ...(explainability !== undefined ? { explainability } : {}),
      properties: { short_description: b.properties.short_description },
    };
  }

  #ambiguousCandidates(key: string): QlooCandidate[] {
    return ["", " (band)", " (singer)"].map((suffix, i) => {
      const e = this.#entity(`artist:${key}:${i}`, `${titleCase(key)}${suffix}`, "urn:entity:artist", 0.9 - i * 0.25, `Synthetic mock artist #${i + 1}`);
      return { id: e.entity_id, name: e.name, type: "urn:entity:artist", popularity: e.popularity, description: e.properties?.short_description };
    });
  }

  #entity(seed: string, name: string, subtype: string, popularity: number, description: string, address?: string): QlooResultEntity {
    const id = fakeUuid(seed);
    const e: QlooResultEntity = {
      entity_id: id,
      name,
      type: "urn:entity",
      subtype,
      popularity: r3(popularity),
      properties: { short_description: description, ...(address ? { address } : {}) },
    };
    this.#known.set(id, e);
    return e;
  }

  #typedEntity(input: string, subtype: string): QlooResultEntity {
    const key = input.trim().toLowerCase();
    const place = subtype === "urn:entity:place";
    return this.#entity(
      `${subtype}:${key}`,
      titleCase(input),
      subtype,
      0.5 + hash01(`pop:${key}`) * 0.49,
      place ? "Live music venue (synthetic mock entity)" : subtype === "urn:entity:brand" ? "Synthetic mock brand" : "Synthetic mock entity",
      place ? "Address on file (mock)" : undefined,
    );
  }

  /** Resolves a name or id the way the harness's native resolver would, for mock purposes. */
  #resolve(input: string, type?: string): { entity?: QlooResultEntity; issue?: QlooResolutionIssue; match?: string } {
    if (UUID.test(input)) {
      const known = this.#known.get(input.toUpperCase());
      return known ? { entity: known, match: "identifier" } : { issue: { input, kind: "not_found", input_kind: "entity", field: "entity" } };
    }
    const key = input.trim().toLowerCase();
    if (!key) return { issue: { input, kind: "not_found", input_kind: "entity", field: "entity" } };
    const urnType = type ? TYPE_URN[type] ?? `urn:entity:${type}` : undefined;
    const catalogBrand = BRANDS.find((x) => x.name.toLowerCase() === key);
    if (catalogBrand && (!type || type === "brand")) return { entity: this.#known.get(catalogBrand.entity_id)!, match: "exact" };
    if (type === "brand") return { entity: this.#typedEntity(input, "urn:entity:brand"), match: "exact" };
    if (MOCK_AMBIGUOUS_ARTISTS.includes(key) && (!type || type === "artist")) {
      return { issue: { input, kind: "ambiguous", input_kind: "entity", field: "entity", scope: urnType, candidates: this.#ambiguousCandidates(key) } };
    }
    if (!type) {
      // Untyped names (e.g. in `signals`): like the live API, an act's name
      // matches both an artist and a person, so ask for the intended one.
      const artist = this.#typedEntity(input, "urn:entity:artist");
      const person = this.#entity(`urn:entity:person:${key}`, titleCase(input), "urn:entity:person", 0.3 + hash01(`person:${key}`) * 0.3, "Synthetic mock person");
      return {
        issue: {
          input,
          kind: "ambiguous",
          input_kind: "entity",
          field: "entity",
          candidates: [artist, person].map((e) => ({ id: e.entity_id, type: e.subtype, name: e.name, popularity: e.popularity })),
        },
      };
    }
    return { entity: this.#typedEntity(input, urnType!), match: "exact" };
  }

  /** Synthetic taste vector over the tag pool. Brands lean toward their catalog tags. */
  #vector(id: string): number[] {
    const cached = this.#vectors.get(id);
    if (cached) return cached;
    const own = new Set(BRANDS.find((b) => b.entity_id === id)?.tags.map((t) => t.id) ?? []);
    // Acts and venues center on two music/lifestyle tags plus one brand-genre tag.
    const brandTags = (catalog.tagPool as CatalogTag[]).length;
    const isBrand = this.#known.get(id)?.subtype === "urn:entity:brand";
    const core = new Set(
      [0, 1, 2].map((k) =>
        isBrand || k === 2
          ? Math.floor(hash01(`${id}|core${k}`) * TAG_IDS.length)
          : brandTags + Math.floor(hash01(`${id}|core${k}`) * (TAG_IDS.length - brandTags)),
      ),
    );
    const v = TAG_IDS.map((t, i) => 0.3 * hash01(`${id}|v|${t}`) + (core.has(i) ? 0.7 : 0) + (own.has(t) ? 0.8 : 0));
    this.#vectors.set(id, v);
    return v;
  }

  #meanVector(ids: string[]): number[] {
    const out = TAG_IDS.map(() => 0);
    for (const id of ids) this.#vector(id).forEach((x, i) => (out[i]! += x / ids.length));
    return out;
  }

  /** Synthetic affinity of one entity for an audience defined by signal entities (and a location). */
  #affinity(optionId: string, signalIds: string[], location?: string): number {
    if (!signalIds.length) return r3(0.4 + 0.5 * (this.#known.get(optionId)?.popularity ?? 0.5));
    const cc = centeredCosine(this.#vector(optionId), this.#meanVector(signalIds));
    const noise = hash01(`${optionId}|${[...signalIds].sort().join(",")}|${(location ?? "").toLowerCase()}`) - 0.5;
    return r3(clamp(0.5 + 0.42 * cc + 0.06 * noise, 0.02, 0.99));
  }

  #explain(optionId: string, signalIds: string[]): unknown {
    const w = signalIds.map((s) => Math.max(0.05, 0.5 + 0.5 * centeredCosine(this.#vector(optionId), this.#vector(s))));
    const total = w.reduce((s, v) => s + v, 0);
    return { "signal.interests.entities": signalIds.map((s, i) => ({ entity_id: s, score: r3(w[i]! / total) })) };
  }

  #describe(input: string, type?: string): QlooEnvelope {
    const { entity, issue, match } = this.#resolve(input, type);
    const requests = [req("/search", { query: input, ...(type ? { types: TYPE_URN[type] ?? `urn:entity:${type}` } : {}), take: 5 })];
    if (issue) {
      return envelope("describe", "needs_input", {
        summary: "Choose the intended Qloo entity.",
        resolution: { issues: [{ ...issue, field: "entity" }] },
        provenance: prov("/search", "get-search", requests),
      });
    }
    requests.push(req("/entities", { entity_ids: entity!.entity_id }));
    return envelope("describe", "ok", {
      interpretation: { entity: { input, entityId: entity!.entity_id, name: entity!.name, type: entity!.subtype, match } },
      results: [entity],
      result_count: 1,
      provenance: prov("/entities", "get-entities", requests),
    });
  }

  #findTags(query: string, limit: number): QlooEnvelope {
    const words = query.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
    const results: QlooResultTag[] = TAG_POOL.map((t) => {
      const hay = `${t.name} ${t.tag_id}`.toLowerCase().replace(/_/g, " ");
      return { t, score: words.reduce((s, w) => s + (hay.includes(w) || hay.includes(w.replace(/s$/, "")) ? 1 : 0), 0) };
    })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
      .slice(0, limit)
      .map(({ t }) => ({ id: t.tag_id, name: t.name, type: t.subtype, popularity: r3(0.3 + hash01(t.tag_id) * 0.6) }));
    return envelope("find_tags", results.length ? "ok" : "empty", {
      interpretation: { query, semantic: true },
      results,
      result_count: results.length,
      provenance: prov("/v2/tags", "get-tags-1", [req("/v2/tags", { "filter.query": query, "feature.semantic_search": true, take: limit })]),
    });
  }

  #resolveMany(inputs: string[] | undefined, field: string, type?: string) {
    const out = (inputs ?? []).map((input) => ({ input, ...this.#resolve(input, type) }));
    return {
      resolved: out.flatMap((r) => (r.entity ? [{ input: r.input, entityId: r.entity.entity_id, name: r.entity.name, match: r.match }] : [])),
      issues: out.flatMap((r) => (r.issue ? [{ ...r.issue, field }] : [])),
    };
  }

  #entityTags(inputs: string[], limit: number): QlooEnvelope {
    const r = this.#resolveMany(inputs, "entities");
    if (r.issues.length) return envelope("entity_tags", "needs_input", { summary: "Choose or correct the unresolved Qloo entities.", resolution: { issues: r.issues } });
    const ids = r.resolved.map((e) => e.entityId);
    const v = this.#meanVector(ids);
    const max = Math.max(...v);
    const results: QlooResultTag[] = TAG_POOL.map((t, i) => ({
      id: t.tag_id,
      name: t.name,
      type: t.subtype,
      popularity: r3(0.3 + hash01(t.tag_id) * 0.6),
      affinity: r3(clamp(0.15 + 0.8 * (v[i]! / max), 0, 0.99)),
    }))
      .sort((a, b) => b.affinity - a.affinity)
      .slice(0, limit);
    return envelope("entity_tags", "ok", {
      interpretation: { entities: r.resolved },
      results,
      result_count: results.length,
      provenance: prov("/v2/insights", "taste-analysis", [req("/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": ids, take: limit })]),
    });
  }

  #resolveTags(inputs: string[] | undefined): { ids: string[]; issues: QlooResolutionIssue[] } {
    const ids: string[] = [];
    const issues: QlooResolutionIssue[] = [];
    for (const input of inputs ?? []) {
      if (input.startsWith("urn:tag:")) {
        ids.push(input);
        continue;
      }
      const matches = TAG_POOL.filter((t) => t.name.toLowerCase().includes(input.toLowerCase()) || t.tag_id.includes(input.toLowerCase().replace(/\s+/g, "_")));
      if (matches.length === 1) ids.push(matches[0]!.tag_id);
      else
        issues.push({
          input,
          kind: matches.length ? "ambiguous" : "not_found",
          input_kind: "tag",
          field: "include_tags",
          scope: "urn:entity:brand",
          purpose: "include_filter",
          candidates: matches.slice(0, 5).map((t) => ({ id: t.tag_id, name: t.name, type: t.subtype })),
        });
    }
    return { ids, issues };
  }

  #recommend(a: QlooToolInputs["qloo_recommend"]): QlooEnvelope {
    if (!a.signals?.length && !a.signal_tags?.length && !a.signal_location && !a.demographic) {
      return envelope("recommend", "needs_input", { summary: "Provide at least one entity, tag, location, or demographic taste signal.", resolution: { issues: [] } });
    }
    const signals = this.#resolveMany(a.signals, "signals");
    const tags = this.#resolveTags(a.include_tags);
    const issues = [...signals.issues, ...tags.issues];
    if (issues.length) return envelope("recommend", "needs_input", { summary: "Choose or correct the unresolved Qloo inputs.", resolution: { issues } });
    const ids = signals.resolved.map((s) => s.entityId);
    const limit = a.limit ?? 10;
    const explain = a.explain ?? true;
    const query: Record<string, unknown> = { "filter.type": TYPE_URN[a.target_type] ?? `urn:entity:${a.target_type}`, take: limit };
    if (ids.length) query["signal.interests.entities"] = ids;
    if (a.signal_location) query["signal.location.query"] = a.signal_location;
    if (tags.ids.length) {
      query["filter.tags"] = tags.ids;
      query["operator.filter.tags"] = a.include_tags_operator ?? "union";
    }
    if (explain) query["feature.explainability"] = true;
    const pool =
      a.target_type !== "brand"
        ? []
        : BRANDS.filter((b) => !tags.ids.length || b.tags.some((t) => tags.ids.some((id) => t.id === id || t.id.startsWith(`${id}:`))));
    const results = pool
      .map((b) => this.#compactBrand(b, this.#affinity(b.entity_id, ids, a.signal_location), explain && ids.length ? this.#explain(b.entity_id, ids) : undefined))
      .sort((x, y) => y.affinity! - x.affinity!)
      .slice(0, limit);
    return envelope("recommend", results.length ? "ok" : "empty", {
      interpretation: { target_type: query["filter.type"], signals: signals.resolved, signal_location: a.signal_location, include_tags: tags.ids },
      results,
      result_count: results.length,
      provenance: prov("/v2/insights", "insights-api-deep-dive", [req("/v2/insights", query)]),
    });
  }

  #rank(a: QlooToolInputs["qloo_rank"]): QlooEnvelope {
    if (!a.signals?.length && !a.signal_location && !a.demographic) {
      return envelope("rank", "needs_input", { summary: "Ranking requires an entity, location, or demographic signal.", resolution: { issues: [] } });
    }
    const options = this.#resolveMany(a.options, "options", a.option_type);
    const signals = this.#resolveMany(a.signals, "signals");
    const issues = [...options.issues, ...signals.issues];
    if (issues.length) return envelope("rank", "needs_input", { summary: "Choose or correct the unresolved ranking inputs.", resolution: { issues } });
    const ids = options.resolved.map((o) => o.entityId);
    const signalIds = signals.resolved.map((s) => s.entityId);
    const results = [...new Set(ids)]
      .map((id) => {
        // qloo_rank does not request explainability, so results carry none.
        const e = { ...this.#known.get(id)!, affinity: this.#affinity(id, signalIds, a.signal_location) };
        delete e.explainability;
        return e;
      })
      .sort((x, y) => y.affinity - x.affinity);
    const query: Record<string, unknown> = {
      "filter.type": TYPE_URN[a.option_type] ?? `urn:entity:${a.option_type}`,
      "filter.results.entities": ids,
      take: ids.length,
      ...(signalIds.length ? { "signal.interests.entities": signalIds } : {}),
      ...(a.signal_location ? { "signal.location.query": a.signal_location } : {}),
    };
    return envelope("rank", "ok", {
      interpretation: { option_type: query["filter.type"], options: options.resolved, signals: signals.resolved },
      results,
      result_count: results.length,
      provenance: prov("/v2/insights", "insights-api-deep-dive", [req("/v2/insights", query)]),
    });
  }

  /**
   * Audience comparison in the layout seen live on Oct 22: `results` is an
   * object {tags, a, b, matchEntities}. `tags` are shared tastes with a
   * similarity score in query.score; `a` and `b` are each side's own tags with
   * query.count. target_type is accepted but, as live, produces no entity rows.
   */
  #compare(a: QlooToolInputs["qloo_compare_audiences"]): QlooEnvelope {
    const ga = this.#resolveMany(a.group_a, "group_a");
    const gb = this.#resolveMany(a.group_b, "group_b");
    const issues = [...ga.issues, ...gb.issues];
    if (issues.length) return envelope("compare_audiences", "needs_input", { summary: "Choose or correct the unresolved comparison inputs.", resolution: { issues } });
    const aIds = ga.resolved.map((e) => e.entityId);
    const bIds = gb.resolved.map((e) => e.entityId);
    const limit = a.limit ?? 10;
    const query: Record<string, unknown> = { "a.signal.interests.entities": aIds, "b.signal.interests.entities": bIds, take: limit };
    if (a.target_type) query["filter.type"] = TYPE_URN[a.target_type] ?? `urn:entity:${a.target_type}`;
    const va = this.#meanVector(aIds);
    const vb = this.#meanVector(bIds);
    const maxA = Math.max(...va);
    const maxB = Math.max(...vb);
    const tag = (t: CatalogTag, extra: Record<string, unknown>, q: Record<string, unknown>) => ({
      tag_id: t.tag_id,
      name: t.name,
      type: "urn:tag",
      subtype: t.subtype,
      entity_id: t.tag_id,
      popularity: r3(0.3 + hash01(t.tag_id) * 0.6),
      ...extra,
      query: q,
    });
    const rows = TAG_POOL.map((t, i) => ({ t, x: va[i]! / maxA, y: vb[i]! / maxB }));
    const shared = [...rows]
      .sort((p, q) => Math.min(q.x, q.y) - Math.min(p.x, p.y))
      .slice(0, limit)
      .map(({ t, x, y }) => tag(t, {}, { score: r3(clamp(0.5 + 0.49 * Math.min(x, y), 0, 0.99)), "a.signal.interests.entities": aIds, "b.signal.interests.entities": bIds }));
    const side = (key: "x" | "y") =>
      [...rows]
        .sort((p, q) => q[key] - p[key])
        .slice(0, limit)
        .map((r) => tag(r.t, {}, { count: Math.max(1, Math.round(r[key] * 40)) }));
    return envelope("compare_audiences", "ok", {
      interpretation: { group_a: ga.resolved, group_b: gb.resolved, target_type: query["filter.type"] },
      results: { tags: shared, a: side("x"), b: side("y"), matchEntities: [] },
      provenance: prov("/v2/analysis/compare", "analysis-compare", [req("/v2/analysis/compare", query)]),
    });
  }

  /**
   * Trends in the layout seen live on Oct 22: series[].points are weekly,
   * newest first, capped by `limit`, with population_rank as a string. Like
   * the live API, data lags: weeks after `today - TRENDS_LAG_DAYS` have no
   * points, so a window ending today comes back with points: [].
   */
  #trends(a: QlooToolInputs["qloo_trends"]): QlooEnvelope {
    const r = this.#resolveMany(a.entities, "entities", a.entity_type);
    if (r.issues.length) return envelope("trends", "needs_input", { summary: "Choose or correct the unresolved Qloo entities.", resolution: { issues: r.issues } });
    const day = 86_400_000;
    const start = Date.parse(`${a.start_date}T00:00:00Z`);
    const lastData = this.#today.getTime() - TRENDS_LAG_DAYS * day;
    const end = Math.min(Date.parse(`${a.end_date}T00:00:00Z`), lastData);
    const limit = a.limit ?? 10;
    const series = r.resolved.map((e) => {
      const slope = (hash01(`${e.entityId}|slope`) - 0.5) * 0.0006; // percentile change per day
      const base = 0.6 + hash01(`${e.entityId}|base`) * 0.35;
      const points: Array<Record<string, unknown>> = [];
      for (let t = end, i = 0; t >= start && points.length < limit; t -= 7 * day, i += 1) {
        const pct = clamp(base + slope * ((t - lastData) / day), 0.01, 0.999);
        const prev = clamp(base + slope * ((t - 7 * day - lastData) / day), 0.01, 0.999);
        const rank = Math.round((1 - pct) * 50_000) + 1;
        const prevRank = Math.round((1 - prev) * 50_000) + 1;
        points.push({
          date: new Date(t).toISOString().slice(0, 10),
          population_percentile: r3(pct),
          population_rank: String(rank),
          population_rank_velocity: prevRank - rank,
          velocity_fold_change: r3(prev > 0 ? pct / prev : 1),
          population_percent_delta: r3(prev > 0 ? (pct - prev) / prev : 0),
        });
      }
      return { entity: { input: e.input, entityId: e.entityId, name: e.name, type: TYPE_URN[a.entity_type], match: "identifier" }, points };
    });
    return envelope("trends", "ok", {
      interpretation: { entity_type: TYPE_URN[a.entity_type], start_date: a.start_date, end_date: a.end_date },
      series,
      result_count: series.length,
      provenance: prov(
        "/v2/trending",
        "get-trending",
        r.resolved.map((e) => req("/v2/trending", { "filter.type": TYPE_URN[a.entity_type], "filter.start_date": a.start_date, "filter.end_date": a.end_date, "signal.interests.entities": e.entityId, take: limit })),
      ),
    });
  }
}

function req(path: string, query: Record<string, unknown>): QlooProvenanceRequest {
  return { method: "GET", path, query };
}

function prov(endpoint: string, docs: string, requests: QlooProvenanceRequest[]): QlooEnvelope["provenance"] {
  return { source: "Qloo API (mock)", endpoint, documentation: `https://docs.qloo.com/reference/${docs}`, transport: "mock", requests };
}

function envelope(operation: string, status: QlooStatus, payload: Partial<QlooEnvelope>): QlooEnvelope {
  correlation += 1;
  return {
    schema_version: "1.0-preview.1",
    operation: operation.replace(/^qloo_/, ""),
    status,
    results: [],
    result_count: 0,
    ...payload,
    execution: { transport: "mcp", transport_name: "SponsorMatch mock (no harness)", correlation_id: `mock-${correlation}`, duration_ms: 0 },
  } as QlooEnvelope;
}
