import { describe, expect, it } from "vitest";
import { parseTrends, tasteOverlap } from "@/lib/optimizer/parse";
import { MOCK_AMBIGUOUS_ARTISTS, MockQlooTools, fakeUuid, hash01 } from "@/lib/qloo/mock";
import { explainabilityScores, interpretedEntity, issueCandidates, resolutionIssues, resultEntities, resultTags } from "@/lib/qloo/normalize";
import type { QlooToolCallRecord } from "@/lib/qloo/types";

async function artistId(mock: MockQlooTools, name: string): Promise<string> {
  return interpretedEntity(await mock.call("qloo_describe", { entity: name, type: "artist" }))!.entityId;
}

describe("MockQlooTools", () => {
  it("hash helpers are deterministic and well-formed", () => {
    expect(hash01("a")).toBe(hash01("a"));
    expect(hash01("a")).not.toBe(hash01("b"));
    expect(fakeUuid("x")).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-A[0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it("answers qloo_capabilities like the live key: ready, all 9 operations", async () => {
    const env = await new MockQlooTools().call("qloo_capabilities", {});
    expect(env.status).toBe("ok");
    expect(env.adapter).toMatchObject({ ready: true });
    expect((env.adapter as { supported_operation_ids: string[] }).supported_operation_ids).toHaveLength(9);
  });

  it("returns harness-shaped describe envelopes and records calls", async () => {
    const records: QlooToolCallRecord[] = [];
    const mock = new MockQlooTools({ onCall: (r) => records.push(r) });
    const env = await mock.call("qloo_describe", { entity: "khruangbin", type: "artist" });
    expect(env).toMatchObject({ schema_version: "1.0-preview.1", operation: "describe", status: "ok" });
    expect(interpretedEntity(env)!.name).toBe("Khruangbin");
    expect(resultEntities(env)[0]!.subtype).toBe("urn:entity:artist");
    expect(records[0]).toMatchObject({ tool: "qloo_describe", status: "ok" });
    expect(records[0]!.requests![0]!.path).toBe("/search");
  });

  it("answers ambiguous artists with needs_input and candidates", async () => {
    const env = await new MockQlooTools().call("qloo_describe", { entity: "Phoenix", type: "artist" });
    expect(MOCK_AMBIGUOUS_ARTISTS).toContain("phoenix");
    expect(env.status).toBe("needs_input");
    expect(issueCandidates(resolutionIssues(env)[0]!)).toHaveLength(3);
  });

  it("mirrors the live API: a bare act name in signals is needs_input (artist vs person); its ID works", async () => {
    const mock = new MockQlooTools();
    const byName = await mock.call("qloo_recommend", { target_type: "brand", signals: ["Leon Bridges"], signal_location: "Los Angeles" });
    expect(byName.status).toBe("needs_input");
    const cands = resolutionIssues(byName)[0]!.candidates!;
    expect(cands.map((c) => c.type)).toEqual(["urn:entity:artist", "urn:entity:person"]);
    expect(Object.keys(cands[0]!).sort()).toEqual(["id", "name", "popularity", "type"]);
    const id = await artistId(mock, "Leon Bridges");
    expect(cands[0]!.id).toBe(id);
    const ok = await mock.call("qloo_recommend", { target_type: "brand", signals: [id], signal_location: "Los Angeles", limit: 5 });
    expect(ok.status).toBe("ok");
    const brands = resultEntities(ok);
    expect(brands).toHaveLength(5);
    for (const b of brands) {
      expect(Object.keys(b).sort()).toEqual(["affinity", "entity_id", "explainability", "name", "popularity", "properties", "subtype", "type"]);
      expect([...explainabilityScores(b).keys()]).toEqual([id]);
    }
  });

  it("ranks options typed by option_type and scores lineups consistently", async () => {
    const mock = new MockQlooTools();
    const a = await artistId(mock, "Khruangbin");
    const b = await artistId(mock, "Men I Trust");
    const r1 = await mock.call("qloo_rank", { options: ["Tidewater Cold Brew", "Lumen Audio"], option_type: "brand", signals: [a, b], signal_location: "Santa Barbara" });
    const r2 = await mock.call("qloo_rank", { options: ["Tidewater Cold Brew", "Lumen Audio"], option_type: "brand", signals: [b, a], signal_location: "Santa Barbara" });
    expect(resultEntities(r1).map((e) => e.affinity)).toEqual(resultEntities(r2).map((e) => e.affinity));
    expect(resultEntities(r1).every((e) => e.explainability === undefined)).toBe(true);
    const artists = await mock.call("qloo_rank", { options: ["Phoenix", "Cuco"], option_type: "artist", signals: [resultEntities(r1)[0]!.entity_id] });
    expect(artists.status).toBe("needs_input");
    expect(resolutionIssues(artists).map((i) => i.input)).toEqual(["Phoenix"]);
  });

  it("returns per-entity tags, trends series and head-to-head comparisons", async () => {
    const mock = new MockQlooTools({ today: new Date("2026-10-22T12:00:00Z") });
    const a = await artistId(mock, "Khruangbin");
    const b = await artistId(mock, "Cuco");
    const tags = resultTags(await mock.call("qloo_entity_tags", { entities: [a], limit: 5 }));
    expect(tags).toHaveLength(5);
    expect(tags.every((t) => typeof t.affinity === "number")).toBe(true);
    const old = await mock.call("qloo_trends", { entities: [a, b], entity_type: "artist", start_date: "2026-01-01", end_date: "2026-06-30", limit: 20 });
    const series = old.series as Array<{ points: Array<{ date: string; population_rank: unknown }> }>;
    expect(series[0]!.points).toHaveLength(20);
    expect(series[0]!.points[0]!.date > series[0]!.points[1]!.date).toBe(true); // newest first
    expect(typeof series[0]!.points[0]!.population_rank).toBe("string");
    expect(parseTrends(old).size).toBe(2);
    const recent = await mock.call("qloo_trends", { entities: [a], entity_type: "artist", start_date: "2026-07-24", end_date: "2026-10-22" });
    expect((recent.series as Array<{ points: unknown[] }>)[0]!.points).toEqual([]);
    const cmp = await mock.call("qloo_compare_audiences", { group_a: [a], group_b: [b], target_type: "brand", limit: 20 });
    expect(Object.keys(cmp.results as object).sort()).toEqual(["a", "b", "matchEntities", "tags"]);
    expect((cmp.results as { matchEntities: unknown[] }).matchEntities).toEqual([]);
    const t = tasteOverlap(cmp);
    expect(t.layout).toBe("parsed");
    expect(t.shared).toHaveLength(20);
    expect((await mock.call("qloo_compare_audiences", { group_a: ["Mitski"], group_b: [b] })).status).toBe("needs_input");
  });

  it("reports unsupported tools as error envelopes", async () => {
    const env = await new MockQlooTools().call("qloo_where_popular", { entity: "x", within: "Santa Barbara" });
    expect(env.error).toMatchObject({ code: "MOCK_UNSUPPORTED", retryable: false });
  });
});
