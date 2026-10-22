import { describe, expect, it } from "vitest";
import {
  buildBrandEvidence,
  demographicAlignment,
  describeDemographics,
  pickBrandCategoryTag,
  sponsorFit,
  tagOverlap,
  toAudienceTags,
  toHotspots,
} from "@/lib/agent/evidence";
import type { ResolvedEntity } from "@/lib/agent/types";
import { averageDemographics, resultDemographics, resultEntities, resultTags, type DemographicProfile } from "@/lib/qloo/normalize";
import type { QlooEnvelope } from "@/lib/qloo/types";
import { fixture } from "./helpers";

const env = (name: string) => fixture<QlooEnvelope>(name);
const brands = resultEntities(env("recommend-brands.json"));
const coffee = brands.find((b) => b.name === "Testbrand Coffee")!;
const motors = brands.find((b) => b.name === "Testbrand Motors")!;
const demoRows = resultDemographics(env("demographics.json"));

const performer: ResolvedEntity = {
  input: "the fixture tones",
  id: "0A1B2C3D-0000-4000-A000-000000000001",
  name: "The Fixture Tones",
  type: "urn:entity:artist",
  match: "exact",
  alternatives: [],
};

describe("tags", () => {
  it("dedupes, drops tags without affinity, sorts by affinity", () => {
    expect(toAudienceTags(resultTags(env("entity-tags.json"))).map((t) => [t.id, t.affinity])).toEqual([
      ["urn:tag:adjective:qloo:indie", 0.88],
      ["urn:tag:genre:brand:food_and_beverage", 0.74],
    ]);
  });

  it("picks only brand-genre tags as a category", () => {
    expect(pickBrandCategoryTag(resultTags(env("entity-tags.json")))?.id).toBe("urn:tag:genre:brand:food_and_beverage");
    expect(pickBrandCategoryTag([{ id: "urn:tag:adjective:qloo:x", name: "X" }])).toBeUndefined();
  });

  it("scores overlap as mean audience affinity over the brand's tags", () => {
    const audience = toAudienceTags(resultTags(env("entity-tags.json")));
    const { overlapping, score } = tagOverlap(
      [
        { id: "urn:tag:genre:brand:food_and_beverage", name: "F&B" },
        { id: "urn:tag:adjective:qloo:indie", name: "Indie" },
        { id: "urn:tag:genre:brand:automotive", name: "Auto" },
      ],
      audience,
    );
    expect(overlapping.map((t) => t.name)).toEqual(["Indie", "Food & Beverage"]);
    expect(score).toBe(0.54);
    expect(tagOverlap([], audience).score).toBe(0);
  });
});

describe("demographics", () => {
  const a = averageDemographics(demoRows.slice(0, 1))!;
  it("is 1 for identical profiles and -1 for opposite ones", () => {
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
    expect(sponsorFit({ affinity: 0.9, tags: 0.4, demographics: 0 })).toBe(71.5);
  });

  it("renormalizes when parts are missing and clamps inputs", () => {
    expect(sponsorFit({ affinity: 0.9, tags: 0.4 })).toBe(75.3);
    expect(sponsorFit({ affinity: 0.9 })).toBe(90);
    expect(sponsorFit({ affinity: 2, tags: -1 })).toBe(70.6);
  });
});

describe("hotspots", () => {
  it("keeps valid heatmap points, strongest first", () => {
    const h = toHotspots(env("where-popular.json").results as unknown[]);
    expect(h.map((p) => p.affinity)).toEqual([0.97, 0.91]);
    expect(h[0]).toMatchObject({ latitude: 34.43, longitude: -119.72, geohash: "9q4gc3" });
  });
});

describe("buildBrandEvidence", () => {
  const audienceTags = toAudienceTags(resultTags(env("entity-tags.json")));

  it("re-ranks Qloo results by sponsor fit and records evidence", () => {
    const cards = buildBrandEvidence({
      brands,
      audienceTags,
      audienceDemographics: averageDemographics(demoRows)!,
      brandDemographics: new Map([[coffee.entity_id, averageDemographics(demoRows.slice(0, 1))!]]),
      brandTags: new Map([
        [
          coffee.entity_id,
          [
            { id: "urn:tag:genre:brand:food_and_beverage", name: "Food & Beverage", affinity: 0.9 },
            { id: "urn:tag:adjective:qloo:indie", name: "Indie", affinity: 0.8 },
          ],
        ],
        [motors.entity_id, [{ id: "urn:tag:genre:brand:automotive", name: "Automotive", affinity: 0.95 }]],
      ]),
      hotspots: new Map([[coffee.entity_id, toHotspots(env("where-popular.json").results as unknown[])]]),
      performers: [performer],
    });
    expect(cards.map((c) => c.name)).toEqual(["Testbrand Coffee", "Testbrand Motors"]);
    const [c, m] = cards;
    expect(c!.rank).toBe(1);
    expect(c!.qlooRank).toBe(2);
    expect(c!.overlappingTags).toHaveLength(2);
    expect(c!.tagOverlapScore).toBe(0.81);
    expect(c!.contributors[0]).toEqual({ id: performer.id, name: "The Fixture Tones", kind: "performer", score: 0.81 });
    expect(c!.contributors[1]!.kind).toBe("other");
    expect(c!.hotspots).toHaveLength(2);
    expect(c!.hotspotsChecked).toBe(true);
    expect(c!.brandTagsChecked).toBe(true);
    expect(c!.demographicAlignment).toBeGreaterThan(0.5);
    expect(c!.image).toBe("https://example.invalid/coffee.jpg");
    expect(m!.tagOverlapScore).toBe(0);
    expect(m!.demographicAlignment).toBeUndefined();
    expect(m!.hotspotsChecked).toBe(false);
    expect(m!.source).toBe("recommended");
  });

  it("skips the tag component when brand tags were not fetched", () => {
    const [card] = buildBrandEvidence({ brands: [motors], audienceTags, performers: [performer] });
    expect(card!.brandTagsChecked).toBe(false);
    expect(card!.sponsorFit).toBe(95.1); // affinity only
  });

  it("drops duplicates and entities without affinity; labels requested brands", () => {
    const cards = buildBrandEvidence({
      brands: [coffee, coffee, { entity_id: "Z", name: "No score" }],
      audienceTags,
      sources: new Map([[coffee.entity_id, "requested"]]),
      qlooOrder: [],
      performers: [performer],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.source).toBe("requested");
  });
});
