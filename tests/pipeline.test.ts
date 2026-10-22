import { describe, expect, it } from "vitest";
import { AgentError, CallLog, runAgent, validateInput } from "@/lib/agent/pipeline";
import type { AgentEvent, StepEvent } from "@/lib/agent/types";
import { MockQlooTools } from "@/lib/qloo/mock";
import type { QlooEnvelope, QlooToolInputs, QlooToolName, QlooTools } from "@/lib/qloo/types";
import { fixture } from "./helpers";

function setup(qloo?: QlooTools) {
  const log = new CallLog();
  const events: AgentEvent[] = [];
  return {
    events,
    deps: {
      qloo: qloo ?? new MockQlooTools({ onCall: log.push }),
      log,
      emit: (e: AgentEvent) => events.push(e),
      llm: { enabled: false, model: "m" },
    },
    log,
  };
}

/** Wraps the mock so a test can override specific tool calls. */
function wrap(log: CallLog, override: (tool: QlooToolName, args: Record<string, unknown>) => QlooEnvelope | undefined): QlooTools {
  const mock = new MockQlooTools({ onCall: log.push });
  return {
    mode: "mock",
    call: async <T extends QlooToolName>(tool: T, args: QlooToolInputs[T]) => override(tool, args as Record<string, unknown>) ?? mock.call(tool, args),
  };
}

const done = (events: AgentEvent[], step: string) => events.find((e) => e.type === "step" && e.step === step && e.status === "done") as StepEvent;

describe("validateInput", () => {
  it("cleans and caps input, keeps valid pins only", () => {
    expect(
      validateInput({ performers: "A\n B ,C", city: " Santa Barbara ", date: "2026-11-14", venue: "", brands: "X\nY", pins: { A: "0A1B2C3D-0000-4000-A000-000000000001", B: "bad id!" } }),
    ).toEqual({
      performers: ["A", "B", "C"],
      city: "Santa Barbara",
      date: "2026-11-14",
      venue: undefined,
      category: undefined,
      brands: ["X", "Y"],
      pins: { A: "0A1B2C3D-0000-4000-A000-000000000001" },
    });
    expect(validateInput({ performers: ["1", "2", "3", "4", "5", "6"], city: "X" }).performers).toHaveLength(5);
  });

  it("rejects missing performers, city or bad dates", () => {
    expect(() => validateInput({ performers: [], city: "X" })).toThrow(AgentError);
    expect(() => validateInput({ performers: ["A"] })).toThrow("city");
    expect(() => validateInput({ performers: ["A"], city: "X", date: "11/14/2026" })).toThrow("YYYY-MM-DD");
  });
});

describe("runAgent over mock MCP tools", () => {
  it("runs resolve -> profile -> rank -> explain -> draft with MCP tool calls per step", async () => {
    const { deps, events } = setup();
    const result = await runAgent(
      { performers: ["Khruangbin", "Leon Bridges"], venue: "Santa Barbara Bowl", city: "Santa Barbara", date: "2026-11-14" },
      deps,
    );
    const doneSteps = events.filter((e) => e.type === "step" && e.status === "done").map((e) => (e as StepEvent).step);
    expect(doneSteps).toEqual(["resolve", "profile", "rank", "explain", "draft"]);
    expect(events.at(-1)!.type).toBe("result");
    expect(result.mode).toEqual({ qloo: "mock", llm: "template", model: undefined });
    expect(result.resolution.performers.map((p) => p.name)).toEqual(["Khruangbin", "Leon Bridges"]);
    expect(result.resolution.venue?.name).toBe("Santa Barbara Bowl");
    expect(result.resolution.locality?.name).toBe("Santa Barbara");
    expect(result.audience.tags.length).toBeGreaterThan(0);
    expect(result.audience.demographics).toBeDefined();
    expect(result.brands).toHaveLength(5);
    const fits = result.brands.map((b) => b.sponsorFit);
    expect([...fits].sort((a, b) => b - a)).toEqual(fits);
    expect(result.brands.every((b) => b.brandTagsChecked && b.demographicAlignment !== undefined)).toBe(true);
    expect(result.brands.filter((b) => b.hotspotsChecked)).toHaveLength(3);
    expect(result.brands[0]!.contributors.map((c) => c.name)).toEqual(expect.arrayContaining(["Khruangbin", "Leon Bridges", "Santa Barbara Bowl"]));
    expect(result.pitches).toHaveLength(5);
    expect(result.pitches.every((p) => p.source === "template" && p.text.includes("Santa Barbara"))).toBe(true);
    // resolve 4 (2 artists, city, venue) + profile 3 + rank 1 + explain 5*2 + 3 hotspots
    expect(result.toolCallCount).toBe(21);
    const tools = (step: string) => done(events, step).calls!.map((c) => c.tool);
    expect(tools("resolve")).toEqual(expect.arrayContaining(["qloo_describe"]));
    expect(new Set(tools("profile"))).toEqual(new Set(["qloo_audience_demographics", "qloo_entity_tags"]));
    expect(tools("rank")).toEqual(["qloo_recommend"]);
    expect(done(events, "rank").calls![0]!.args).toMatchObject({ target_type: "brand", signal_location: "Santa Barbara", explain: true, limit: 20 });
    expect(new Set(tools("explain"))).toEqual(new Set(["qloo_entity_tags", "qloo_audience_demographics", "qloo_where_popular"]));
  });

  it("surfaces needs_input candidates, continues with the first, and honors pins", async () => {
    const { deps, events } = setup();
    const result = await runAgent({ performers: ["Phoenix"], city: "Santa Barbara" }, deps);
    const choice = done(events, "resolve").choices![0]!;
    expect(choice).toMatchObject({ field: "performer", input: "Phoenix", kind: "ambiguous" });
    expect(choice.candidates).toHaveLength(3);
    expect(result.resolution.performers[0]).toMatchObject({ id: choice.chosen!.id, match: "agent_pick" });
    expect(result.resolution.choices).toHaveLength(1);

    const pinned = setup();
    const second = choice.candidates[1]!;
    const r2 = await runAgent({ performers: ["Phoenix"], city: "Santa Barbara", pins: { Phoenix: second.id } }, pinned.deps);
    expect(r2.resolution.performers[0]).toMatchObject({ id: second.id, name: second.name, match: "confirmed" });
    expect(r2.resolution.choices).toEqual([]);
  });

  it("applies a sponsor category from qloo_find_tags as include_tags", async () => {
    const { deps, events } = setup();
    const result = await runAgent({ performers: ["Khruangbin"], city: "Santa Barbara", category: "footwear" }, deps);
    expect(result.resolution.category?.id).toBe("urn:tag:genre:brand:fashion:footwear");
    expect(done(events, "rank").calls![0]!.args.include_tags).toEqual(["urn:tag:genre:brand:fashion:footwear"]);
    expect(result.brands.map((b) => b.name)).toEqual(["Arcadia Sneakers"]);
  });

  it("ranks the producer's own brands with qloo_rank and drops unknown names after needs_input", async () => {
    const { deps, events } = setup();
    const result = await runAgent({ performers: ["Khruangbin"], city: "Santa Barbara", brands: ["Lumen Audio", "Nope Corp"] }, deps);
    const rank = done(events, "rank");
    expect(rank.calls!.filter((c) => c.tool === "qloo_rank").map((c) => c.status)).toEqual(["needs_input", "ok"]);
    expect(rank.choices![0]).toMatchObject({ field: "brand", input: "Nope Corp", kind: "not_found" });
    const lumen = result.brands.find((b) => b.name === "Lumen Audio")!;
    expect(["requested", "both"]).toContain(lumen.source);
  });

  it("shows partial/degraded summaries as warnings and still uses the results", async () => {
    const log = new CallLog();
    const qloo = wrap(log, (tool) => (tool === "qloo_recommend" ? fixture<QlooEnvelope>("recommend-brands.json") : undefined));
    const { deps, events } = setup(qloo);
    deps.log = log;
    const result = await runAgent({ performers: ["Khruangbin"], city: "Santa Barbara" }, deps);
    expect(done(events, "rank").warnings).toEqual(
      expect.arrayContaining(["Recommend brands in Santa Barbara (partial): Some results came back.", "Recommend brands in Santa Barbara: signal_location matched a broader area"]),
    );
    expect(result.brands.map((b) => b.name).sort()).toEqual(["Testbrand Coffee", "Testbrand Motors"]);
  });

  it("relaxes the brand query when the localized one is empty", async () => {
    const log = new CallLog();
    const empty = { ...fixture<QlooEnvelope>("recommend-brands.json"), status: "empty", results: [], warnings: undefined } as QlooEnvelope;
    const qloo = wrap(log, (tool, args) => (tool === "qloo_recommend" && args.signal_location ? empty : undefined));
    const { deps, events } = setup(qloo);
    deps.log = log;
    const result = await runAgent({ performers: ["Khruangbin"], city: "Santa Barbara" }, deps);
    expect(result.brands.length).toBeGreaterThan(0);
    expect(done(events, "rank").decisions!.join(" ")).toContain("relaxing the query");
  });

  it("stops the run on QLOO_AUTH", async () => {
    const log = new CallLog();
    const qloo = wrap(log, (tool) => (tool === "qloo_recommend" ? fixture<QlooEnvelope>("error-auth.json") : undefined));
    const { deps, events } = setup(qloo);
    deps.log = log;
    await expect(runAgent({ performers: ["Khruangbin"], city: "Santa Barbara" }, deps)).rejects.toThrow("Qloo rejected");
    expect(events.at(-1)).toMatchObject({ type: "error", step: "rank" });
    expect((events.at(-1) as { message: string }).message).toContain("five minutes");
  });

  it("reports other errors and keeps going where it can", async () => {
    const log = new CallLog();
    const qloo = wrap(log, (tool) => (tool === "qloo_where_popular" ? fixture<QlooEnvelope>("error-rate-limit.json") : undefined));
    const { deps, events } = setup(qloo);
    deps.log = log;
    const result = await runAgent({ performers: ["Khruangbin"], city: "Santa Barbara" }, deps);
    expect(result.brands.length).toBe(5);
    expect(done(events, "explain").decisions!.some((d) => d.includes("failed (QLOO_RATE_LIMIT)"))).toBe(true);
  });

  it("stops with a clear error when no performer resolves", async () => {
    const log = new CallLog();
    const notFound = { ...fixture<QlooEnvelope>("describe-needs-input.json") } as QlooEnvelope;
    notFound.resolution = { issues: [{ input: "Nobody", kind: "not_found", input_kind: "entity", field: "entity" }] };
    const qloo = wrap(log, (tool, args) => (tool === "qloo_describe" && args.type === "artist" ? notFound : undefined));
    const { deps, events } = setup(qloo);
    deps.log = log;
    await expect(runAgent({ performers: ["Nobody"], city: "X" }, deps)).rejects.toThrow("None of the performers");
    expect(events.at(-1)).toMatchObject({ type: "error", step: "resolve" });
  });
});
