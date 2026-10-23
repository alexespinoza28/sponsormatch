import { interpretedEntity, issueCandidates, resolutionIssues, resultEntities, resultTags } from "@/lib/qloo/normalize";
import type { InsightsEntityType, QlooCandidate, QlooTools, SearchEntityType } from "@/lib/qloo/types";
import { classify } from "./budget";
import { parseTrends, rankAffinities, tasteOverlap } from "./parse";
import { round } from "./scoring";
import type { Choice, Momentum, ResolvedEntity, TagAffinity, TasteOverlap } from "./types";

// Qloo evidence-gathering steps shared by the optimizer and the sponsor-side
// ranker. Each function makes a known, small number of MCP tool calls and
// returns parsed evidence. Entities are resolved once and passed on as IDs:
// the live API answers needs_input when a bare act name in `signals` matches
// both an artist and a person.

export class Notes {
  notes: string[] = [];
  warnings: string[] = [];
  choices: Choice[] = [];
  take() {
    const out = { notes: this.notes, warnings: this.warnings.length ? this.warnings : undefined, choices: this.choices.length ? this.choices : undefined };
    this.notes = [];
    this.warnings = [];
    this.choices = [];
    return out;
  }
}

function check(notes: Notes, env: Parameters<typeof classify>[0], label: string) {
  const c = classify(env);
  if (c.warning) notes.warnings.push(`${label}: ${c.warning}`);
  if (c.status === "error") notes.notes.push(`${label} failed (${c.error}).`);
  if (c.status === "empty") notes.notes.push(`${label}: Qloo returned no results.`);
  return c.status;
}

/** qloo_describe with needs_input handling: continues with the top candidate and records the choice. */
export async function describeEntity(
  qloo: QlooTools,
  notes: Notes,
  text: string,
  type: SearchEntityType,
  field: Choice["field"],
  pins: Record<string, string>,
): Promise<ResolvedEntity | undefined> {
  const pinned = pins[text];
  const env = await qloo.call("qloo_describe", { entity: pinned ?? text, type });
  const status = check(notes, env, `Describe "${text}"`);
  if (status === "ok") {
    const e = interpretedEntity(env);
    const r = resultEntities(env)[0];
    const id = e?.entityId ?? r?.entity_id;
    const name = e?.name ?? r?.name;
    if (id && name) return { input: text, id, name, match: pinned ? "confirmed" : (e?.match ?? "resolved") };
  }
  if (status === "needs_input") {
    const issue = resolutionIssues(env)[0];
    const candidates = issue ? issueCandidates(issue) : [];
    const choice: Choice = { field, input: text, kind: issue?.kind ?? "needs_input", candidates };
    notes.choices.push(choice);
    const top = candidates[0];
    if (top) {
      choice.chosen = { id: top.id, name: top.name };
      notes.notes.push(`"${text}" is ${choice.kind} in Qloo; continuing with ${top.name}. Pick another to re-run.`);
      return { input: text, id: top.id, name: top.name, match: "agent_pick" };
    }
    notes.notes.push(`"${text}" needs input and Qloo offered no candidates.`);
  }
  return undefined;
}

function pickCandidate(candidates: QlooCandidate[], hint?: string): QlooCandidate | undefined {
  if (hint) {
    const h = hint.toLowerCase();
    const hit = candidates.find((c) => JSON.stringify(c.address ?? c.description ?? "").toLowerCase().includes(h));
    if (hit) return hit;
  }
  return candidates[0];
}

export interface RankedOption {
  input: string;
  id: string;
  name: string;
  affinity: number;
  match: string;
}

/**
 * qloo_rank over a set of named options against entity-ID signals. Options
 * are passed as names (resolution is scoped by option_type) unless pinned.
 * A needs_input answer is fixed once by substituting the top candidate's ID.
 * More than 10 options are split into calls that share one anchor option; the
 * later calls are rescaled by the anchor's affinity ratio, because qloo_rank
 * scores from separate calls are not directly comparable.
 */
export async function rankOptions(
  qloo: QlooTools,
  notes: Notes,
  args: {
    options: string[];
    optionType: InsightsEntityType;
    signals: string[];
    signalLocation?: string;
    pins: Record<string, string>;
    field: Choice["field"];
    label: string;
    /** Used to pick among venue candidates (e.g. the city). */
    hints?: Record<string, string>;
  },
): Promise<Map<string, RankedOption>> {
  const out = new Map<string, RankedOption>();
  const unique = [...new Set(args.options)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; ) {
    const size = chunks.length === 0 ? 10 : 9;
    chunks.push(unique.slice(i, i + size));
    i += size;
  }
  let anchor: RankedOption | undefined;
  for (const [ci, chunk] of chunks.entries()) {
    const inputs = ci > 0 && anchor ? [anchor.input, ...chunk] : chunk;
    // option text sent to Qloo -> original input
    const sent = new Map<string, string>(inputs.map((i) => [args.pins[i] ?? (anchor && i === anchor.input ? anchor.id : i), i]));
    let result: Map<string, RankedOption> | undefined;
    for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
      const env = await qloo.call("qloo_rank", {
        options: [...sent.keys()],
        option_type: args.optionType,
        signals: args.signals,
        ...(args.signalLocation ? { signal_location: args.signalLocation } : {}),
      });
      const status = check(notes, env, `${args.label}${chunks.length > 1 ? ` (part ${ci + 1})` : ""}`);
      if (status === "ok") {
        const { byId, inputs: interp } = rankAffinities(env);
        result = new Map();
        const names = new Map(resultEntities(env).map((e) => [e.entity_id, e.name]));
        for (const [text, original] of sent) {
          const hit = interp.get(text);
          const id = hit?.id ?? (byId.has(text) ? text : resultEntities(env).find((e) => e.name.toLowerCase() === text.toLowerCase())?.entity_id);
          if (!id || !byId.has(id)) continue;
          const match = args.pins[original] ? "confirmed" : (out.get(original)?.match ?? hit?.match ?? "resolved");
          result.set(original, { input: original, id, name: hit?.name ?? names.get(id) ?? original, affinity: byId.get(id)!, match });
        }
        break;
      }
      if (status !== "needs_input" || attempt === 2) break;
      const issues = resolutionIssues(env).filter((i) => i.field === "options");
      if (!issues.length) break;
      for (const issue of issues) {
        const original = sent.get(issue.input) ?? issue.input;
        const candidates = issueCandidates(issue);
        const top = pickCandidate(candidates, args.hints?.[original]);
        const choice: Choice = { field: args.field, input: original, kind: issue.kind, candidates };
        notes.choices.push(choice);
        sent.delete(issue.input);
        if (top) {
          choice.chosen = { id: top.id, name: top.name };
          sent.set(top.id, original);
          out.set(original, { input: original, id: top.id, name: top.name, affinity: 0, match: "agent_pick" });
          notes.notes.push(`"${original}" is ${issue.kind} in Qloo; continuing with ${top.name}. Pick another to re-run.`);
        } else {
          notes.notes.push(`"${original}" was not found in Qloo; left out.`);
        }
      }
      if (!sent.size) break;
    }
    if (!result) continue;
    let scale = 1;
    if (ci > 0 && anchor) {
      const again = result.get(anchor.input);
      if (again && again.affinity > 0) scale = anchor.affinity / again.affinity;
      result.delete(anchor.input);
      notes.notes.push(`${args.label}: part ${ci + 1} rescaled by anchor ${anchor.name} (x${scale.toFixed(2)}).`);
    }
    for (const [k, v] of result) out.set(k, { ...v, affinity: round(Math.min(1, v.affinity * scale)) });
    if (ci === 0) {
      const sorted = [...result.values()].sort((a, b) => a.affinity - b.affinity);
      anchor = sorted[Math.floor(sorted.length / 2)];
    }
  }
  // Drop placeholders for options that never got a score.
  for (const [k, v] of out) if (v.match === "agent_pick" && v.affinity === 0) out.delete(k);
  return out;
}

/** qloo_entity_tags for one entity. */
export async function entityTags(qloo: QlooTools, notes: Notes, id: string, label: string, limit = 15): Promise<TagAffinity[]> {
  const env = await qloo.call("qloo_entity_tags", { entities: [id], limit });
  if (check(notes, env, `Tags for ${label}`) !== "ok") return [];
  const seen = new Set<string>();
  return resultTags(env)
    .filter((t) => typeof t.affinity === "number" && Number.isFinite(t.affinity) && !seen.has(t.id) && seen.add(t.id))
    .map((t) => ({ id: t.id, name: t.name, affinity: round(t.affinity!) }));
}

/**
 * Trend window. Qloo's trending data lags: in the Oct 22 live probe a window
 * ending today returned no points, while windows ending months earlier did.
 * So the window ends TREND_LAG_DAYS before today and spans 20 weeks, and the
 * call asks for 20 points (one per week).
 */
export const TREND_LAG_DAYS = 120;
export const TREND_WEEKS = 20;

export function trendWindow(now: Date): { start: string; end: string } {
  const end = new Date(now.getTime() - TREND_LAG_DAYS * 86_400_000);
  const start = new Date(end.getTime() - (TREND_WEEKS * 7 - 1) * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** qloo_trends for up to 5 entities per call. */
export async function momentum(
  qloo: QlooTools,
  notes: Notes,
  ids: string[],
  entityType: InsightsEntityType,
  window: { start: string; end: string },
): Promise<Map<string, Momentum>> {
  const out = new Map<string, Momentum>();
  for (let i = 0; i < ids.length; i += 5) {
    const env = await qloo.call("qloo_trends", { entities: ids.slice(i, i + 5), entity_type: entityType, start_date: window.start, end_date: window.end, limit: TREND_WEEKS });
    if (check(notes, env, "Trends") !== "ok") continue;
    for (const [id, m] of parseTrends(env)) out.set(id, m);
  }
  return out;
}

/** One qloo_compare_audiences call (group A vs. group B), read as taste overlap. */
export async function compareTastes(qloo: QlooTools, notes: Notes, groupA: string[], groupB: string[]): Promise<TasteOverlap> {
  const env = await qloo.call("qloo_compare_audiences", { group_a: groupA.slice(0, 10), group_b: groupB.slice(0, 10), limit: 20 });
  const c = classify(env);
  if (c.warning) notes.warnings.push(`Compare audiences: ${c.warning}`);
  return tasteOverlap(env);
}
