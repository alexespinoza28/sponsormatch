import { describe, expect, it } from "vitest";
import { parseTrends, rankAffinities, tasteOverlap } from "@/lib/optimizer/parse";
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
import { trendWindow } from "@/lib/optimizer/qloo-steps";
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

  it("lineupMomentum maps mean momentum from [-1,1] to [0,1]; missing trends count as flat when asked", () => {
    expect(lineupMomentum([act("a", [], 0, 0.2), act("b", [], 0, -0.6)])).toBe(0.4);
    expect(lineupMomentum([act("a", [])])).toBeUndefined();
    expect(lineupMomentum([act("a", [], 0, 0.4), act("b", [])])).toBe(0.7);
    expect(lineupMomentum([act("a", [], 0, 0.4), act("b", [])], true)).toBe(0.6);
    expect(lineupMomentum([act("a", [])], true)).toBe(0.5);
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

  it("reads rank results for bare artist names (live shape)", () => {
    const { byId, inputs } = rankAffinities(env("rank-artists-ok.json"));
    expect(inputs.get("Fixture Revival")).toMatchObject({ id: A2, match: "exact" });
    expect(byId.get(A1)).toBe(0.734);
  });

  it("reads compare_audiences as taste overlap (live layout: tags/a/b/matchEntities)", () => {
    const t = tasteOverlap(env("compare-audiences.json"));
    expect(t.layout).toBe("parsed");
    expect(t.shared.map((x) => [x.name, x.score])).toEqual([
      ["Dream Pop", 0.98],
      ["Indie Folk", 0.91],
      ["Bedroom Pop", 0.87],
    ]);
    expect(t.meanScore).toBe(0.92);
    expect(t.onlyA).toEqual([{ id: "urn:tag:genre:qloo:shoegaze", name: "Shoegaze", count: 18 }]);
    expect(t.onlyB.map((x) => x.name)).toEqual(["Art Pop"]);
  });

  it("says when a compare layout is unrecognized or the call failed, without inventing numbers", () => {
    const odd = { ...env("compare-audiences.json"), results: { entities: [{ entity_id: "x", name: "X", score: 3 }] } } as QlooEnvelope;
    const t = tasteOverlap(odd);
    expect(t.layout).toBe("unrecognized");
    expect(t.shared).toEqual([]);
    expect(t.note).toContain("results: entities");
    const failed = { ...env("compare-audiences.json"), status: "error", summary: "boom" } as QlooEnvelope;
    expect(tasteOverlap(failed)).toMatchObject({ layout: "unavailable", shared: [] });
  });

  it("parses live trends: newest-first points, string ranks, flat and empty series", () => {
    const m = parseTrends(env("trends.json"));
    expect(m.get(A1)).toMatchObject({ metric: "population_percentile", value: 0.248, first: 0.525, last: 0.655, points: 6 });
    expect(m.get(A2)!.value).toBe(0);
    expect(m.has("0A1B2C3D-0000-4000-A000-000000000003")).toBe(false);
    const rankOnly = momentumFromPoints([{ date: "2026-06-28", population_rank: "900" }, { date: "2026-06-21", population_rank: "1000" }]);
    expect(rankOnly).toMatchObject({ metric: "population_rank", value: 0.1 });
  });

  it("trend window ends months back because Qloo trend data lags", () => {
    expect(trendWindow(new Date("2026-10-22T12:00:00Z"))).toEqual({ start: "2026-02-05", end: "2026-06-24" });
  });
});
