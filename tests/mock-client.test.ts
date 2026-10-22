import { describe, expect, it } from "vitest";
import { MockQlooClient, fakeUuid, hash01 } from "@/lib/qloo/mock";
import { entityAffinity, entityExplainability, insightDemographics, insightEntities, insightTags, searchResults, tagAffinity } from "@/lib/qloo/normalize";
import type { QlooRequestRecord } from "@/lib/qloo/types";

describe("MockQlooClient", () => {
  it("hash helpers are deterministic and well-formed", () => {
    expect(hash01("a")).toBe(hash01("a"));
    expect(hash01("a")).not.toBe(hash01("b"));
    expect(fakeUuid("x")).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-A[0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it("returns documented /search shapes and records requests", async () => {
    const records: QlooRequestRecord[] = [];
    const mock = new MockQlooClient({ onRequest: (r) => records.push(r) });
    const res = await mock.search({ query: "khruangbin", types: ["urn:entity:artist"], take: 5 });
    const [first] = searchResults(res);
    expect(first!.name).toBe("Khruangbin");
    expect(first!.subtype).toBe("urn:entity:artist");
    expect(records[0]).toMatchObject({ method: "GET", path: "/search", query: { query: "khruangbin", types: "urn:entity:artist" } });
  });

  it("ranks brands deterministically with affinity and explainability", async () => {
    const mock = new MockQlooClient();
    const q = { "filter.type": "urn:entity:brand", "signal.interests.entities": ["A", "B"], "feature.explainability": true, take: 10 };
    const a = insightEntities(await mock.insights(q));
    const b = insightEntities(await new MockQlooClient().insights(q));
    expect(a.map((e) => e.entity_id)).toEqual(b.map((e) => e.entity_id));
    expect(a).toHaveLength(10);
    const affinities = a.map((e) => entityAffinity(e)!);
    expect([...affinities].sort((x, y) => y - x)).toEqual(affinities);
    expect(affinities.every((v) => v > 0 && v < 1)).toBe(true);
    const explain = entityExplainability(a[0]!);
    expect([...explain.keys()].sort()).toEqual(["A", "B"]);
    expect([...explain.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 1);
  });

  it("honors filter.tags (with taxonomy children), filter.results.entities and empty signals", async () => {
    const mock = new MockQlooClient();
    const filtered = insightEntities(
      await mock.insights({ "filter.type": "urn:entity:brand", "signal.interests.entities": ["A"], "filter.tags": ["urn:tag:genre:brand:fashion"] }),
    );
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((e) => (e.tags ?? []).some((t) => t.id.startsWith("urn:tag:genre:brand:fashion")))).toBe(true);
    const only = insightEntities(
      await mock.insights({ "filter.type": "urn:entity:brand", "signal.interests.entities": ["A"], "filter.results.entities": [filtered[0]!.entity_id] }),
    );
    expect(only.map((e) => e.entity_id)).toEqual([filtered[0]!.entity_id]);
    expect(insightEntities(await mock.insights({ "filter.type": "urn:entity:brand" }))).toEqual([]);
  });

  it("returns per-entity demographics and localized taste tags", async () => {
    const mock = new MockQlooClient();
    const demo = insightDemographics(await mock.insights({ "filter.type": "urn:demographics", "signal.interests.entities": ["A", "B"] }));
    expect(demo.map((d) => d.entity_id)).toEqual(["A", "B"]);
    expect(Object.keys(demo[0]!.query.age)).toHaveLength(6);
    const here = insightTags(await mock.insights({ "filter.type": "urn:tag", "signal.interests.entities": ["A"], "signal.location.query": "Santa Barbara", take: 5 }));
    const there = insightTags(await mock.insights({ "filter.type": "urn:tag", "signal.interests.entities": ["A"], "signal.location.query": "Fresno", take: 5 }));
    expect(here).toHaveLength(5);
    expect(here.every((t) => tagAffinity(t) !== undefined)).toBe(true);
    expect(here.map((t) => t.tag_id)).not.toEqual(there.map((t) => t.tag_id));
  });

  it("finds local places for a brand inside a mock locality", async () => {
    const mock = new MockQlooClient();
    const loc = searchResults(await mock.search({ query: "Santa Barbara", types: ["urn:entity:locality"] }))[0]!;
    const brands = insightEntities(await mock.insights({ "filter.type": "urn:entity:brand", "signal.interests.entities": ["A"], take: 16 }));
    let found = 0;
    for (const b of brands) {
      const places = insightEntities(
        await mock.insights({ "filter.type": "urn:entity:place", "filter.references_brand": [b.entity_id], "filter.location": loc.entity_id }),
      );
      for (const p of places) expect(p.properties?.address).toContain("Santa Barbara");
      found += places.length;
    }
    expect(found).toBeGreaterThan(0);
  });

  it("searches brand tags by keyword", async () => {
    const tags = insightTags(await new MockQlooClient().tags({ "filter.query": "footwear", "filter.parents.types": ["urn:entity:brand"] }));
    expect(tags[0]!.tag_id).toBe("urn:tag:genre:brand:fashion:footwear");
  });
});
