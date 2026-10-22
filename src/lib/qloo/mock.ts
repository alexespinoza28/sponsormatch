import catalog from "./fixtures/catalog.json";
import type {
  AgeBucket,
  QlooCandidate,
  QlooDemographicsRow,
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
import { AGE_BUCKETS } from "./types";

// Mock mode, used when QLOO_API_KEY is unset. It never spawns the harness or
// touches the network. Each tool returns the harness's result envelope
// (schema 1.0-preview.1) with compact results like the real workflows, built
// from the SYNTHETIC fixtures in ./fixtures/catalog.json: every brand, ID and
// score is invented. Scores are deterministic functions of the inputs.

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
const TAG_POOL = catalog.tagPool as CatalogTag[];

/** Names that the mock treats as ambiguous, to exercise needs_input. */
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

const TYPE_URN: Record<string, string> = {
  artist: "urn:entity:artist",
  brand: "urn:entity:brand",
  place: "urn:entity:place",
  locality: "urn:entity:locality",
};

let correlation = 0;

export class MockQlooTools implements QlooTools {
  readonly mode = "mock" as const;
  readonly #onCall?: (record: QlooToolCallRecord) => void;
  readonly #latencyMs: number;
  /** Entities this mock has "resolved", by id, so later calls can use ids. */
  readonly #known = new Map<string, QlooResultEntity>();

  constructor(options: { onCall?: (record: QlooToolCallRecord) => void; latencyMs?: number } = {}) {
    this.#onCall = options.onCall;
    this.#latencyMs = options.latencyMs ?? 0;
    for (const b of BRANDS) this.#known.set(b.entity_id, this.#compactBrand(b));
    // Register ambiguous-name candidates up front so their ids resolve in any instance.
    for (const key of MOCK_AMBIGUOUS_ARTISTS) this.#ambiguousCandidates(key);
  }

  #ambiguousCandidates(key: string): QlooCandidate[] {
    return ["", " (band)", " (singer)"].map((suffix, i) => {
      const e = this.#entity(`artist:${key}:${i}`, `${titleCase(key)}${suffix}`, "urn:entity:artist", 0.9 - i * 0.25, `Synthetic mock artist #${i + 1}`);
      return { id: e.entity_id, name: e.name, type: "urn:entity:artist", popularity: e.popularity, description: e.properties?.short_description };
    });
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
      case "qloo_describe":
        return this.#describe(String(a.entity), a.type as string | undefined);
      case "qloo_find_tags":
        return this.#findTags(String(a.query), Number(a.limit ?? 10));
      case "qloo_audience_demographics":
        return this.#demographics(String(a.entity));
      case "qloo_entity_tags":
        return this.#entityTags(a.entities as string[], Number(a.limit ?? 10));
      case "qloo_recommend":
        return this.#recommend(a as QlooToolInputs["qloo_recommend"]);
      case "qloo_rank":
        return this.#rank(a as QlooToolInputs["qloo_rank"]);
      case "qloo_where_popular":
        return this.#wherePopular(String(a.entity), String(a.within), Number(a.limit ?? 10));
      default:
        return envelope(tool, "error", {
          summary: `${tool} is not implemented in mock mode.`,
          error: { code: "MOCK_UNSUPPORTED", layer: "sponsormatch", retryable: false, recovery: "Set QLOO_API_KEY to use the real harness." },
        });
    }
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

  /** Resolves a name or id the way the harness's native resolver would, for mock purposes. */
  #resolve(input: string, type?: string): { entity?: QlooResultEntity; issue?: QlooResolutionIssue; match?: string } {
    if (UUID.test(input)) {
      const known = this.#known.get(input.toUpperCase());
      return known ? { entity: known, match: "identifier" } : { issue: { input, kind: "not_found", input_kind: "entity", field: "entity" } };
    }
    const key = input.trim().toLowerCase();
    const urnType = type ? TYPE_URN[type] ?? `urn:entity:${type}` : undefined;
    if (type === "brand" || (!type && BRANDS.some((b) => b.name.toLowerCase() === key))) {
      const b = BRANDS.find((x) => x.name.toLowerCase() === key) ?? BRANDS.find((x) => x.name.toLowerCase().includes(key));
      return b
        ? { entity: this.#known.get(b.entity_id)!, match: b.name.toLowerCase() === key ? "exact" : "semantic" }
        : { issue: { input, kind: "not_found", input_kind: "entity", field: "entity", scope: urnType } };
    }
    if ((type ?? "artist") === "artist" && MOCK_AMBIGUOUS_ARTISTS.includes(key)) {
      const candidates = this.#ambiguousCandidates(key);
      return { issue: { input, kind: "ambiguous", input_kind: "entity", field: "entity", scope: urnType, candidates } };
    }
    const subtype = urnType ?? "urn:entity:artist";
    const e = this.#entity(
      `${subtype}:${key}`,
      titleCase(input),
      subtype,
      0.5 + hash01(`pop:${key}`) * 0.49,
      subtype === "urn:entity:place" ? "Live music venue (synthetic mock entity)" : "Synthetic mock entity",
      subtype === "urn:entity:place" ? "Address on file (mock)" : undefined,
    );
    return { entity: e, match: "exact" };
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

  #demographics(input: string): QlooEnvelope {
    const { entity, issue } = this.#resolve(input);
    if (!entity) {
      return envelope("audience_demographics", "needs_input", { summary: "Choose the intended Qloo entity.", resolution: { issues: [issue!] } });
    }
    const id = entity.entity_id;
    const raw = AGE_BUCKETS.map((b) => hash01(`${id}|age|${b}`) - 0.5);
    const mean = raw.reduce((s, v) => s + v, 0) / raw.length;
    const age = Object.fromEntries(AGE_BUCKETS.map((b, i) => [b, r3((raw[i]! - mean) * 1.2)])) as Record<AgeBucket, number>;
    const g = r3((hash01(`${id}|gender`) - 0.5) * 0.5);
    const row: QlooDemographicsRow = { entity_id: id, query: { age, gender: { male: g, female: r3(-g) } } };
    return envelope("audience_demographics", "ok", {
      interpretation: { entity: { input, entityId: id, name: entity.name, match: "identifier" } },
      results: [row],
      result_count: 1,
      provenance: prov("/v2/insights", "demographics-use-case", [
        req("/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": id, take: 10 }),
      ]),
    });
  }

  /** Tag affinities for a set of entities (brands lean toward their own catalog tags). */
  #tagAffinities(ids: string[]): Map<string, number> {
    const seed = [...ids].sort().join(",");
    const own = new Set(ids.flatMap((id) => BRANDS.find((b) => b.entity_id === id)?.tags.map((t) => t.id) ?? []));
    return new Map(TAG_POOL.map((t) => [t.tag_id, r3(Math.min(0.99, 0.3 + hash01(`${seed}|${t.tag_id}`) * 0.55 + (own.has(t.tag_id) ? 0.3 : 0)))]));
  }

  #entityTags(inputs: string[], limit: number): QlooEnvelope {
    const resolved = inputs.map((i) => this.#resolve(i));
    const issues = resolved.flatMap((r) => (r.issue ? [{ ...r.issue, field: "entities" }] : []));
    if (issues.length) return envelope("entity_tags", "needs_input", { summary: "Choose or correct the unresolved Qloo entities.", resolution: { issues } });
    const ids = resolved.map((r) => r.entity!.entity_id);
    const aff = this.#tagAffinities(ids);
    const results: QlooResultTag[] = TAG_POOL.map((t) => ({ id: t.tag_id, name: t.name, type: t.subtype, popularity: r3(0.3 + hash01(t.tag_id) * 0.6), affinity: aff.get(t.tag_id)! }))
      .sort((a, b) => b.affinity! - a.affinity!)
      .slice(0, limit);
    return envelope("entity_tags", "ok", {
      interpretation: { entities: resolved.map((r, i) => ({ input: inputs[i], entityId: r.entity!.entity_id, name: r.entity!.name, match: r.match })) },
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

  #scoreBrands(signalIds: string[], location: string | undefined, explain: boolean, pool: CatalogBrand[]): QlooResultEntity[] {
    const seed = `${[...signalIds].sort().join(",")}|${(location ?? "").toLowerCase()}`;
    const audience = this.#tagAffinities(signalIds);
    const top = new Set([...audience.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id));
    return pool
      .map((b) => {
        const overlap = b.tags.reduce((s, t) => s + (top.has(t.id) ? audience.get(t.id)! : 0), 0);
        const affinity = r3(Math.min(0.995, 0.52 + 0.12 * overlap + 0.22 * hash01(`${seed}|${b.entity_id}`)));
        let explainability: unknown;
        if (explain && signalIds.length) {
          const w = signalIds.map((s) => 0.2 + hash01(`${s}|${b.entity_id}`));
          const total = w.reduce((s, v) => s + v, 0);
          explainability = { "signal.interests.entities": signalIds.map((s, i) => ({ entity_id: s, score: r3(w[i]! / total) })) };
        }
        return this.#compactBrand(b, affinity, explainability);
      })
      .sort((a, b) => b.affinity! - a.affinity!);
  }

  #signalIds(signals: string[] | undefined): { ids: string[]; issues: QlooResolutionIssue[] } {
    const out = (signals ?? []).map((s) => this.#resolve(s));
    return {
      ids: out.flatMap((r) => (r.entity ? [r.entity.entity_id] : [])),
      issues: out.flatMap((r) => (r.issue ? [{ ...r.issue, field: "signals" }] : [])),
    };
  }

  #recommend(a: QlooToolInputs["qloo_recommend"]): QlooEnvelope {
    if (!a.signals?.length && !a.signal_tags?.length && !a.signal_location && !a.demographic) {
      return envelope("recommend", "needs_input", { summary: "Provide at least one entity, tag, location, or demographic taste signal.", resolution: { issues: [] } });
    }
    const signals = this.#signalIds(a.signals);
    const tags = this.#resolveTags(a.include_tags);
    const issues = [...signals.issues, ...tags.issues];
    if (issues.length) return envelope("recommend", "needs_input", { summary: "Choose or correct the unresolved Qloo inputs.", resolution: { issues } });
    const limit = a.limit ?? 10;
    const query: Record<string, unknown> = { "filter.type": TYPE_URN[a.target_type] ?? `urn:entity:${a.target_type}`, take: limit };
    if (signals.ids.length) query["signal.interests.entities"] = signals.ids;
    if (a.signal_location) query["signal.location.query"] = a.signal_location;
    if (tags.ids.length) {
      query["filter.tags"] = tags.ids;
      query["operator.filter.tags"] = a.include_tags_operator ?? "union";
    }
    if (a.explain ?? true) query["feature.explainability"] = true;
    const pool =
      a.target_type !== "brand"
        ? []
        : BRANDS.filter((b) => !tags.ids.length || b.tags.some((t) => tags.ids.some((id) => t.id === id || t.id.startsWith(`${id}:`))));
    const results = this.#scoreBrands(signals.ids, a.signal_location, a.explain ?? true, pool).slice(0, limit);
    return envelope("recommend", results.length ? "ok" : "empty", {
      interpretation: { target_type: query["filter.type"], signal_location: a.signal_location, include_tags: tags.ids },
      results,
      result_count: results.length,
      provenance: prov("/v2/insights", "insights-api-deep-dive", [req("/v2/insights", query)]),
    });
  }

  /** Synthetic heatmap points scattered around a made-up center for the area. */
  #wherePopular(input: string, within: string, limit: number): QlooEnvelope {
    const { entity, issue } = this.#resolve(input);
    if (!entity) return envelope("where_popular", "needs_input", { summary: "Choose the intended Qloo entity.", resolution: { issues: [issue!] } });
    const area = within.trim().toLowerCase();
    const lat0 = 30 + hash01(`lat:${area}`) * 15;
    const lon0 = -122 + hash01(`lon:${area}`) * 40;
    const count = Math.floor(hash01(`${entity.entity_id}|${area}|n`) * 4) + 1;
    const results = Array.from({ length: count }, (_, i) => {
      const k = `${entity.entity_id}|${area}|${i}`;
      return {
        location: { latitude: r3(lat0 + (hash01(`${k}|y`) - 0.5) * 0.08), longitude: r3(lon0 + (hash01(`${k}|x`) - 0.5) * 0.08), geohash: `mock${i}` },
        query: { affinity: r3(0.6 + hash01(`${k}|a`) * 0.39), affinity_rank: r3(hash01(`${k}|r`)), popularity: r3(hash01(`${k}|p`)) },
      };
    })
      .sort((a, b) => b.query.affinity - a.query.affinity)
      .slice(0, limit);
    return envelope("where_popular", "ok", {
      interpretation: { entity: { input, entityId: entity.entity_id, name: entity.name, match: "identifier" }, within },
      results,
      result_count: results.length,
      provenance: prov("/v2/insights", "heatmaps-use-case", [
        req("/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": entity.entity_id, "filter.location.query": within, take: limit }),
      ]),
    });
  }

  #rank(a: QlooToolInputs["qloo_rank"]): QlooEnvelope {
    if (!a.signals?.length && !a.signal_location && !a.demographic) {
      return envelope("rank", "needs_input", { summary: "Ranking requires an entity, location, or demographic signal.", resolution: { issues: [] } });
    }
    const options = a.options.map((o) => ({ o, r: this.#resolve(o, a.option_type) }));
    const signals = this.#signalIds(a.signals);
    const issues = [...options.flatMap(({ r }) => (r.issue ? [{ ...r.issue, field: "options" }] : [])), ...signals.issues];
    if (issues.length) return envelope("rank", "needs_input", { summary: "Choose or correct the unresolved ranking inputs.", resolution: { issues } });
    const ids = options.map(({ r }) => r.entity!.entity_id);
    const pool = BRANDS.filter((b) => ids.includes(b.entity_id));
    const results = this.#scoreBrands(signals.ids, a.signal_location, false, pool);
    const query: Record<string, unknown> = {
      "filter.type": TYPE_URN[a.option_type] ?? `urn:entity:${a.option_type}`,
      "filter.results.entities": ids,
      take: ids.length,
      ...(signals.ids.length ? { "signal.interests.entities": signals.ids } : {}),
      ...(a.signal_location ? { "signal.location.query": a.signal_location } : {}),
    };
    return envelope("rank", results.length ? "ok" : "empty", {
      interpretation: { option_type: query["filter.type"], options: options.map(({ o, r }) => ({ input: o, entityId: r.entity!.entity_id, name: r.entity!.name, match: r.match })) },
      results,
      result_count: results.length,
      provenance: prov("/v2/insights", "insights-api-deep-dive", [req("/v2/insights", query)]),
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
