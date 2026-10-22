import { describe, expect, it } from "vitest";
import type { AudienceProfile, BrandEvidence, EventInput } from "@/lib/agent/types";
import { DEFAULT_NVIDIA_MODEL, NVIDIA_CHAT_URL, buildChatBody, chatCompletion, resolveModel, stripThink } from "@/lib/llm/nemotron";
import { buildPitchEvidence, buildPitchMessages, draftPitch, draftPitches, templatePitch, unsupportedNumbers } from "@/lib/llm/pitch";
import { fakeFetch } from "./helpers";

const event: EventInput = { performers: ["The Fixture Tones", "DJ Example"], venue: "Test Bowl", city: "Santa Barbara", date: "2026-11-14" };
const audience: AudienceProfile = {
  tags: [
    { id: "urn:tag:adjective:qloo:indie", name: "Indie", affinity: 0.88 },
    { id: "urn:tag:genre:brand:food_and_beverage", name: "Food & Beverage", affinity: 0.74 },
  ],
  demographics: {
    age: { "24_and_younger": 0.1, "25_to_29": 0.4, "30_to_34": 0.1, "35_to_44": -0.1, "45_to_54": -0.2, "55_and_older": -0.3 },
    gender: { male: -0.05, female: 0.05 },
  },
};
const brand: BrandEvidence = {
  rank: 1,
  id: "B1",
  name: "Testbrand Coffee",
  description: "Synthetic coffee brand",
  qlooRank: 2,
  qlooAffinity: 0.934,
  popularity: 0.71,
  overlappingTags: [{ id: "urn:tag:adjective:qloo:indie", name: "Indie", audienceAffinity: 0.88 }],
  brandTags: [{ id: "urn:tag:adjective:qloo:indie", name: "Indie" }],
  tagOverlapScore: 0.44,
  contributors: [
    { id: "V1", name: "Test Bowl", kind: "venue", score: 0.5 },
    { id: "P1", name: "The Fixture Tones", kind: "performer", score: 0.31 },
  ],
  demographicAlignment: 0.62,
  localPresence: [{ id: "L1", name: "Testbrand Coffee - Downtown", address: "12 State St, Santa Barbara" }],
  localPresenceChecked: true,
  metadata: { useOccasions: ["outdoor concerts"], targetAudience: [], psychographics: [], personality: [], industries: [], priceTier: [] },
  eventOccasions: ["outdoor concerts"],
  sponsorFit: 82.4,
  fitBreakdown: { affinity: 0.934, tags: 0.44, demographics: 0.62 },
};
const evidence = buildPitchEvidence(event, brand, audience);

describe("nemotron client", () => {
  it("strips think blocks, including unmatched tags", () => {
    expect(stripThink("<think>plan\nmore</think>\n\nHello there.")).toBe("Hello there.");
    expect(stripThink("Reasoning leak</think>Answer")).toBe("Answer");
    expect(stripThink("Answer<think>trailing")).toBe("Answer");
    expect(stripThink("<THINK>x</THINK>ok")).toBe("ok");
  });

  it("builds the request body with reasoning off and the requested sampling", () => {
    expect(buildChatBody("m", [{ role: "user", content: "hi" }])).toMatchObject({
      model: "m",
      temperature: 0.5,
      top_p: 0.9,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("resolves the model from NVIDIA_MODEL with a default", () => {
    expect(resolveModel({})).toBe(DEFAULT_NVIDIA_MODEL);
    expect(DEFAULT_NVIDIA_MODEL).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(resolveModel({ NVIDIA_MODEL: " other/model " })).toBe("other/model");
  });

  it("posts to the NVIDIA endpoint with a Bearer key and returns stripped text", async () => {
    const { fetch, calls } = fakeFetch([{ body: { choices: [{ message: { content: "<think>x</think>Pitch text." } }] } }]);
    const text = await chatCompletion({ apiKey: "nv-test", model: "m", messages: [{ role: "user", content: "hi" }], fetch });
    expect(text).toBe("Pitch text.");
    expect(calls[0]!.url.toString()).toBe(NVIDIA_CHAT_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer nv-test");
    expect(JSON.parse(String(calls[0]!.init.body)).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("throws on HTTP errors without echoing the key", async () => {
    const { fetch } = fakeFetch([{ status: 401, body: { detail: "bad" } }]);
    const err = await chatCompletion({ apiKey: "nv-secret", model: "m", messages: [], fetch }).catch((e) => e);
    expect(err.message).toBe("NVIDIA API returned 401");
    expect(err.message).not.toContain("nv-secret");
  });
});

describe("pitch evidence and guards", () => {
  it("puts only evidence fields in the prompt", () => {
    const [system, user] = buildPitchMessages(evidence);
    expect(system!.content).toContain("Use ONLY the facts");
    expect(user!.content).toContain('"qlooAffinity": 0.934');
    expect(user!.content).toContain("Testbrand Coffee - Downtown");
    expect(evidence.audience.topAgeGroup).toBe("25-29");
    expect(evidence.brand.strongestPerformerLink).toEqual({ name: "The Fixture Tones", share: 0.31 });
  });

  it("flags numbers that are not in the evidence", () => {
    expect(unsupportedNumbers("Affinity of 0.934 (93%) on November 14, 2026 with The Fixture Tones.", evidence)).toEqual([]);
    expect(unsupportedNumbers("Expect 5,000 fans and a 40% sales lift.", evidence)).toEqual(["5,000", "40"]);
  });

  it("template pitch is deterministic, grounded, and passes the number guard", () => {
    const text = templatePitch(evidence);
    expect(text).toBe(templatePitch(evidence));
    expect(text).toContain("Testbrand Coffee");
    expect(text).toContain("0.93");
    expect(text).toContain("November 14, 2026");
    expect(text).toContain('"Indie"');
    expect(unsupportedNumbers(text, evidence)).toEqual([]);
  });
});

describe("draftPitch", () => {
  it("uses the template when no NVIDIA key is set", async () => {
    const p = await draftPitch(evidence, "B1", { model: "m" });
    expect(p).toMatchObject({ brandId: "B1", source: "template", note: "NVIDIA_API_KEY not set" });
  });

  it("returns the Nemotron draft when it passes the number guard", async () => {
    const { fetch } = fakeFetch([{ body: { choices: [{ message: { content: "Testbrand Coffee fits: Qloo affinity 0.934." } }] } }]);
    const p = await draftPitch(evidence, "B1", { apiKey: "k", model: "m", fetch });
    expect(p).toMatchObject({ source: "nemotron", model: "m", text: "Testbrand Coffee fits: Qloo affinity 0.934." });
  });

  it("falls back to the template when the model invents numbers or errors", async () => {
    const { fetch } = fakeFetch([
      { body: { choices: [{ message: { content: "Reach 12,000 attendees." } }] } },
      { status: 503, body: {} },
    ]);
    const [invented, failed] = await draftPitches(
      [
        { brandId: "B1", evidence },
        { brandId: "B2", evidence },
      ],
      { apiKey: "k", model: "m", fetch, concurrency: 1 },
    );
    expect(invented!.source).toBe("template");
    expect(invented!.note).toContain("12,000");
    expect(failed!.source).toBe("template");
    expect(failed!.note).toContain("503");
  });
});
