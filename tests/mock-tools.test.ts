import { describe, expect, it } from "vitest";
import { MOCK_AMBIGUOUS_ARTISTS, MockQlooTools, fakeUuid, hash01 } from "@/lib/qloo/mock";
import {
  explainabilityScores,
  interpretedEntity,
  issueCandidates,
  resolutionIssues,
  resultDemographics,
  resultEntities,
  resultTags,
} from "@/lib/qloo/normalize";
import type { QlooToolCallRecord } from "@/lib/qloo/types";

describe("MockQlooTools", () => {
  it("hash helpers are deterministic and well-formed", () => {
    expect(hash01("a")).toBe(hash01("a"));
    expect(hash01("a")).not.toBe(hash01("b"));
    expect(fakeUuid("x")).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-A[0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it("returns harness-shaped describe envelopes and records calls", async () => {
    const records: QlooToolCallRecord[] = [];
    const mock = new MockQlooTools({ onCall: (r) => records.push(r) });
    const env = await mock.call("qloo_describe", { entity: "khruangbin", type: "artist" });
    expect(env).toMatchObject({ schema_version: "1.0-preview.1", operation: "describe", status: "ok" });
    expect(env.execution.transport).toBe("mcp");
    expect(interpretedEntity(env)!.name).toBe("Khruangbin");
    expect(resultEntities(env)[0]!.subtype).toBe("urn:entity:artist");
    expect(records[0]).toMatchObject({ tool: "qloo_describe", status: "ok" });
    expect(records[0]!.requests![0]!.path).toBe("/search");
  });

  it("answers ambiguous artists with needs_input and candidates", async () => {
    const env = await new MockQlooTools().call("qloo_describe", { entity: "Phoenix", type: "artist" });
    expect(MOCK_AMBIGUOUS_ARTISTS).toContain("phoenix");
    expect(env.status).toBe("needs_input");
    const [issue] = resolutionIssues(env);
    expect(issue!.kind).toBe("ambiguous");
    expect(issueCandidates(issue!)).toHaveLength(3);
  });

  it("resolves ids it handed out earlier (identifier match)", async () => {
    const mock = new MockQlooTools();
    const first = interpretedEntity(await mock.call("qloo_describe", { entity: "Leon Bridges", type: "artist" }))!;
    const again = await mock.call("qloo_describe", { entity: first.entityId, type: "artist" });
    expect(interpretedEntity(again)).toMatchObject({ entityId: first.entityId, match: "identifier" });
  });

  it("recommends brands deterministically with affinity and explainability", async () => {
    const mock = new MockQlooTools();
    const a = interpretedEntity(await mock.call("qloo_describe", { entity: "A Band", type: "artist" }))!.entityId;
    const args = { target_type: "brand" as const, signals: [a], signal_location: "Santa Barbara", explain: true, limit: 10 };
    const r1 = resultEntities(await mock.call("qloo_recommend", args));
    const r2 = resultEntities(await mock.call("qloo_recommend", args));
    expect(r1.map((e) => e.entity_id)).toEqual(r2.map((e) => e.entity_id));
    expect(r1).toHaveLength(10);
    const aff = r1.map((e) => e.affinity!);
    expect([...aff].sort((x, y) => y - x)).toEqual(aff);
    expect([...explainabilityScores(r1[0]!).keys()]).toEqual([a]);
  });

  it("filters by include_tags (taxonomy children) and reports unknown tags as needs_input", async () => {
    const mock = new MockQlooTools();
    const env = await mock.call("qloo_recommend", { target_type: "brand", signals: ["Someone"], include_tags: ["urn:tag:genre:brand:fashion"] });
    const brands = resultEntities(env);
    expect(brands.length).toBeGreaterThan(0);
    const bad = await mock.call("qloo_recommend", { target_type: "brand", signals: ["Someone"], include_tags: ["zzz"] });
    expect(bad.status).toBe("needs_input");
    expect(resolutionIssues(bad)[0]).toMatchObject({ input_kind: "tag", kind: "not_found" });
    expect((await mock.call("qloo_recommend", { target_type: "brand" })).status).toBe("needs_input");
  });

  it("ranks named brands and flags unknown ones", async () => {
    const mock = new MockQlooTools();
    const ok = await mock.call("qloo_rank", { options: ["Lumen Audio", "Voltway EV"], option_type: "brand", signals: ["Someone"] });
    expect(resultEntities(ok).map((e) => e.name).sort()).toEqual(["Lumen Audio", "Voltway EV"]);
    const bad = await mock.call("qloo_rank", { options: ["Lumen Audio", "Nope Corp"], option_type: "brand", signals: ["Someone"] });
    expect(bad.status).toBe("needs_input");
    expect(resolutionIssues(bad).map((i) => i.input)).toEqual(["Nope Corp"]);
  });

  it("returns demographics rows, entity tags, tag search and hotspots", async () => {
    const mock = new MockQlooTools();
    const demo = resultDemographics(await mock.call("qloo_audience_demographics", { entity: "Someone" }));
    expect(Object.keys(demo[0]!.query.age)).toHaveLength(6);
    const tags = resultTags(await mock.call("qloo_entity_tags", { entities: ["Someone"], limit: 5 }));
    expect(tags).toHaveLength(5);
    expect(tags.every((t) => typeof t.affinity === "number")).toBe(true);
    const found = resultTags(await mock.call("qloo_find_tags", { query: "footwear" }));
    expect(found[0]!.id).toBe("urn:tag:genre:brand:fashion:footwear");
    const hot = await mock.call("qloo_where_popular", { entity: "Lumen Audio", entity_type: "brand", within: "Santa Barbara", limit: 3 });
    expect(hot.status).toBe("ok");
    expect((hot.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("reports unsupported tools as error envelopes", async () => {
    const env = await new MockQlooTools().call("qloo_trends", { entities: ["x"], entity_type: "brand", start_date: "2026-01-01", end_date: "2026-02-01" });
    expect(env.error).toMatchObject({ code: "MOCK_UNSUPPORTED", retryable: false });
  });
});
