import { describe, expect, it } from "vitest";
import { BudgetedQloo, CallLog } from "@/lib/optimizer/budget";
import { InputError, minimumBudget, parseAct, parseEvent, parseSlot, validateOptimizeInput, validateSponsorInput } from "@/lib/optimizer/input";
import { eventScore, rankEvents, runSponsorRanking, SPONSOR_CALL_CAP } from "@/lib/optimizer/sponsor";
import type { SponsorEvent } from "@/lib/optimizer/types";
import { MockQlooTools } from "@/lib/qloo/mock";

const EVENTS = [
  "Harbor Lights Fest | Khruangbin, Men I Trust | Santa Barbara Bowl | Santa Barbara | 2026-11-14 | $12,000",
  "Desert Sessions Night | Mdou Moctar, Hermanos Gutierrez | The Novo | Los Angeles | 2026-11-21 | $8,000",
  "Soul on State | Leon Bridges | Arlington Theatre | Santa Barbara | 2026-12-05 | $9,500",
  "Surf & Sound | Allah-Las, Cuco | | Santa Ana",
].join("\n");

async function run(raw: Record<string, unknown>) {
  const input = validateSponsorInput(raw);
  const log = new CallLog();
  const qloo = new BudgetedQloo(new MockQlooTools({ onCall: log.push, today: new Date("2026-10-22T12:00:00Z") }), SPONSOR_CALL_CAP);
  const events: SponsorEvent[] = [];
  const result = await runSponsorRanking(input, { qloo, log, emit: (e) => events.push(e), now: new Date("2026-10-22T12:00:00Z") });
  return { result, events, qloo };
}

describe("sponsor-side scoring", () => {
  it("eventScore blends act and venue affinity 75/25 and renormalizes", () => {
    expect(eventScore([0.6, 0.8], 0.4)).toEqual({ score: 0.625, actAffinity: 0.7 });
    expect(eventScore([0.6, 0.8])).toEqual({ score: 0.7, actAffinity: 0.7 });
    expect(eventScore([], 0.4)).toEqual({ score: 0.4, actAffinity: undefined });
    expect(eventScore([])).toEqual({ score: 0 });
  });

  it("rankEvents indexes against the list mean and puts within-budget events first", () => {
    const listing = (name: string, askUsd?: number) => ({ name, acts: ["x"], city: "c", ...(askUsd !== undefined ? { askUsd } : {}) });
    const ranked = rankEvents(
      [
        { listing: listing("A", 20000), score: 0.8, acts: [] },
        { listing: listing("B", 5000), score: 0.6, acts: [] },
        { listing: listing("C"), score: 0.4, acts: [] },
      ],
      10000,
    );
    expect(ranked.map((e) => [e.listing.name, e.rank, e.index, e.withinBudget])).toEqual([
      ["B", 1, 100, true],
      ["C", 2, 67, undefined],
      ["A", 3, 133, false],
    ]);
  });
});

describe("runSponsorRanking (mock Qloo)", () => {
  it("ranks pasted events in a handful of calls and recommends a within-budget pick", async () => {
    const { result, events } = await run({ brand: "Tidewater Cold Brew", budgetUsd: "$10,000", events: EVENTS });
    expect(result.toolCallCount).toBeLessThanOrEqual(6);
    expect(result.events).toHaveLength(4);
    expect(result.events.every((e) => e.score > 0)).toBe(true);
    const top = result.events[0]!;
    expect(top.withinBudget).not.toBe(false);
    expect(result.recommendation!.eventName).toBe(top.listing.name);
    expect(result.events.find((e) => e.listing.name === "Harbor Lights Fest")!.withinBudget).toBe(false);
    expect(result.events.find((e) => e.listing.name === "Surf & Sound")!.venueAffinity).toBeUndefined();
    expect(result.sharedTastes?.layout).toBe("parsed");
    // All acts in one qloo_rank call (one comparable scale), brand passed as an ID.
    const calls = events.flatMap((e) => (e.type === "step" ? (e.calls ?? []) : []));
    const actRanks = calls.filter((c) => c.tool === "qloo_rank" && c.args.option_type === "artist");
    expect(actRanks).toHaveLength(1);
    expect(actRanks[0]!.args.signals).toEqual([result.brand.id]);
    expect(actRanks[0]!.args.signal_location).toBeUndefined();
  });

  it("splits more than 10 acts into anchored qloo_rank calls and stays under the cap", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `Event ${i} | Act ${i}a, Act ${i}b | | City ${i}`).join("\n");
    const { result, events, qloo } = await run({ brand: "Lumen Audio", events: many });
    const calls = events.flatMap((e) => (e.type === "step" ? (e.calls ?? []) : []));
    const actRanks = calls.filter((c) => c.tool === "qloo_rank" && c.args.option_type === "artist");
    expect(actRanks).toHaveLength(2);
    expect((actRanks[1]!.args.options as string[])[0]).toMatch(/^[0-9A-F-]{36}$/); // the anchor, by ID
    expect(result.events.every((e) => e.acts.every((a) => typeof a.affinity === "number" && a.affinity <= 1))).toBe(true);
    expect(qloo.used).toBeLessThanOrEqual(SPONSOR_CALL_CAP);
  });
});

describe("input parsing", () => {
  it("parses acts with unavailable dates, venue lines and event lines", () => {
    expect(parseAct("Khruangbin | not 2026-11-14, 2026-11-21")).toEqual({ name: "Khruangbin", unavailable: ["2026-11-14", "2026-11-21"] });
    expect(parseAct("Cuco (not 2026-12-01)")).toEqual({ name: "Cuco", unavailable: ["2026-12-01"] });
    expect(parseAct("Men I Trust")).toEqual({ name: "Men I Trust", unavailable: [] });
    expect(parseSlot("The Novo | Los Angeles | 2026-11-21")).toEqual({ venue: "The Novo", city: "Los Angeles", date: "2026-11-21" });
    expect(() => parseSlot("The Novo")).toThrow(InputError);
    expect(parseEvent("Fest | A, B | Bowl | SB | 2026-11-14 | $8,500")).toEqual({ name: "Fest", acts: ["A", "B"], venue: "Bowl", city: "SB", date: "2026-11-14", askUsd: 8500 });
    expect(parseEvent("Fest | A | | SB | | 10k").askUsd).toBe(10000);
    expect(() => parseEvent("Fest | | Bowl | SB")).toThrow(/needs acts/);
  });

  it("validates the optimizer request", () => {
    const base = { acts: "A\nB\nC\nD", slots: "Hall | SB | 2026-11-14", brands: "X", billSize: 3, budget: 30 };
    expect(validateOptimizeInput(base)).toMatchObject({ billSize: 3, goal: "sponsor_fit", budget: 30 });
    expect(() => validateOptimizeInput({ ...base, acts: "A\nB\nC" })).toThrow(/at least 4 acts/);
    expect(() => validateOptimizeInput({ ...base, acts: "A\nB\nA\nD" })).toThrow(/twice/);
    expect(() => validateOptimizeInput({ ...base, brands: "" })).toThrow(/target sponsor/);
    expect(() => validateOptimizeInput({ ...base, budget: 100 })).toThrow(/budget/);
    const big = { ...base, acts: "A\nB\nC\nD\nE\nF\nG\nH", brands: "X\nY\nZ", budget: 15 };
    expect(minimumBudget(8, 3)).toBe(18);
    expect(() => validateOptimizeInput(big)).toThrow("at least 18");
    expect(() => validateOptimizeInput({ ...base, acts: "A | not 2026-11-14\nB\nC\nD" })).toThrow(/Draft lineup conflict/);
    expect(validateOptimizeInput({ ...base, pins: { A: "0A1B2C3D-0000-4000-A000-000000000001", B: "bad id!" } }).pins).toEqual({ A: "0A1B2C3D-0000-4000-A000-000000000001" });
  });

  it("validates the sponsor request", () => {
    expect(() => validateSponsorInput({ brand: "X", events: "One | A | | SB" })).toThrow(/at least two/);
    expect(() => validateSponsorInput({ brand: "X", budgetUsd: "lots", events: EVENTS })).toThrow(/dollar/);
    expect(validateSponsorInput({ brand: "X", budgetUsd: "", events: EVENTS }).budgetUsd).toBeUndefined();
  });
});
