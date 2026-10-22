import catalog from "./fixtures/catalog.json";
import { serializeQuery } from "./client";
import type {
  AgeBucket,
  QlooClient,
  QlooDemographicsRow,
  QlooEntity,
  QlooInsightsResponse,
  QlooQuery,
  QlooRequestRecord,
  QlooSearchResponse,
  QlooTag,
  QlooTagsResponse,
} from "./types";
import { AGE_BUCKETS } from "./types";

// Mock mode, used when QLOO_API_KEY is unset. It never touches the network.
// Responses are built from the synthetic fixtures in ./fixtures/catalog.json
// and returned in the same envelopes the real endpoints document, so the
// agent, evidence logic and UI run unchanged. Scores are deterministic
// functions of the request, so the same event always yields the same result.

const BRANDS = catalog.brands as QlooEntity[];
const TAG_POOL = catalog.tagPool as QlooTag[];

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

function titleCase(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w.length > 3 || /^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function list(value: string | undefined): string[] {
  return value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

function r2(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface MockQlooClientOptions {
  onRequest?: (record: QlooRequestRecord) => void;
  /** Artificial latency so the UI's step timeline is visible in demos. */
  latencyMs?: number;
}

export class MockQlooClient implements QlooClient {
  readonly mode = "mock" as const;
  readonly #onRequest?: (record: QlooRequestRecord) => void;
  readonly #latencyMs: number;
  /** Mock localities created by /search so later location filters can name them. */
  readonly #localities = new Map<string, string>();
  /** Mock entity names by id, for demographics rows and explainability. */
  readonly #names = new Map<string, string>();

  constructor(options: MockQlooClientOptions = {}) {
    this.#onRequest = options.onRequest;
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async search(query: QlooQuery): Promise<QlooSearchResponse> {
    const q = serializeQuery(query);
    await this.#record("/search", q);
    const text = (q.query ?? "").trim();
    const types = list(q.types);
    const type = types[0] ?? "urn:entity:artist";
    if (!text) return { success: true, duration: 3, results: [] };
    const take = Math.min(Number(q.take ?? 5) || 5, 10);
    const key = text.toLowerCase();
    const name = titleCase(text);
    let results: QlooEntity[];

    if (type === "urn:entity:locality") {
      const id = fakeUuid(`locality:${key}`);
      this.#localities.set(id, name);
      results = [
        {
          name,
          entity_id: id,
          type: "urn:entity",
          subtype: "urn:entity:locality",
          popularity: r2(0.6 + hash01(key) * 0.35),
          tags: [{ id: "urn:tag:genre:locality:city", name: "City", type: "urn:tag:genre:locality" }],
        },
      ];
    } else if (type === "urn:entity:place") {
      const address = q["filter.address"];
      const id = fakeUuid(`place:${key}`);
      results = [
        {
          name,
          entity_id: id,
          type: "urn:entity",
          subtype: "urn:entity:place",
          popularity: r2(0.5 + hash01(`p${key}`) * 0.45),
          properties: {
            address: address ? `${100 + Math.floor(hash01(key) * 1800)} Main St, ${address}` : "Address on file",
            short_description: "Live music venue (synthetic mock entity).",
          },
          tags: [{ id: "urn:tag:category:place:music_venue", name: "Music Venue", type: "urn:tag:category:place" }],
        },
      ];
    } else if (type === "urn:entity:brand") {
      results = BRANDS.filter((b) => b.name.toLowerCase().includes(key)).slice(0, take);
    } else {
      const id = fakeUuid(`artist:${key}`);
      results = [
        {
          name,
          entity_id: id,
          type: "urn:entity",
          subtype: "urn:entity:artist",
          popularity: r2(0.55 + hash01(`a${key}`) * 0.44),
          disambiguation: "Synthetic mock artist",
          tags: this.#pickTags(`artist:${key}`, 4).map((t) => ({ id: t.tag_id!, name: t.name, type: t.subtype })),
        },
        {
          name: `${name} Tribute Band`,
          entity_id: fakeUuid(`artist:${key}:tribute`),
          type: "urn:entity",
          subtype: "urn:entity:artist",
          popularity: r2(0.05 + hash01(`t${key}`) * 0.2),
          disambiguation: "Synthetic mock alternative",
        },
      ];
    }
    for (const r of results) this.#names.set(r.entity_id, r.name);
    return { success: true, duration: 4, results: results.slice(0, take) };
  }

  async tags(query: QlooQuery): Promise<QlooTagsResponse> {
    const q = serializeQuery(query);
    await this.#record("/v2/tags", q);
    const text = (q["filter.query"] ?? "").toLowerCase().trim();
    const words = text.split(/[^a-z]+/).filter((w) => w.length > 2);
    const parents = list(q["filter.parents.types"]);
    const take = Math.min(Number(q.take ?? 10) || 10, 50);
    const matches = TAG_POOL.filter((t) => !parents.length || (t.types ?? []).some((p) => parents.includes(p)))
      .map((t) => {
        const hay = `${t.name} ${t.tag_id}`.toLowerCase().replace(/_/g, " ");
        const score = words.reduce((s, w) => s + (hay.includes(w) || hay.includes(w.replace(/s$/, "")) ? 1 : 0), 0);
        return { t, score };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
      .slice(0, take)
      .map((m) => m.t);
    return { success: true, duration: 6, results: { tags: matches } };
  }

  async insights(query: QlooQuery): Promise<QlooInsightsResponse> {
    const q = serializeQuery(query);
    await this.#record("/v2/insights", q);
    const type = q["filter.type"];
    const signals = list(q["signal.interests.entities"]);
    const take = Math.min(Number(q.take ?? 20) || 20, 50);
    switch (type) {
      case "urn:demographics":
        return { success: true, duration: 41, results: { demographics: signals.map((id) => this.#demographics(id)) } };
      case "urn:tag":
        return { success: true, duration: 37, results: { tags: this.#tasteTags(q, signals, take) } };
      case "urn:entity:brand":
        return this.#brands(q, signals, take);
      case "urn:entity:place":
        return { success: true, duration: 52, results: { entities: this.#places(q, signals, take) } };
      default:
        return { success: true, duration: 10, results: { entities: [] } };
    }
  }

  // ---------------------------------------------------------------------------

  async #record(path: string, query: Record<string, string>): Promise<void> {
    this.#onRequest?.({ method: "GET", path, query, status: 200, durationMs: this.#latencyMs });
    if (this.#latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
  }

  #signalSeed(q: Record<string, string>, signals: string[]): string {
    const loc = q["signal.location"] ?? q["signal.location.query"] ?? "";
    return `${[...signals].sort().join(",")}|${loc.toLowerCase()}`;
  }

  #pickTags(seed: string, n: number): QlooTag[] {
    return [...TAG_POOL]
      .map((t) => ({ t, k: hash01(`${seed}|${t.tag_id}`) }))
      .sort((a, b) => b.k - a.k)
      .slice(0, n)
      .map((x) => x.t);
  }

  /** Audience tag affinities: deterministic per signal set (and location). */
  #tasteTags(q: Record<string, string>, signals: string[], take: number): QlooTag[] {
    const seed = this.#signalSeed(q, signals);
    if (!signals.length && !q["signal.location"] && !q["signal.location.query"]) return [];
    return TAG_POOL.map((t) => ({ ...t, query: { affinity: r2(0.35 + hash01(`${seed}|${t.tag_id}`) * 0.64) } }))
      .sort((a, b) => (b.query.affinity ?? 0) - (a.query.affinity ?? 0))
      .slice(0, take);
  }

  #demographics(entityId: string): QlooDemographicsRow {
    const raw = AGE_BUCKETS.map((b) => hash01(`${entityId}|age|${b}`) - 0.5);
    const mean = raw.reduce((s, v) => s + v, 0) / raw.length;
    const age = Object.fromEntries(AGE_BUCKETS.map((b, i) => [b, r2((raw[i]! - mean) * 1.2)])) as Record<
      AgeBucket,
      number
    >;
    const g = r2((hash01(`${entityId}|gender`) - 0.5) * 0.5);
    return { entity_id: entityId, query: { age, gender: { male: g, female: r2(-g) } } };
  }

  #brands(q: Record<string, string>, signals: string[], take: number): QlooInsightsResponse {
    if (!signals.length && !q["signal.interests.tags"] && !q["signal.location"] && !q["signal.location.query"]) {
      return { success: true, duration: 12, results: { entities: [] } };
    }
    const seed = this.#signalSeed(q, signals);
    const audienceTags = new Map(this.#tasteTags(q, signals, 12).map((t) => [t.tag_id!, t.query?.affinity ?? 0]));
    const include = list(q["filter.tags"]);
    const only = list(q["filter.results.entities"]);
    const exclude = new Set(list(q["filter.exclude.entities"]));
    const explain = q["feature.explainability"] === "true";

    const scored = BRANDS.filter((b) => !only.length || only.includes(b.entity_id))
      .filter((b) => !exclude.has(b.entity_id))
      .filter((b) => !include.length || (b.tags ?? []).some((t) => include.some((inc) => t.id === inc || t.id.startsWith(`${inc}:`))))
      .map((b) => {
        const overlap = (b.tags ?? []).reduce((s, t) => s + (audienceTags.get(t.id) ?? 0), 0);
        const affinity = Math.min(0.995, 0.52 + 0.12 * overlap + 0.22 * hash01(`${seed}|${b.entity_id}`));
        const entity: QlooEntity = structuredClone(b);
        entity.query = { affinity: r2(affinity) };
        if (explain && signals.length) {
          const weights = signals.map((s) => 0.2 + hash01(`${s}|${b.entity_id}`));
          const total = weights.reduce((s, w) => s + w, 0);
          entity.query.explainability = {
            "signal.interests.entities": signals.map((s, i) => ({ entity_id: s, score: r2(weights[i]! / total) })),
          };
        }
        return entity;
      })
      .sort((a, b) => (b.query?.affinity ?? 0) - (a.query?.affinity ?? 0))
      .slice(0, take);

    return {
      success: true,
      duration: 58,
      results: { entities: scored },
      ...(explain ? { query: { explainability: { note: "aggregate explainability omitted in mock" } } } : {}),
    };
  }

  #places(q: Record<string, string>, signals: string[], take: number): QlooEntity[] {
    const brandIds = list(q["filter.references_brand"]);
    const locId = q["filter.location"];
    const city = (locId && this.#localities.get(locId)) || q["filter.location.query"] || "the area";
    const seed = this.#signalSeed(q, signals);
    const out: QlooEntity[] = [];
    for (const brandId of brandIds) {
      const brand = BRANDS.find((b) => b.entity_id === brandId);
      if (!brand) continue;
      const count = Math.floor(hash01(`${brandId}|${city}|count`) * 4); // 0..3 local locations
      for (let i = 0; i < count; i += 1) {
        const hood = catalog.neighborhoods[Math.floor(hash01(`${brandId}|${i}|hood`) * catalog.neighborhoods.length)];
        const street = catalog.streets[Math.floor(hash01(`${brandId}|${i}|st`) * catalog.streets.length)];
        out.push({
          name: `${brand.name} - ${hood}`,
          entity_id: fakeUuid(`place:${brandId}:${city}:${i}`),
          type: "urn:entity",
          subtype: "urn:entity:place",
          properties: {
            address: `${100 + Math.floor(hash01(`${brandId}|${i}|no`) * 1800)} ${street}, ${city}`,
            business_rating: r2(3.6 + hash01(`${brandId}|${i}|rating`) * 1.3),
          },
          popularity: r2(0.3 + hash01(`${brandId}|${i}|pop`) * 0.6),
          query: { affinity: r2(0.5 + hash01(`${seed}|${brandId}|${i}`) * 0.48) },
        });
      }
    }
    return out.sort((a, b) => (b.query?.affinity ?? 0) - (a.query?.affinity ?? 0)).slice(0, take);
  }
}
