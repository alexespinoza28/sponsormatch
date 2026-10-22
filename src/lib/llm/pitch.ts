import { describeDemographics } from "@/lib/agent/evidence";
import type { AudienceProfile, BrandEvidence, EventInput, Pitch } from "@/lib/agent/types";
import { chatCompletion, type ChatMessage } from "./nemotron";

/** The only facts the pitch writer may use: a compact slice of steps 2-4. */
export interface PitchEvidence {
  event: { performers: string[]; venue?: string; city: string; date?: string };
  audience: { topTasteTags: Array<{ name: string; affinity: number }>; topAgeGroup?: string; genderLean?: string };
  brand: {
    name: string;
    description?: string;
    qlooAffinity: number;
    sponsorFit: number;
    overlappingTags: Array<{ name: string; audienceAffinity: number }>;
    strongestPerformerLink?: { name: string; share: number };
    demographicAlignment?: number;
    /** Number of qloo_where_popular hotspots found for the brand in the event city. */
    localHotspotsFound: number;
  };
}

export function buildPitchEvidence(event: EventInput, brand: BrandEvidence, audience: AudienceProfile): PitchEvidence {
  const demo = describeDemographics(audience.demographics);
  const top = brand.contributors.find((c) => c.kind === "performer");
  return {
    event: { performers: event.performers, venue: event.venue || undefined, city: event.city, date: event.date || undefined },
    audience: {
      topTasteTags: audience.tags.slice(0, 5).map((t) => ({ name: t.name, affinity: t.affinity })),
      topAgeGroup: demo.topAge,
      genderLean: demo.genderLean,
    },
    brand: {
      name: brand.name,
      description: brand.description,
      qlooAffinity: brand.qlooAffinity,
      sponsorFit: brand.sponsorFit,
      overlappingTags: brand.overlappingTags.slice(0, 4).map((t) => ({ name: t.name, audienceAffinity: t.audienceAffinity })),
      strongestPerformerLink: top ? { name: top.name, share: top.score } : undefined,
      demographicAlignment: brand.demographicAlignment,
      localHotspotsFound: brand.hotspots.length,
    },
  };
}

const SYSTEM_PROMPT = [
  "You write sponsorship pitch paragraphs that a local event producer sends to a brand's partnerships team.",
  "Use ONLY the facts in the EVIDENCE JSON. Do not invent attendance, prices, sales, dates, quotes, or any number that is not in the evidence.",
  "Qloo affinity scores describe aggregate taste associations between audiences and brands. Never present them as probabilities, purchase intent, or facts about individuals.",
  "Write one paragraph of 80 to 120 words, plain text, no headings, no bullet points, no markdown, no greeting or sign-off.",
  "Mention the event (performers, city, venue and date if given), why this audience fits the brand using the overlapping taste tags and the Qloo affinity score, and one concrete activation idea that follows from the evidence (for example a shared taste tag, or local promotion when Qloo found local hotspots).",
].join(" ");

export function buildPitchMessages(evidence: PitchEvidence): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `EVIDENCE:\n${JSON.stringify(evidence, null, 2)}\n\nWrite the pitch paragraph for ${evidence.brand.name}.`,
    },
  ];
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatDate(date?: string): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Deterministic pitch used when NVIDIA_API_KEY is unset or the model output fails checks. */
export function templatePitch(evidence: PitchEvidence): string {
  const { event, brand, audience } = evidence;
  const when = formatDate(event.date);
  const where = event.venue ? `${event.venue} in ${event.city}` : event.city;
  const parts: string[] = [];
  parts.push(
    `${joinList(event.performers)} ${event.performers.length > 1 ? "play" : "plays"} ${where}${when ? ` on ${when}` : ""}, and Qloo's taste graph links this audience to ${brand.name} with an affinity score of ${brand.qlooAffinity.toFixed(2)}.`,
  );
  if (brand.overlappingTags.length) {
    parts.push(
      `The audience's taste profile shares ${joinList(brand.overlappingTags.slice(0, 3).map((t) => `"${t.name}"`))} with ${brand.name}'s own Qloo tags.`,
    );
  } else if (audience.topTasteTags.length) {
    parts.push(`Top audience taste tags include ${joinList(audience.topTasteTags.slice(0, 3).map((t) => `"${t.name}"`))}.`);
  }
  if (brand.strongestPerformerLink) {
    parts.push(`Of the lineup, ${brand.strongestPerformerLink.name} contributes most to that affinity.`);
  }
  if (brand.overlappingTags.length) {
    parts.push(`We would build an on-site activation around the shared "${brand.overlappingTags[0]!.name}" taste${brand.localHotspotsFound ? `, with street-level promotion in the parts of ${event.city} where Qloo shows ${brand.name}'s strongest affinity` : ""}.`);
  } else if (brand.localHotspotsFound) {
    parts.push(`Qloo's heatmap shows where in ${event.city} ${brand.name}'s affinity is strongest, which we would use to target pre-show promotion.`);
  } else {
    parts.push(`We would build an on-site activation around the tastes above.`);
  }
  parts.push("These scores describe aggregate taste associations, not individual attendees.");
  return parts.join(" ");
}

/** Every number in the evidence, plus 0-1 scores expressed as whole percentages. */
export function allowedNumbers(evidence: PitchEvidence): Set<string> {
  const allowed = new Set<string>();
  const add = (n: number) => {
    allowed.add(String(n));
    allowed.add(n.toFixed(2));
    allowed.add(n.toFixed(1));
    if (Math.abs(n) <= 1) allowed.add(String(Math.round(n * 100)));
    allowed.add(String(Math.round(n)));
  };
  const json = JSON.stringify(evidence);
  for (const m of json.matchAll(/-?\d+(?:\.\d+)?/g)) add(Number(m[0]));
  const when = formatDate(evidence.event.date);
  if (when) for (const m of when.matchAll(/\d+/g)) allowed.add(String(Number(m[0])));
  return allowed;
}

/** Returns numbers in the text that do not come from the evidence. */
export function unsupportedNumbers(text: string, evidence: PitchEvidence): string[] {
  const allowed = allowedNumbers(evidence);
  const bad: string[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const token = m[0].replace(/,(?=\d{3}\b)/g, "");
    const n = Number(token.replace(",", "."));
    const candidates = [token, String(n), n.toFixed(2), n.toFixed(1)];
    if (!candidates.some((c) => allowed.has(c))) bad.push(m[0]);
  }
  return bad;
}

export interface DraftOptions {
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  concurrency?: number;
}

export async function draftPitch(evidence: PitchEvidence, brandId: string, options: DraftOptions): Promise<Pitch> {
  const fallback = templatePitch(evidence);
  if (!options.apiKey) return { brandId, text: fallback, source: "template", note: "NVIDIA_API_KEY not set" };
  try {
    const text = await chatCompletion({
      apiKey: options.apiKey,
      model: options.model,
      messages: buildPitchMessages(evidence),
      fetch: options.fetch,
    });
    const bad = unsupportedNumbers(text, evidence);
    if (bad.length) {
      return { brandId, text: fallback, source: "template", note: `Model draft cited numbers not in the evidence (${bad.slice(0, 3).join(", ")}); used template.` };
    }
    return { brandId, text, source: "nemotron", model: options.model };
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM error";
    return { brandId, text: fallback, source: "template", note: `${message}; used template.` };
  }
}

export async function draftPitches(items: Array<{ brandId: string; evidence: PitchEvidence }>, options: DraftOptions): Promise<Pitch[]> {
  const results: Pitch[] = new Array(items.length);
  const limit = Math.max(1, Math.min(options.concurrency ?? 2, 4));
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const item = items[i]!;
      results[i] = await draftPitch(item.evidence, item.brandId, options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
