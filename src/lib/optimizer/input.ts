import type { ActInput, EventListing, Goal, OptimizeInput, SlotInput, SponsorInput } from "./types";

// Request validation for both modes. Inputs are public names only (acts,
// venues, cities, brands); nothing personal is accepted or sent to Qloo.

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9:_-]{8,80}$/;
const GOALS: Goal[] = ["sponsor_fit", "momentum", "cohesion"];

export const LIMITS = {
  acts: 10,
  slots: 4,
  brands: 3,
  billMin: 2,
  billMax: 4,
  budgetMin: 12,
  budgetMax: 60,
  budgetDefault: 40,
  events: 8,
  actsPerEvent: 4,
} as const;

function lines(v: unknown): string[] {
  return (Array.isArray(v) ? v.map(String) : String(v ?? "").split("\n")).map((s) => s.trim()).filter(Boolean);
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function name(v: string, what: string): string {
  const s = v.trim();
  if (!s) throw new InputError(`Empty ${what}.`);
  if (s.length > 100) throw new InputError(`${what} names must be under 100 characters.`);
  return s;
}

/** "Khruangbin | not 2026-11-14, 2026-11-21" or "Khruangbin (not 2026-11-14)". */
export function parseAct(line: string): ActInput {
  const m = line.match(/^(.*?)\s*(?:\|\s*|\(\s*)(?:not|unavailable:?)\s+([^)]*)\)?\s*$/i);
  const unavailable = m ? [...m[2]!.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((d) => d[0]) : [];
  return { name: name(m ? m[1]! : line.split("|")[0]!, "Act"), unavailable };
}

/** "Santa Barbara Bowl | Santa Barbara | 2026-11-14" */
export function parseSlot(line: string): SlotInput {
  const [venue = "", city = "", date = ""] = line.split("|").map((s) => s.trim());
  if (!city) throw new InputError(`Venue line "${line}" needs a city: Venue | City | YYYY-MM-DD.`);
  if (date && !DATE.test(date)) throw new InputError(`Date in "${line}" must be YYYY-MM-DD.`);
  return { venue: name(venue, "Venue"), city: name(city, "City"), ...(date ? { date } : {}) };
}

function pinsFrom(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const pins: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 24)) {
    if (typeof v === "string" && ID_PATTERN.test(v) && k.length <= 100) pins[k] = v;
  }
  return Object.keys(pins).length ? pins : undefined;
}

/**
 * Qloo calls the optimizer needs before it can test a single move: one
 * describe per brand, one act ranking, one venue ranking, one entity_tags per
 * act, one trends call per 5 acts and the draft score, plus one evaluation
 * and the final recommendation.
 */
export function minimumBudget(acts: number, brands: number): number {
  return brands + 2 + acts + Math.ceil(acts / 5) + 1 + 2;
}

export function validateOptimizeInput(raw: unknown): OptimizeInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const billSize = Number(body.billSize ?? 3);
  if (!Number.isInteger(billSize) || billSize < LIMITS.billMin || billSize > LIMITS.billMax) {
    throw new InputError(`Bill size must be ${LIMITS.billMin}-${LIMITS.billMax}.`);
  }
  const acts = lines(body.acts).map(parseAct);
  const seen = new Set<string>();
  for (const a of acts) {
    if (seen.has(a.name.toLowerCase())) throw new InputError(`"${a.name}" is listed twice.`);
    seen.add(a.name.toLowerCase());
  }
  if (acts.length < billSize + 1) throw new InputError(`List at least ${billSize + 1} acts: your ${billSize}-act draft lineup first, then alternates.`);
  if (acts.length > LIMITS.acts) throw new InputError(`Up to ${LIMITS.acts} candidate acts.`);
  const slots = lines(body.slots).map(parseSlot);
  if (!slots.length) throw new InputError("Add at least one venue line: Venue | City | YYYY-MM-DD.");
  if (slots.length > LIMITS.slots) throw new InputError(`Up to ${LIMITS.slots} venue/date options.`);
  const brands = lines(body.brands).map((b) => name(b, "Brand"));
  if (!brands.length) throw new InputError("Add at least one target sponsor brand.");
  if (brands.length > LIMITS.brands) throw new InputError(`Up to ${LIMITS.brands} target brands.`);
  const goal = GOALS.includes(body.goal as Goal) ? (body.goal as Goal) : "sponsor_fit";
  const budget = Number(body.budget ?? LIMITS.budgetDefault);
  if (!Number.isInteger(budget) || budget < LIMITS.budgetMin || budget > LIMITS.budgetMax) {
    throw new InputError(`Qloo call budget must be ${LIMITS.budgetMin}-${LIMITS.budgetMax}.`);
  }
  const needed = minimumBudget(acts.length, brands.length);
  if (budget < needed) throw new InputError(`With ${acts.length} acts and ${brands.length} brand${brands.length > 1 ? "s" : ""}, the agent needs a budget of at least ${needed} Qloo calls (setup uses ${needed - 2}).`);
  const draftDate = slots[0]!.date;
  const blocked = acts.slice(0, billSize).filter((a) => draftDate && a.unavailable.includes(draftDate));
  if (blocked.length) throw new InputError(`Draft lineup conflict: ${blocked.map((a) => a.name).join(", ")} unavailable on ${draftDate}.`);
  return { acts, slots, brands, billSize, goal, budget, pins: pinsFrom(body.pins) };
}

/** "Event | Act A, Act B | Venue | City | YYYY-MM-DD | $8,000" (venue, date and ask optional). */
export function parseEvent(line: string): EventListing {
  const [eventName = "", actsText = "", venue = "", city = "", date = "", ask = ""] = line.split("|").map((s) => s.trim());
  const acts = actsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => name(a, "Act"));
  if (!acts.length) throw new InputError(`Event line "${line}" needs acts: Event | Act A, Act B | Venue | City | Date | $Ask.`);
  if (acts.length > LIMITS.actsPerEvent) throw new InputError(`Up to ${LIMITS.actsPerEvent} acts per event.`);
  if (!city) throw new InputError(`Event line "${line}" needs a city.`);
  if (date && !DATE.test(date)) throw new InputError(`Date in "${line}" must be YYYY-MM-DD.`);
  const askNum = ask ? Number(ask.replace(/[$,\s]/g, "").replace(/k$/i, "000")) : undefined;
  if (ask && (!Number.isFinite(askNum) || askNum! < 0)) throw new InputError(`Ask in "${line}" must be a dollar amount.`);
  return { name: name(eventName, "Event"), acts, ...(venue ? { venue: name(venue, "Venue") } : {}), city: name(city, "City"), ...(date ? { date } : {}), ...(askNum !== undefined ? { askUsd: askNum } : {}) };
}

export function validateSponsorInput(raw: unknown): SponsorInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const brand = name(text(body.brand, 100), "Brand");
  const budgetRaw = body.budgetUsd;
  const budgetUsd = budgetRaw === undefined || budgetRaw === "" || budgetRaw === null ? undefined : Number(String(budgetRaw).replace(/[$,\s]/g, ""));
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) throw new InputError("Budget must be a dollar amount.");
  const events = lines(body.events).map(parseEvent);
  if (events.length < 2) throw new InputError("Paste at least two events to compare.");
  if (events.length > LIMITS.events) throw new InputError(`Up to ${LIMITS.events} events.`);
  return { brand, ...(budgetUsd !== undefined ? { budgetUsd } : {}), events, pins: pinsFrom(body.pins) };
}
