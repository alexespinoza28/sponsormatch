import { describe, expect, it } from "vitest";
import { headToHead, parseCompareRows, parseTrends, rankAffinities } from "@/lib/optimizer/parse";
import {
  brandFit,
  cohesion,
  GOAL_WEIGHTS,
  lineupKey,
  lineupMomentum,
  momentumFromPoints,
  objective,
  pctChange,
  priorObjective,
  scoreLineup,
  tagOverlap,
} from "@/lib/optimizer/scoring";
import type { ActProfile } from "@/lib/optimizer/types";
import { explainabilityScores, resultEntities } from "@/lib/qloo/normalize";
import type { QlooEnvelope } from "@/lib/qloo/types";
import { fixture } from "./helpers";

const env = (name: string) => fixture<QlooEnvelope>(name);
const A1 = "0A1B2C3D-0000-4000-A000-000000000001";
const A2 = "0A1B2C3D-0000-4000-A000-000000000002";
const B1 = "B0000000-0000-4000-A000-000000000001";
const B2 = "B0000000-0000-4000-A000-000000000002";

function act(id: string, tags: Array<[string, number]>, brandAffinity?: number, momentum?: number): ActProfile {
  return {
    input: { name: id, unavailable: [] },
    entity: { input: id, id, name: id, match: "exact" },
    brandAffinity,
    tags: tags.map(([t, affinity]) => ({ id: t, name: t.toUpperCase(), affinity })),
    momentum: momentum === undefined ? undefined : { value: momentum, metric: "population_percentile", first: 0.5, last: 0.5, points: 4 },
  };
}

describe("scoring math", () => {
  it("brandFit weights the primary brand double", () => {
    expect(brandFit([{ id: "p", name: "P", affinity: 0.9 }, { id: "q", name: "Q", affinity: 0.6 }], "p")).toBe(0.8);
    expect(brandFit([{ id: "p", name: "P", affinity: 0.9 }, { id: "q", name: "Q", affinity: 0.6 }])).toBe(0.75);
    expect(brandFit([])).toBe(0);
    expect(brandFit([{ id: "p", name: "P", affinity: 1.4 }], "p")).toBe(1);
  });

  it("tagOverlap is weighted Jaccard over the union of tags", () => {
    const a = [{ id: "x", name: "X", affinity: 0.8 }, { id: "y", name: "Y", affinity: 0.4 }];
    const b = [{ id: "x", name: "X", affinity: 0.6 }, { id: "z", name: "Z", affinity: 0.5 }];
    // min: x 0.6 ; max: x 0.8 + y 0.4 + z 0.5 = 1.7
    expect(tagOverlap(a, b)).toEqual({ overlap: 0.353, shared: ["X"] });
    expect(tagOverlap(a, a).overlap).toBe(1);
    expect(tagOverlap(a, []).overlap).toBe(0);
  });

  it("cohesion averages pairwise overlap; needs two acts with tags", () => {
    const x = act("x", [["t1", 1]]);
    const y = act("y", [["t1", 1]]);
    const z = act("z", [["t2", 1]]);
    expect(cohesion([x, y])).toBe(1);
    expect(cohesion([x, y, z])).toBe(0.333);
    expect(cohesion([x, act("w", [])])).toBeUndefined();
  });

  it("lineupMomentum maps mean momentum from [-1,1] to [0,1]", () => {
    expect(lineupMomentum([act("a", [], 0, 0.2), act("b", [], 0, -0.6)])).toBe(0.4);
    expect(lineupMomentum([act("a", [])])).toBeUndefined();
  });

  it("objective blends parts by goal and renormalizes missing parts", () => {
    expect(objective({ fit: 0.6, cohesion: 0.5, momentum: 0.8 }, "sponsor_fit")).toBe(61.5);
    expect(objective({ fit: 0.6 }, "sponsor_fit")).toBe(60);
    expect(objective({ fit: 0.6, momentum: 0.8 }, "momentum")).toBe(Math.round(((0.4 * 0.6 + 0.45 * 0.8) / 0.85) * 1000) / 10);
    for (const w of Object.values(GOAL_WEIGHTS)) expect(w.fit + w.cohesion + w.momentum).toBeCloseTo(1);
  });

  it("lineupKey ignores bill order; pctChange rounds", () => {
    expect(lineupKey({ acts: ["b", "a"], slot: 1 })).toBe(lineupKey({ acts: ["a", "b"], slot: 1 }));
    expect(lineupKey({ acts: ["a", "b"], slot: 0 })).not.toBe(lineupKey({ acts: ["a", "b"], slot: 1 }));
    expect(pctChange(0.5, 0.59)).toBe(18);
    expect(pctChange(0, 1)).toBe(0);
  });

  it("momentumFromPoints compares first and last thirds, flips rank fields", () => {
    const up = momentumFromPoints([0.5, 0.5, 0.6, 0.6, 0.7, 0.7].map((v, i) => ({ date: `2026-0${i + 1}-01`, population_percentile: v })));
    expect(up).toMatchObject({ value: 0.4, metric: "population_percentile", first: 0.5, last: 0.7 });
    const down = momentumFromPoints([{ date: "2026-01-01", population_rank: 100 }, { date: "2026-02-01", population_rank: 150 }]);
    expect(down).toMatchObject({ value: -0.5, metric: "population_rank" });
    expect(momentumFromPoints([{ date: "x", population_percentile: 0.5 }])).toBeUndefined();
    expect(momentumFromPoints([{ date: "a" }, { date: "b" }])).toBeUndefined();
  });

  it("scoreLineup uses only Qloo brand affinities plus cached act evidence", () => {
    const acts = [act(A1, [["t", 1]], 0.7, 0.2), act(A2, [["t", 0.5]], 0.5, 0)];
    const s = scoreLineup({ lineup: { acts: [A1, A2], slot: 0 }, brands: [{ id: B1, name: "C", affinity: 0.7 }], acts, goal: "sponsor_fit", primaryId: B1, evidenceId: "e" });
    expect(s.parts).toEqual({ fit: 0.7, cohesion: 0.5, momentum: 0.55 });
    expect(s.objective).toBe(objective(s.parts, "sponsor_fit"));
    expect(priorObjective({ lineup: { acts: [A1, A2], slot: 0 }, acts, goal: "sponsor_fit" })).toBe(objective({ fit: 0.6, cohesion: 0.5, momentum: 0.55 }, "sponsor_fit"));
  });
});

describe("parsing harness results", () => {
  it("reads rank results and the input -> ID interpretation", () => {
    const { byId, inputs } = rankAffinities(env("rank-brands-ok.json"));
    expect(byId.get(B1)).toBe(0.648);
    expect(inputs.get(B2)).toMatchObject({ id: B2, name: "Testbrand Motors" });
  });

  it("reads the confirmed explainability shape", () => {
    const [cider, coffee] = resultEntities(env("recommend-brands-explain.json"));
    expect([...explainabilityScores(cider!).entries()]).toEqual([[A1, 1]]);
    expect(explainabilityScores(coffee!).get(A2)).toBe(0.3);
  });

  it("parses compare rows from several layouts and computes b - a", () => {
    const h = headToHead(env("compare-brands.json"), [B1, B2]);
    expect(h.layout).toBe("parsed");
    expect(h.targetsFound).toEqual([B1, B2]);
    expect(h.targetLean).toBe(0.01); // (0.06 + -0.04) / 2
    expect(h.topGainers.map((g) => g.name)).toEqual(["Testbrand Cider", "Testbrand Coffee"]);
    expect(parseCompareRows([{ entity_id: "x", name: "X", affinity_a: 0.2, affinity_b: 0.5 }])).toEqual([{ id: "x", name: "X", a: 0.2, b: 0.5, delta: 0.3 }]);
    expect(parseCompareRows({ tags: [{ tag_id: "t", name: "T", a: 0.4, b: 0.1 }] })[0]).toMatchObject({ delta: -0.3 });
    expect(parseCompareRows({ results: [{ id: "y", name: "Y", query: { delta: 0.2 } }] })[0]).toEqual({ id: "y", name: "Y", delta: 0.2 });
  });

  it("says when a compare layout is unrecognized or the call failed, without inventing numbers", () => {
    const odd = { ...env("compare-brands.json"), results: { entities: [{ entity_id: "x", name: "X", score: 3 }] } } as QlooEnvelope;
    const h = headToHead(odd, [B1]);
    expect(h.layout).toBe("unrecognized");
    expect(h.targetLean).toBeUndefined();
    expect(h.note).toContain("not recognized");
    const failed = { ...env("compare-brands.json"), status: "error", summary: "boom" } as QlooEnvelope;
    expect(headToHead(failed, [B1])).toMatchObject({ layout: "unavailable", rows: [] });
  });

  it("parses trends series (percentile up, rank down)", () => {
    const m = parseTrends(env("trends.json"));
    expect(m.get(A1)).toMatchObject({ metric: "population_percentile", value: 0.3 });
    expect(m.get(A2)!.value).toBeLessThan(0);
  });
});
