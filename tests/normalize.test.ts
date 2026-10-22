import { describe, expect, it } from "vitest";
import {
  averageDemographics,
  explainabilityScores,
  interpretedEntity,
  issueCandidates,
  resolutionIssues,
  resultDemographics,
  resultEntities,
  resultTags,
} from "@/lib/qloo/normalize";
import type { QlooEnvelope, QlooResultEntity } from "@/lib/qloo/types";
import { fixture } from "./helpers";

const env = (name: string) => fixture<QlooEnvelope>(name);

describe("envelope readers", () => {
  it("reads describe results and interpretation", () => {
    const e = env("describe-ok.json");
    expect(interpretedEntity(e)).toEqual({ entityId: "0A1B2C3D-0000-4000-A000-000000000001", name: "The Fixture Tones", type: "urn:entity:artist", match: "exact" });
    expect(resultEntities(e)[0]!.popularity).toBe(0.912);
  });

  it("reads needs_input candidates", () => {
    const issues = resolutionIssues(env("describe-needs-input.json"));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("ambiguous");
    expect(issueCandidates(issues[0]!).map((c) => c.name)).toEqual(["The Fixture Tones", "Fixture Tones Revival"]);
    expect(resolutionIssues(env("describe-ok.json"))).toEqual([]);
  });

  it("reads recommend entities with affinity and explainability", () => {
    const [motors, coffee] = resultEntities(env("recommend-brands.json"));
    expect(motors!.affinity).toBe(0.951);
    expect(explainabilityScores(coffee!).get("0A1B2C3D-0000-4000-A000-000000000001")).toBe(0.81);
    expect(explainabilityScores(motors!).size).toBe(0);
  });

  it("accepts other plausible explainability layouts", () => {
    const base: QlooResultEntity = { entity_id: "x", name: "x" };
    expect(explainabilityScores({ ...base, explainability: [{ entity_id: "a", score: 0.4 }] }).get("a")).toBe(0.4);
    expect(explainabilityScores({ ...base, explainability: { "signal.interests.entities": { a: 0.3 } } }).get("a")).toBe(0.3);
    expect(explainabilityScores({ ...base, explainability: { warning: "n/a" } }).size).toBe(0);
  });

  it("reads tags and demographics, ignoring malformed rows", () => {
    expect(resultTags(env("entity-tags.json"))).toHaveLength(4);
    const rows = resultDemographics(env("demographics.json"));
    const avg = averageDemographics(rows)!;
    expect(avg.age["25_to_29"]).toBe(0.3);
    expect(avg.gender.male).toBe(-0.02);
    expect(resultDemographics({ ...env("demographics.json"), results: [{ nope: 1 }] })).toEqual([]);
    expect(resultEntities({ ...env("describe-ok.json"), results: undefined })).toEqual([]);
  });
});
