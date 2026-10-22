import { describe, expect, it } from "vitest";
import { AgentError, RequestLog, runAgent, validateInput } from "@/lib/agent/pipeline";
import type { AgentEvent } from "@/lib/agent/types";
import { MockQlooClient } from "@/lib/qloo/mock";
import type { QlooClient } from "@/lib/qloo/types";

function setup(qloo?: QlooClient) {
  const log = new RequestLog();
  const events: AgentEvent[] = [];
  return {
    log,
    events,
    deps: {
      qloo: qloo ?? new MockQlooClient({ onRequest: log.push }),
      log,
      emit: (e: AgentEvent) => events.push(e),
      llm: { enabled: false, model: "m" },
    },
  };
}

describe("validateInput", () => {
  it("cleans and caps input", () => {
    expect(validateInput({ performers: "A\n B ,C", city: " Santa Barbara ", date: "2026-11-14", venue: "" })).toEqual({
      performers: ["A", "B", "C"],
      city: "Santa Barbara",
      date: "2026-11-14",
      venue: undefined,
      category: undefined,
    });
    expect(validateInput({ performers: ["1", "2", "3", "4", "5", "6"], city: "X" }).performers).toHaveLength(5);
  });

  it("rejects missing performers, city or bad dates", () => {
    expect(() => validateInput({ performers: [], city: "X" })).toThrow(AgentError);
    expect(() => validateInput({ performers: ["A"] })).toThrow("city");
    expect(() => validateInput({ performers: ["A"], city: "X", date: "11/14/2026" })).toThrow("YYYY-MM-DD");
  });
});

describe("runAgent (mock Qloo, template pitches)", () => {
  it("runs resolve -> profile -> rank -> explain -> draft and returns evidence-backed pitches", async () => {
    const { deps, events } = setup();
    const result = await runAgent(
      { performers: ["Khruangbin", "Leon Bridges"], venue: "Santa Barbara Bowl", city: "Santa Barbara", date: "2026-11-14" },
      deps,
    );
    const done = events.filter((e) => e.type === "step" && e.status === "done").map((e) => (e as { step: string }).step);
    expect(done).toEqual(["resolve", "profile", "rank", "explain", "draft"]);
    expect(events.at(-1)!.type).toBe("result");

    expect(result.mode).toEqual({ qloo: "mock", llm: "template", model: undefined });
    expect(result.resolution.performers.map((p) => p.name)).toEqual(["Khruangbin", "Leon Bridges"]);
    expect(result.resolution.venue?.name).toBe("Santa Barbara Bowl");
    expect(result.resolution.locality?.name).toBe("Santa Barbara");
    expect(result.audience.tags.length).toBeGreaterThan(0);
    expect(result.audience.demographics).toBeDefined();
    expect(result.brands).toHaveLength(6);
    expect(result.brands.map((b) => b.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    const fits = result.brands.map((b) => b.sponsorFit);
    expect([...fits].sort((a, b) => b - a)).toEqual(fits);
    expect(result.brands.every((b) => b.localPresenceChecked && b.demographicAlignment !== undefined)).toBe(true);
    expect(result.brands[0]!.contributors.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Khruangbin", "Leon Bridges", "Santa Barbara Bowl"]),
    );
    expect(result.pitches).toHaveLength(5);
    expect(result.pitches.every((p) => p.source === "template" && p.text.includes("Santa Barbara"))).toBe(true);
    // resolve: 2 artists + locality + venue = 4; profile: 2; rank: 1; explain: 1 + 6 places = 7
    expect(result.requestCount).toBe(14);
    const rankStep = events.find((e) => e.type === "step" && e.step === "rank" && e.status === "done") as { requests: { query: Record<string, string> }[] };
    expect(rankStep.requests[0]!.query).toMatchObject({
      "filter.type": "urn:entity:brand",
      "feature.explainability": "true",
      "signal.location": result.resolution.locality!.id,
    });
  });

  it("applies a sponsor category as filter.tags", async () => {
    const { deps } = setup();
    const result = await runAgent({ performers: ["Khruangbin"], city: "Santa Barbara", category: "footwear" }, deps);
    expect(result.resolution.category?.id).toBe("urn:tag:genre:brand:fashion:footwear");
    expect(result.brands.length).toBeGreaterThan(0);
    expect(result.brands.every((b) => b.brandTags.some((t) => t.id.startsWith("urn:tag:genre:brand:fashion:footwear")))).toBe(true);
  });

  it("relaxes the brand query when the localized query is empty", async () => {
    const mock = new MockQlooClient();
    const qloo: QlooClient = {
      mode: "mock",
      search: (q) => mock.search(q),
      tags: (q) => mock.tags(q),
      insights: async (q) =>
        q["filter.type"] === "urn:entity:brand" && q["signal.location"] ? { success: true, results: { entities: [] } } : mock.insights(q),
    };
    const { deps, events } = setup(qloo);
    const result = await runAgent({ performers: ["Khruangbin"], city: "Santa Barbara" }, deps);
    expect(result.brands.length).toBeGreaterThan(0);
    const rank = events.find((e) => e.type === "step" && e.step === "rank" && e.status === "done") as { decisions: string[] };
    expect(rank.decisions.join(" ")).toContain("relaxing the query");
  });

  it("stops with a clear error when no performer resolves", async () => {
    const mock = new MockQlooClient();
    const qloo: QlooClient = {
      mode: "mock",
      search: async (q) => (q.types?.toString().includes("artist") ? { results: [] } : mock.search(q)),
      tags: (q) => mock.tags(q),
      insights: (q) => mock.insights(q),
    };
    const { deps, events } = setup(qloo);
    await expect(runAgent({ performers: ["Nobody"], city: "X" }, deps)).rejects.toThrow("None of the performers");
    expect(events.at(-1)).toMatchObject({ type: "error", step: "resolve" });
  });
});
