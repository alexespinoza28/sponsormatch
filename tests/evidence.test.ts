import { describe, expect, it } from "vitest";
import {
  buildBrandEvidence,
  demographicAlignment,
  describeDemographics,
  normalizeName,
  pickBrandCategoryTag,
  pickEntity,
  sponsorFit,
  tagOverlap,
  toAudienceTags,
} from "@/lib/agent/evidence";
import type { ResolvedEntity } from "@/lib/agent/types";
import { averageDemographics, insightDemographics, insightEntities, insightTags, type DemographicProfile } from "@/lib/qloo/normalize";
import type { QlooInsightsResponse, QlooSearchResponse, QlooTagsResponse } from "@/lib/qloo/types";
import { fixture } from "./helpers";

const search = fixture<QlooSearchResponse>("search-artist.json");
const brands = insightEntities(fixture<QlooInsightsResponse>("insights-brands.json"));
const coffeeEntity = brands.find((b) => b.name === "Testbrand Coffee")!;
const tagsRes = fixture<QlooInsightsResponse>("insights-tags.json");
const demoRows = insightDemographics(fixture<QlooInsightsResponse>("insights-demographics.json"));

const performer: ResolvedEntity = {
  input: "the fixture tones",
  id: "0A1B2C3D-0000-4000-A000-000000000001",
  name: "The Fixture Tones",
  type: "urn:entity:artist",
  match: "exact",
  alternatives: [],
};

describe("entity resolution", () => {
  it("normalizes names for matching", () => {
    expect(normalizeName("The Fixture Tones")).toBe("fixture tones");
    expect(normalizeName("Beyoncé & Friends!")).toBe("beyonce and friends");
  });

  it("prefers a unique exact match and keeps alternatives", () => {
    const r = pickEntity("fixture tones", search)!;
    expect(r.name).toBe("The Fixture Tones");
    expect(r.match).toBe("exact");
    expect(r.alternatives.map((a) => a.name)).toEqual(["Fixture Tones Revival"]);
  });

  it("falls back to the first result as a best guess", () => {
    const r = pickEntity("Fixture", search)!;
    expect(r.match).toBe("best_guess");
    expect(r.id).toBe("0A1B2C3D-0000-4000-A000-000000000001");
  });

  it("prefers candidates whose address matches the city", () => {
    const res = {
      results: [
        { name: "The Bowl", entity_id: "1", properties: { address: "1 Main St, Springfield" } },
        { name: "The Bowl", entity_id: "2", properties: { address: "1122 N Milpas St, Santa Barbara, CA" } },
      ],
    } as QlooSearchResponse;
    const r = pickEntity("The Bowl", res, { preferAddress: "Santa Barbara" })!;
    expect(r.id).toBe("2");
    expect(r.match).toBe("exact");
  });

  it("returns undefined for empty results", () => {
    expect(pickEntity("x", { results: [] })).toBeUndefined();
  });

  it("picks only brand-genre tags as a category", () => {
    expect(pickBrandCategoryTag(insightTags(fixture<QlooTagsResponse>("tags-search.json")))?.id).toBe(
      "urn:tag:genre:brand:food_and_beverage",
    );
    expect(pickBrandCategoryTag([{ tag_id: "urn:tag:adjective:qloo:x", name: "X" }])).toBeUndefined();
  });
});

describe("audience tags and overlap", () => {
  it("dedupes, drops tags without affinity, sorts by affinity", () => {
    const tags = toAudienceTags(insightTags(tagsRes));
    expect(tags.map((t) => [t.id, t.affinity])).toEqual([
      ["urn:tag:adjective:qloo:indie", 0.88],
      ["urn:tag:genre:brand:food_and_beverage", 0.74],
    ]);
  });

  it("scores overlap as mean audience affinity over the brand's tags", () => {
    const audience = toAudienceTags(insightTags(tagsRes));
    const { overlapping, score } = tagOverlap(
      [
        { id: "urn:tag:genre:brand:food_and_beverage", name: "F&B" },
        { id: "urn:tag:adjective:qloo:indie", name: "Indie" },
        { id: "urn:tag:genre:brand:automotive", name: "Auto" },
      ],
      audience,
    );
    expect(overlapping.map((t) => t.name)).toEqual(["Indie", "Food & Beverage"]);
    expect(score).toBe(0.54); // (0.88 + 0.74) / 3
    expect(tagOverlap([], audience).score).toBe(0);
  });
});

describe("demographics", () => {
  const a = averageDemographics(demoRows.slice(0, 1))!;
  it("is 1 for identical profiles and negative for opposite ones", () => {
    expect(demographicAlignment(a, a)).toBe(1);
    const flipped: DemographicProfile = {
      age: Object.fromEntries(Object.entries(a.age).map(([k, v]) => [k, -v])) as DemographicProfile["age"],
      gender: { male: -a.gender.male, female: -a.gender.female },
    };
    expect(demographicAlignment(a, flipped)).toBe(-1);
    expect(demographicAlignment(a, undefined)).toBeUndefined();
  });

  it("describes the strongest age bucket and gender lean", () => {
    expect(describeDemographics(a)).toEqual({ topAge: "25-29", genderLean: "male-leaning" });
  });
});

describe("sponsor fit", () => {
  it("weights affinity 60 / tags 25 / demographics 15", () => {
    expect(sponsorFit({ affinity: 1, tags: 1, demographics: 1 })).toBe(100);
    expect(sponsorFit({ affinity: 0.9, tags: 0.4, demographics: 0 })).toBe(71.5); // 54 + 10 + 7.5
  });

  it("renormalizes when demographics are missing and clamps inputs", () => {
    expect(sponsorFit({ affinity: 0.9, tags: 0.4 })).toBe(75.3); // (0.54 + 0.10) / 0.85
    expect(sponsorFit({ affinity: 2, tags: -1 })).toBe(70.6);
  });
});

describe("buildBrandEvidence", () => {
  const audienceTags = toAudienceTags(insightTags(tagsRes));
  const audienceDemo = averageDemographics(demoRows)!;

  it("re-ranks Qloo results by sponsor fit and records evidence", () => {
    const cards = buildBrandEvidence({
      brands,
      audienceTags,
      audienceDemographics: audienceDemo,
      brandDemographics: new Map([[coffeeEntity.entity_id, averageDemographics(demoRows.slice(0, 1))!]]),
      localPresence: new Map([[coffeeEntity.entity_id, [{ id: "p1", name: "Testbrand Coffee - Downtown", address: "1 State St" }]]]),
      performers: [performer],
    });
    expect(cards.map((c) => c.name)).toEqual(["Testbrand Coffee", "Testbrand Motors"]);
    const [coffee, motors] = cards;
    expect(coffee!.rank).toBe(1);
    expect(coffee!.qlooRank).toBe(2); // Motors had higher raw affinity
    expect(coffee!.overlappingTags).toHaveLength(2);
    expect(coffee!.tagOverlapScore).toBe(0.81);
    expect(coffee!.contributors[0]).toEqual({ id: performer.id, name: "The Fixture Tones", kind: "performer", score: 0.81 });
    expect(coffee!.contributors[1]!.kind).toBe("other");
    expect(coffee!.contributors[1]!.name).toBe("0A1B2C3D-0000-4000-A000-000000000009");
    expect(coffee!.eventOccasions).toEqual(["outdoor concerts"]);
    expect(coffee!.localPresence).toHaveLength(1);
    expect(coffee!.localPresenceChecked).toBe(true);
    expect(coffee!.demographicAlignment).toBeGreaterThan(0.5);
    expect(motors!.tagOverlapScore).toBe(0);
    expect(motors!.demographicAlignment).toBeUndefined();
    expect(motors!.localPresenceChecked).toBe(false);
  });

  it("drops duplicates and entities without affinity", () => {
    const cards = buildBrandEvidence({
      brands: [coffeeEntity, coffeeEntity, { name: "No score", entity_id: "Z" }],
      audienceTags,
      performers: [performer],
    });
    expect(cards).toHaveLength(1);
  });
});
