import { describe, expect, it } from "vitest";
import { BUDGET_EXHAUSTED, BudgetedQloo, CallLog } from "@/lib/optimizer/budget";
import { validateOptimizeInput } from "@/lib/optimizer/input";
import { extractJson, interpretReply, legalMoves, type ProposalContext } from "@/lib/optimizer/proposer";
import { runOptimizer, type OptimizerDeps } from "@/lib/optimizer/search";
import type { IterationEvent, OptimizeInput, OptimizerEvent } from "@/lib/optimizer/types";
import { MockQlooTools } from "@/lib/qloo/mock";
import type { QlooEnvelope, QlooToolInputs, QlooToolName, QlooTools } from "@/lib/qloo/types";
import { fakeFetch, fixture } from "./helpers";

const NOW = new Date("2026-10-22T12:00:00Z");

function sample(overrides: Record<string, unknown> = {}): OptimizeInput {
  return validateOptimizeInput({
    acts: "Mdou Moctar\nMen I Trust\nCuco\nTash Sultana\nLeon Bridges\nAllah-Las\nKhruangbin\nHermanos Gutierrez | not 2026-11-21",
    slots: "Santa Barbara Bowl | Santa Barbara | 2026-11-14\nThe Novo | Los Angeles | 2026-11-21",
    brands: "Tidewater Cold Brew\nSaltline Surf Supply",
    billSize: 3,
    goal: "sponsor_fit",
    budget: 40,
    ...overrides,
  });
}

type Override = (tool: QlooToolName, args: Record<string, unknown>, n: number) => QlooEnvelope | undefined;
type Transform = (tool: QlooToolName, args: Record<string, unknown>, env: QlooEnvelope) => QlooEnvelope;

/** Mock tools with an optional per-call override or result transform; counts every call that reaches "Qloo". */
function tools(log: CallLog, override?: Override, transform?: Transform): QlooTools & { reached: number } {
  const mock = new MockQlooTools({ onCall: log.push, today: NOW });
  const t = {
    mode: "mock" as const,
    reached: 0,
    async call<T extends QlooToolName>(tool: T, args: QlooToolInputs[T]) {
      t.reached += 1;
      const o = override?.(tool, args as Record<string, unknown>, t.reached);
      if (o) {
        log.push({ tool, args: args as Record<string, unknown>, status: o.status, durationMs: 0 });
        return o;
      }
      const env = await mock.call(tool, args);
      return transform ? transform(tool, args as Record<string, unknown>, env) : env;
    },
  };
  return t;
}

function setup(input: OptimizeInput, opts: { override?: Override; transform?: Transform; llm?: OptimizerDeps["llm"]; maxIterations?: number } = {}) {
  const log = new CallLog();
  const inner = tools(log, opts.override, opts.transform);
  const qloo = new BudgetedQloo(inner, input.budget);
  const events: OptimizerEvent[] = [];
  const deps: OptimizerDeps = { qloo, log, emit: (e) => events.push(e), llm: opts.llm ?? { enabled: false, model: "m" }, now: NOW, maxIterations: opts.maxIterations };
  return { deps, events, inner, qloo };
}

const decisions = (events: OptimizerEvent[]) => events.filter((e): e is IterationEvent => e.type === "iteration" && e.phase === "decision");

describe("lineup optimizer loop (mock Qloo)", () => {
  it("improves the draft, passes entity IDs into scoring calls, and reports a typical call count", async () => {
    const input = sample();
    const { deps, events, inner } = setup(input);
    const r = await runOptimizer(input, deps);
    expect(r.best.objective).toBeGreaterThan(r.draft.objective);
    expect(r.acceptedMoves.length).toBeGreaterThan(0);
    expect(r.acceptedMoves[0]!.explanation).toMatch(/fit with Tidewater Cold Brew (rises|falls) \d+% \(0\.\d\d -> 0\.\d\d\)/);
    // setup: 2 describe + 1 act rank + 1 venue rank + 8 entity_tags + 2 trends + 1 baseline rank = 15
    expect(r.budget.setup).toBe(15);
    expect(r.budget.used).toBe(inner.reached);
    expect(r.budget.used).toBeGreaterThanOrEqual(20);
    expect(r.budget.used).toBeLessThanOrEqual(30);
    // Every lineup-scoring and comparison call uses entity IDs, never names.
    const uuid = /^[0-9A-F-]{36}$/i;
    const calls = events.flatMap((e) => ("calls" in e && e.calls ? e.calls : []));
    for (const c of calls.filter((x) => x.tool === "qloo_rank" && x.args.option_type === "brand")) {
      expect((c.args.options as string[]).every((s) => uuid.test(s))).toBe(true);
      expect((c.args.signals as string[]).every((s) => uuid.test(s))).toBe(true);
    }
    for (const c of calls.filter((x) => x.tool === "qloo_compare_audiences")) {
      expect([...(c.args.group_a as string[]), ...(c.args.group_b as string[])].every((s) => uuid.test(s))).toBe(true);
    }
    // History: best-so-far never decreases and matches the accepted objectives.
    const bests = r.history.map((h) => h.best);
    expect([...bests].sort((a, b) => a - b)).toEqual(bests);
    expect(r.history.at(-1)!.best).toBe(r.best.objective);
    expect(events.at(-1)!.type).toBe("result");
    expect(r.nextSponsors.length).toBeGreaterThan(0);
    expect(r.nextSponsors.every((s) => s.drivers.length > 0)).toBe(true);
  });

  it("never exceeds the budget, for any budget", async () => {
    for (const budget of [5, 12, 16, 18, 20, 24, 60]) {
      // Built directly: validation would reject budgets below the setup cost.
      const input = { ...sample(), budget };
      const { deps, inner, qloo } = setup(input);
      try {
        const r = await runOptimizer(input, deps);
        expect(r.budget.used).toBeLessThanOrEqual(budget);
      } catch {
        // A budget too small to finish setup is allowed to fail, but not to overspend.
      }
      expect(inner.reached).toBeLessThanOrEqual(budget);
      expect(qloo.used).toBeLessThanOrEqual(budget);
    }
  });

  it("stops the search when the budget runs low and says so", async () => {
    const input = sample({ budget: 21 });
    const { deps, events } = setup(input);
    const r = await runOptimizer(input, deps);
    expect(r.stopReason).toMatch(/budget/i);
    expect(events.find((e) => e.type === "stop")).toBeDefined();
    expect(r.budget.used).toBeLessThanOrEqual(21);
  });

  it("the budget guard refuses calls past the limit without reaching Qloo", async () => {
    const log = new CallLog();
    const inner = tools(log);
    const q = new BudgetedQloo(inner, 1);
    expect((await q.call("qloo_capabilities", {})).status).toBe("ok");
    const refused = await q.call("qloo_capabilities", {});
    expect(refused.error?.code).toBe(BUDGET_EXHAUSTED);
    expect(inner.reached).toBe(1);
  });

  it("terminates when no untried legal move remains", async () => {
    const input = validateOptimizeInput({ acts: "A One\nB Two\nC Three", slots: "Hall | Santa Barbara", brands: "Tidewater Cold Brew", billSize: 2, budget: 60 });
    const { deps } = setup(input);
    const r = await runOptimizer(input, deps);
    expect(r.history.length - 1).toBeLessThanOrEqual(2); // only 2 possible swaps
    expect(r.stopReason).toMatch(/No untried legal moves|rejected|promising/);
  });

  it("respects the iteration cap", async () => {
    const input = sample({ budget: 60 });
    const { deps } = setup(input, { maxIterations: 1 });
    const r = await runOptimizer(input, deps);
    expect(r.history).toHaveLength(2);
    expect(r.stopReason).toMatch(/1-iteration cap/);
  });

  it("never accepts a move without Qloo evidence (rank errors / empty for every candidate)", async () => {
    const input = sample();
    let brandRanks = 0;
    const err = fixture<QlooEnvelope>("error-rate-limit.json");
    const override: Override = (tool, args) => {
      if (tool === "qloo_rank" && args.option_type === "brand") {
        brandRanks += 1;
        if (brandRanks > 1) return brandRanks % 2 ? err : ({ ...err, status: "empty", error: undefined } as QlooEnvelope);
      }
      return undefined;
    };
    const { deps, events } = setup(input, { override });
    const r = await runOptimizer(input, deps);
    expect(r.acceptedMoves).toEqual([]);
    expect(r.best.key).toBe(r.draft.key);
    const d = decisions(events);
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((x) => x.accepted === false && /no Qloo evidence/.test(x.reason!))).toBe(true);
  });

  it("rejects a per-lineup fit gain that the same-scale act/venue ranking contradicts", async () => {
    const input = sample();
    const draftNames = new Set(["Mdou Moctar", "Men I Trust", "Cuco", "Santa Barbara Bowl"]);
    let brandRanks = 0;
    const transform: Transform = (tool, args, env) => {
      if (tool !== "qloo_rank" || !Array.isArray(env.results)) return env;
      const rows = env.results as Array<{ name: string; affinity: number }>;
      if (args.option_type === "artist" || args.option_type === "place") {
        // One shared scale: every draft act/venue clearly above every alternative.
        return { ...env, results: rows.map((r) => ({ ...r, affinity: draftNames.has(r.name) ? 0.9 : 0.1 })) };
      }
      brandRanks += 1;
      // Per-lineup calls after the draft all claim a big fit gain.
      return brandRanks === 1 ? env : { ...env, results: rows.map((r) => ({ ...r, affinity: Math.min(0.99, r.affinity + 0.2) })) };
    };
    const { deps, events } = setup(input, { transform });
    const r = await runOptimizer(input, deps);
    expect(r.acceptedMoves).toEqual([]);
    const d = decisions(events);
    const contradicted = d.filter((x) => /fit gain is not confirmed/.test(x.reason!));
    expect(contradicted.length).toBeGreaterThan(0);
    for (const x of contradicted) {
      expect(x.candidate!.objective).toBeGreaterThan(r.draft.objective);
      expect(x.comparable).toMatchObject({ contradicts: true, inAffinity: 0.1, outAffinity: 0.9 });
      expect(x.tasteOverlap).toBeUndefined(); // no compare call spent on a rejected move
    }
  });

  it("uses compare_audiences as taste evidence only: an unrecognized layout does not block a move", async () => {
    const input = sample();
    const override: Override = (tool) =>
      tool === "qloo_compare_audiences" ? ({ ...fixture<QlooEnvelope>("compare-audiences.json"), results: { weird: true } } as QlooEnvelope) : undefined;
    const { deps, events } = setup(input, { override });
    const r = await runOptimizer(input, deps);
    expect(r.acceptedMoves.length).toBeGreaterThan(0);
    const acc = decisions(events).find((d) => d.accepted)!;
    expect(acc.tasteOverlap).toMatchObject({ layout: "unrecognized" });
    expect(acc.comparable!.contradicts).toBe(false);
  });

  it("shows taste overlap for accepted moves in the live layout", async () => {
    const input = sample();
    const { deps, events } = setup(input);
    const r = await runOptimizer(input, deps);
    const acc = decisions(events).filter((d) => d.accepted);
    expect(acc.length).toBeGreaterThan(0);
    for (const d of acc) {
      expect(d.tasteOverlap!.layout).toBe("parsed");
      expect(d.tasteOverlap!.shared.length).toBeGreaterThan(0);
      expect(d.comparable).toBeDefined();
    }
    expect(r.finalTasteShift?.layout).toBe("parsed");
  });

  it("empty trend series (recent windows) never block a move", async () => {
    const input = sample();
    const transform: Transform = (tool, _args, env) =>
      tool === "qloo_trends" ? { ...env, series: (env.series as Array<{ entity: unknown }>).map((x) => ({ ...x, points: [] })) } : env;
    const { deps, events } = setup(input, { transform });
    const r = await runOptimizer(input, deps);
    expect(r.acts.every((a) => a.momentum === undefined)).toBe(true);
    expect(r.best.parts.momentum).toBeUndefined();
    expect(r.acceptedMoves.length).toBeGreaterThan(0);
    const profile = events.find((e) => e.type === "setup" && e.phase === "profile" && e.status === "done");
    expect(JSON.stringify(profile)).toContain("No recent trend data");
  });

  it("asks Qloo for trends in a lagged window with 20 weekly points", async () => {
    const input = sample();
    const { deps, events } = setup(input);
    await runOptimizer(input, deps);
    const calls = events.flatMap((e) => ("calls" in e && e.calls ? e.calls : [])).filter((c) => c.tool === "qloo_trends");
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.args).toMatchObject({ start_date: "2026-02-05", end_date: "2026-06-24", limit: 20 });
  });

  it("surfaces needs_input candidates from the act ranking and honors pins", async () => {
    const input = sample({ acts: "Phoenix\nMen I Trust\nCuco\nLeon Bridges\nKhruangbin" });
    const { deps } = setup(input);
    const r = await runOptimizer(input, deps);
    const choice = r.choices.find((c) => c.input === "Phoenix")!;
    expect(choice).toMatchObject({ field: "act", kind: "ambiguous" });
    expect(choice.candidates).toHaveLength(3);
    expect(r.acts.find((a) => a.input.name === "Phoenix")!.entity.id).toBe(choice.chosen!.id);

    const pinned = sample({ acts: "Phoenix\nMen I Trust\nCuco\nLeon Bridges\nKhruangbin", pins: { Phoenix: choice.candidates[2]!.id } });
    const p = setup(pinned);
    const r2 = await runOptimizer(pinned, p.deps);
    expect(r2.acts.find((a) => a.input.name === "Phoenix")!.entity).toMatchObject({ id: choice.candidates[2]!.id, match: "confirmed" });
    expect(r2.choices.filter((c) => c.input === "Phoenix")).toEqual([]);
  });

  it("stops the run on QLOO_AUTH", async () => {
    const input = sample();
    const { deps, events } = setup(input, { override: (tool) => (tool === "qloo_rank" ? fixture<QlooEnvelope>("error-auth.json") : undefined) });
    await expect(runOptimizer(input, deps)).rejects.toThrow("Qloo rejected");
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("Nemotron proposer", () => {
  const reply = (content: string) => ({ body: { choices: [{ message: { content } }] } });

  it("uses Nemotron's legal move; its numbers never become scores", async () => {
    const input = sample();
    const f = fakeFetch([
      reply('{"action":"swap","out":"Mdou Moctar","in":"Leon Bridges","why":"Leon Bridges shares more of the brands\' audience.","score":99}'),
      reply('{"action":"stop","why":"Remaining swaps look weaker."}'),
    ]);
    const { deps, events } = setup(input, { llm: { enabled: true, apiKey: "k", model: "nvidia/test", fetch: f.fetch } });
    const r = await runOptimizer(input, deps);
    const d = decisions(events)[0]!;
    expect(d.proposer).toBe("nemotron");
    expect(d.moveText).toBe("Swap Mdou Moctar for Leon Bridges");
    expect(d.rationale).toBe("Leon Bridges shares more of the brands' audience.");
    expect(d.candidate!.objective).not.toBe(99);
    expect(r.stopReason).toBe("Remaining swaps look weaker.");
    expect(r.mode.proposer).toBe("nemotron");
    expect(f.calls).toHaveLength(2);
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.model).toBe("nvidia/test");
    expect(body.messages[1].content).toContain("Mdou Moctar");
  });

  it("falls back to the heuristic on an illegal or unparseable reply, hides rationales with numbers", async () => {
    const input = sample();
    const f = fakeFetch([
      reply('{"action":"swap","out":"Nobody","in":"Cuco"}'),
      reply("I think you should swap things"),
      reply('{"action":"swap","out":"Men I Trust","in":"Allah-Las","why":"It lifts fit by 20%."}'),
      reply('{"action":"stop","why":"done"}'),
    ]);
    const { deps, events } = setup(input, { llm: { enabled: true, apiKey: "k", model: "m", fetch: f.fetch } });
    await runOptimizer(input, deps);
    const d = decisions(events);
    expect(d[0]).toMatchObject({ proposer: "heuristic" });
    expect(d[0]!.proposerNote).toMatch(/unknown act/);
    expect(d[1]!.proposerNote).toMatch(/not JSON/);
    expect(d[2]).toMatchObject({ proposer: "nemotron", rationale: undefined });
    expect(d[2]!.proposerNote).toMatch(/cited numbers/);
  });

  it("ignores a stop before any move was tested", async () => {
    const input = sample({ budget: 21 });
    const f = fakeFetch([reply('{"action":"stop","why":"fine as is"}')]);
    const { deps, events } = setup(input, { llm: { enabled: true, apiKey: "k", model: "m", fetch: f.fetch } });
    await runOptimizer(input, deps);
    expect(decisions(events)[0]!.proposerNote).toMatch(/before testing any move/);
  });
});

describe("proposer helpers", () => {
  it("extractJson finds the first object; interpretReply validates legality", async () => {
    expect(extractJson('sure: {"action":"stop","why":"x"} thanks')).toEqual({ action: "stop", why: "x" });
    expect(extractJson("no json")).toBeUndefined();
    const input = sample();
    const { deps } = setup(input, { maxIterations: 0 });
    const r = await runOptimizer(input, deps);
    const ctx: ProposalContext = { acts: r.acts, slots: r.slots, brands: r.brands, goal: "sponsor_fit", current: r.draft, tried: new Set([r.draft.key]), history: [], remaining: 10, iteration: 1, consecutiveRejects: 0 };
    const moves = legalMoves(ctx);
    // 3 on the bill x 5 bench (all available on Nov 14) + 1 slot move; Hermanos Gutierrez blocks the Nov 21 slot only if on the bill.
    expect(moves.filter((m) => m.move.kind === "swap")).toHaveLength(15);
    expect(moves.filter((m) => m.move.kind === "slot")).toHaveLength(1);
    expect(interpretReply({ action: "slot", to: "The Novo" }, ctx).move).toEqual({ kind: "slot", to: 1 });
    expect(interpretReply({ action: "swap", out: "Cuco", in: "Cuco" }, ctx).error).toBeDefined();
    expect(interpretReply({ action: "dance" }, ctx).error).toMatch(/unknown action/);
  });
});
