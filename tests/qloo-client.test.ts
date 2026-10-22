import { beforeEach, describe, expect, it } from "vitest";
import {
  HttpQlooClient,
  QLOO_HACKATHON_BASE_URL,
  QlooApiError,
  buildUrl,
  resetQlooClientState,
  serializeQuery,
} from "@/lib/qloo/client";
import { createQlooClient } from "@/lib/qloo";
import {
  averageDemographics,
  entityAffinity,
  entityExplainability,
  entityProperty,
  insightDemographics,
  insightEntities,
  insightTags,
  searchResults,
  tagAffinity,
  tagId,
} from "@/lib/qloo/normalize";
import type { QlooEntity, QlooInsightsResponse, QlooSearchResponse, QlooTagsResponse } from "@/lib/qloo/types";
import { fakeFetch, fixture } from "./helpers";

const KEY = "test-key-not-real";
const noSleep = async () => {};

beforeEach(() => resetQlooClientState());

describe("query serialization", () => {
  it("comma-joins arrays, stringifies scalars, drops empty values, sorts keys", () => {
    expect(
      serializeQuery({
        "signal.interests.entities": ["A", "B"],
        "filter.type": "urn:entity:brand",
        take: 20,
        "feature.explainability": true,
        "filter.tags": [],
        "signal.location.query": "",
        unused: undefined,
      }),
    ).toEqual({
      "feature.explainability": "true",
      "filter.type": "urn:entity:brand",
      "signal.interests.entities": "A,B",
      take: "20",
    });
  });

  it("builds URLs on the hackathon host", () => {
    const url = buildUrl(QLOO_HACKATHON_BASE_URL, "/v2/insights", { "filter.type": "urn:tag", take: 5 });
    expect(url.origin).toBe("https://hackathon.api.qloo.com");
    expect(url.pathname).toBe("/v2/insights");
    expect(url.searchParams.get("filter.type")).toBe("urn:tag");
    expect(() => buildUrl(QLOO_HACKATHON_BASE_URL, "/v2/insights?x=1", {})).toThrow();
    expect(() => buildUrl(QLOO_HACKATHON_BASE_URL, "//evil.example/x", {})).toThrow();
  });
});

describe("HttpQlooClient", () => {
  it("sends GET with X-Api-Key to the hackathon base URL and parses /search", async () => {
    const { fetch, calls } = fakeFetch([{ body: fixture("search-artist.json") }]);
    const client = new HttpQlooClient({ apiKey: KEY, fetch, sleep: noSleep });
    const res = await client.search({ query: "The Fixture Tones", types: ["urn:entity:artist"], take: 5 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.toString()).toBe(
      "https://hackathon.api.qloo.com/search?query=The+Fixture+Tones&take=5&types=urn%3Aentity%3Aartist",
    );
    expect(call.init.method).toBe("GET");
    expect((call.init.headers as Record<string, string>)["X-Api-Key"]).toBe(KEY);
    expect((call.init.headers as Record<string, string>).Authorization).toBeUndefined();
    const entities = searchResults(res);
    expect(entities.map((e) => e.name)).toEqual(["The Fixture Tones", "Fixture Tones Revival"]);
  });

  it("parses brand insights: affinity, explainability, properties", async () => {
    const { fetch, calls } = fakeFetch([{ body: fixture("insights-brands.json") }]);
    const client = new HttpQlooClient({ apiKey: KEY, fetch, sleep: noSleep });
    const res = await client.insights({
      "filter.type": "urn:entity:brand",
      "signal.interests.entities": ["0A1B2C3D-0000-4000-A000-000000000001"],
      "signal.location.query": "Santa Barbara",
      "feature.explainability": true,
    });
    expect(calls[0]!.url.pathname).toBe("/v2/insights");
    expect(calls[0]!.url.searchParams.get("feature.explainability")).toBe("true");
    const [motors, coffee] = insightEntities(res);
    expect(entityAffinity(coffee!)).toBe(0.934);
    expect(entityExplainability(coffee!).get("0A1B2C3D-0000-4000-A000-000000000001")).toBe(0.81);
    expect(entityProperty(coffee!, "use_occasions")).toEqual(["morning commutes", "outdoor concerts"]);
    expect(entityExplainability(motors!).size).toBe(0);
  });

  it("parses demographics and taste-tag insights and tag search", async () => {
    const { fetch } = fakeFetch([
      { body: fixture("insights-demographics.json") },
      { body: fixture("insights-tags.json") },
      { body: fixture("tags-search.json") },
    ]);
    const client = new HttpQlooClient({ apiKey: KEY, fetch, sleep: noSleep });
    const demo = insightDemographics(await client.insights({ "filter.type": "urn:demographics", "signal.interests.entities": ["x"] }));
    expect(demo).toHaveLength(2);
    const avg = averageDemographics(demo)!;
    expect(avg.age["25_to_29"]).toBe(0.3);
    expect(avg.gender.male).toBe(-0.02);
    const tags = insightTags(await client.insights({ "filter.type": "urn:tag", "signal.interests.entities": ["x"] }));
    expect(tags.map(tagId)).toContain("urn:tag:adjective:qloo:indie");
    expect(tagAffinity(tags[0]!)).toBe(0.88);
    expect(tagAffinity(tags[3]!)).toBeUndefined();
    const search = insightTags(await client.tags({ "filter.query": "beverage", "filter.parents.types": ["urn:entity:brand"] }));
    expect(search).toHaveLength(2);
  });

  it("does not retry a 401 and blocks later calls without touching the network", async () => {
    const { fetch, calls } = fakeFetch([{ status: 401, body: { message: "No API key found in request" } }]);
    const client = new HttpQlooClient({ apiKey: KEY, fetch, sleep: noSleep, maxAttempts: 3 });
    const err = await client.search({ query: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(QlooApiError);
    expect(err.code).toBe("QLOO_AUTH");
    expect(String(err.message)).not.toContain(KEY);
    expect(calls).toHaveLength(1);
    const again = await client.search({ query: "y" }).catch((e) => e);
    expect(again.code).toBe("QLOO_AUTH_BLOCKED");
    expect(calls).toHaveLength(1);
  });

  it("retries 429 once with bounded backoff, then succeeds", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch([
      { status: 429, body: { message: "Rate limit exceeded" }, headers: { "retry-after": "30" } },
      { body: fixture("search-artist.json") },
    ]);
    const client = new HttpQlooClient({ apiKey: KEY, fetch, sleep: async (ms) => void waits.push(ms) });
    const res = await client.search({ query: "x" });
    expect(searchResults(res)).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it("does not retry 400/403 and surfaces the documented error message", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 403, body: { code: 403, reason: "Forbidden", message: "You do not have permission to access urn:entity:foo" } },
    ]);
    const client = new HttpQlooClient({ apiKey: KEY, fetch, sleep: noSleep });
    const err = await client.insights({ "filter.type": "urn:entity:foo" }).catch((e) => e);
    expect(err.code).toBe("QLOO_FORBIDDEN");
    expect(err.message).toContain("You do not have permission");
    expect(calls).toHaveLength(1);
  });

  it("caches identical GETs server-side", async () => {
    const { fetch, calls } = fakeFetch([{ body: fixture("search-artist.json") }]);
    const records: boolean[] = [];
    const client = new HttpQlooClient({ apiKey: KEY, fetch, sleep: noSleep, onRequest: (r) => records.push(Boolean(r.cached)) });
    await client.search({ query: "same", take: 5 });
    await client.search({ take: 5, query: "same" });
    expect(calls).toHaveLength(1);
    expect(records).toEqual([false, true]);
  });

  it("refuses to construct without a key", () => {
    expect(() => new HttpQlooClient({ apiKey: "  " })).toThrow();
  });
});

describe("createQlooClient", () => {
  it("uses the mock when QLOO_API_KEY is unset or blank, live otherwise", () => {
    expect(createQlooClient({ env: {} }).mode).toBe("mock");
    expect(createQlooClient({ env: { QLOO_API_KEY: "   " } }).mode).toBe("mock");
    expect(createQlooClient({ env: { QLOO_API_KEY: KEY } }).mode).toBe("live");
  });
});

describe("normalization of alternate documented shapes", () => {
  it("reads top-level affinity and brand fields (taxonomy-page layout)", () => {
    const flat = {
      name: "Flat Brand",
      entity_id: "F",
      subtype: "urn:entity:brand",
      affinity: 0.97,
      use_occasions: ["concerts and events"],
      tags: [],
    } as QlooEntity;
    expect(entityAffinity(flat)).toBe(0.97);
    expect(entityProperty(flat, "use_occasions")).toEqual(["concerts and events"]);
  });

  it("tolerates search results nested under results.entities and missing arrays", () => {
    expect(searchResults({ results: { entities: [{ name: "a", entity_id: "1" }] } } as unknown as QlooSearchResponse)).toHaveLength(1);
    expect(insightEntities({ success: true, results: {} } as QlooInsightsResponse)).toEqual([]);
    expect(insightTags({ results: {} } as unknown as QlooTagsResponse)).toEqual([]);
  });
});
