"use client";

import { useRef, useState } from "react";
import type { AgentEvent, AgentResult, BrandEvidence, Choice, Pitch, StepEvent, StepId } from "@/lib/agent/types";
import type { QlooToolCallRecord } from "@/lib/qloo/types";
import { AudiencePanel } from "./AudiencePanel";
import { BrandCard } from "./BrandCard";

const STEP_ORDER: Array<{ id: StepId; label: string; hint: string }> = [
  { id: "resolve", label: "Resolve", hint: "qloo_describe for performers, venue and city; qloo_find_tags for a category" },
  { id: "profile", label: "Profile", hint: "qloo_audience_demographics and qloo_entity_tags for the lineup" },
  { id: "rank", label: "Rank", hint: "qloo_recommend brands for this lineup in this city; qloo_rank your own list" },
  { id: "explain", label: "Explain", hint: "Brand tags, brand demographics and local hotspots (qloo_where_popular)" },
  { id: "draft", label: "Draft", hint: "One pitch per brand from evidence only" },
];

interface Mode {
  qloo: "live" | "mock";
  llm: "nemotron" | "template";
  model?: string;
}

interface FormState {
  performers: string;
  venue: string;
  city: string;
  date: string;
  category: string;
  brands: string;
}

const EXAMPLE: FormState = {
  performers: "Khruangbin\nLeon Bridges",
  venue: "Santa Barbara Bowl",
  city: "Santa Barbara",
  date: "2026-11-14",
  category: "",
  brands: "",
};

type StepState = Partial<Record<StepId, StepEvent>>;

const STATUS_CLASS: Record<string, string> = {
  ok: "ok",
  partial: "warn",
  degraded: "warn",
  needs_input: "warn",
  empty: "muted",
  error: "bad",
  failed: "bad",
};

function argSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.map((x) => (String(x).length > 14 ? `${String(x).slice(0, 8)}…` : x)).join(", ")}]` : String(v)}`)
    .join(" ");
}

function CallList({ calls }: { calls: QlooToolCallRecord[] }) {
  return (
    <ul className="requests">
      {calls.map((c, j) => (
        <li key={j}>
          <code>
            {c.tool} {argSummary(c.args)}
          </code>{" "}
          <span className={`badge tiny ${STATUS_CLASS[c.status] ?? "muted"}`}>{c.status}</span>
          {c.attempts && c.attempts > 1 ? <span className="cached"> retried</span> : null}
          {c.summary && c.status !== "ok" ? <div className="muted small">{c.summary}</div> : null}
          {c.requests && c.requests.length > 0 && (
            <div className="muted small">
              {c.requests.map((r, k) => (
                <div key={k}>
                  GET {r.path}
                  {r.query && typeof r.query === "object"
                    ? `?${Object.entries(r.query as Record<string, unknown>)
                        .map(([qk, qv]) => `${qk}=${Array.isArray(qv) ? qv.join(",") : String(qv)}`)
                        .join("&")}`
                    : ""}
                </div>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ChoiceList({ choices, onPick, disabled }: { choices: Choice[]; onPick: (c: Choice, id: string) => void; disabled: boolean }) {
  return (
    <div className="choices">
      {choices.map((c, i) => (
        <div key={i} className="choice">
          <p className="small">
            <strong>
              {c.field} &ldquo;{c.input}&rdquo;
            </strong>{" "}
            is {c.kind.replace(/_/g, " ")}
            {c.chosen ? `; using ${c.chosen.name} for now` : ""}.
            {c.candidates.length > 0 && (c.field === "performer" || c.field === "venue" || c.field === "city" || c.field === "brand")
              ? " Pick the right one to re-run:"
              : ""}
          </p>
          {c.candidates.length > 0 && (
            <div className="chips">
              {c.candidates.map((cand) =>
                c.field === "category" ? (
                  <span key={cand.id} className="chip" title={cand.id}>
                    {cand.name}
                  </span>
                ) : (
                  <button
                    key={cand.id}
                    type="button"
                    className={`chip-button ${c.chosen?.id === cand.id ? "active" : ""}`}
                    title={cand.description ?? cand.id}
                    disabled={disabled}
                    onClick={() => onPick(c, cand.id)}
                  >
                    {cand.name}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SponsorMatchApp({ mode }: { mode: Mode }) {
  const [form, setForm] = useState<FormState>(EXAMPLE);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<StepState>({});
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const update = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function run(activePins: Record<string, string>) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setSteps({});
    setResult(null);
    setError(null);

    const handleEvent = (event: AgentEvent) => {
      if (event.type === "step") setSteps((s) => ({ ...s, [event.step]: event }));
      else if (event.type === "result") setResult(event.result);
      else if (event.type === "error") {
        setError(event.message);
        setSteps((s) => {
          const stepId = event.step;
          if (!stepId || s[stepId]?.status !== "running") return s;
          return { ...s, [stepId]: { ...s[stepId]!, status: "error" } };
        });
      }
    };

    try {
      const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);
      const response = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          performers: lines(form.performers),
          venue: form.venue,
          city: form.city,
          date: form.date,
          category: form.category,
          brands: lines(form.brands),
          pins: activePins,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handleEvent(JSON.parse(line) as AgentEvent);
          newline = buffer.indexOf("\n");
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(pins);
  };

  const onPick = (choice: Choice, id: string) => {
    const next = { ...pins, [choice.input]: id };
    setPins(next);
    void run(next);
  };

  const pitchFor = (b: BrandEvidence): Pitch | undefined => result?.pitches.find((p) => p.brandId === b.id);
  const pinCount = Object.keys(pins).length;

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>SponsorMatch</h1>
          <p className="tagline">Find the brands your audience already loves, with Qloo taste-graph evidence and a ready-to-send pitch for each.</p>
        </div>
        <div className="badges" aria-label="Data sources">
          <span className={`badge ${mode.qloo === "live" ? "ok" : "warn"}`}>Qloo: {mode.qloo === "live" ? "live via qloo mcp" : "mock data"}</span>
          <span className={`badge ${mode.llm === "nemotron" ? "ok" : "muted"}`}>Pitches: {mode.llm === "nemotron" ? mode.model : "template"}</span>
        </div>
      </header>

      {mode.qloo === "mock" && (
        <div className="notice" role="note">
          Mock mode: no Qloo key is configured, so results come from synthetic fixtures with fictional brands and invented scores. They are not
          Qloo data. (Try &ldquo;Phoenix&rdquo; as a performer to see how ambiguous names are handled.)
        </div>
      )}

      <main className="grid">
        <section className="panel form-panel" aria-labelledby="event-heading">
          <h2 id="event-heading">Your event</h2>
          <form onSubmit={onSubmit} className="event-form">
            <label>
              Performers <span className="hint">one per line, up to 5</span>
              <textarea rows={3} value={form.performers} onChange={update("performers")} required />
            </label>
            <label>
              Venue <span className="hint">optional</span>
              <input value={form.venue} onChange={update("venue")} />
            </label>
            <div className="row">
              <label>
                City
                <input value={form.city} onChange={update("city")} required />
              </label>
              <label>
                Date
                <input type="date" value={form.date} onChange={update("date")} />
              </label>
            </div>
            <label>
              Sponsor category <span className="hint">optional, e.g. beverage, footwear</span>
              <input value={form.category} onChange={update("category")} />
            </label>
            <label>
              Brands you&apos;re already considering <span className="hint">optional, one per line</span>
              <textarea rows={2} value={form.brands} onChange={update("brands")} />
            </label>
            <button type="submit" disabled={running}>
              {running ? "Agent running..." : "Find sponsors"}
            </button>
            {pinCount > 0 && (
              <p className="small muted">
                {pinCount} confirmed match{pinCount > 1 ? "es" : ""}.{" "}
                <button type="button" className="link" onClick={() => setPins({})} disabled={running}>
                  Clear
                </button>
              </p>
            )}
          </form>

          <h2 className="steps-heading">Agent steps</h2>
          <ol className="steps">
            {STEP_ORDER.map((s, i) => {
              const ev = steps[s.id];
              const status = ev?.status ?? "pending";
              return (
                <li key={s.id} className={`step ${status}`}>
                  <div className="step-head">
                    <span className="step-dot" aria-hidden>
                      {status === "done" ? "✓" : status === "error" ? "!" : i + 1}
                    </span>
                    <span className="step-label">{s.label}</span>
                    <span className="step-status">{status === "running" ? "running" : status === "pending" ? "" : status}</span>
                  </div>
                  <p className="step-summary">{ev?.summary ?? s.hint}</p>
                  {ev?.warnings && ev.warnings.length > 0 && (
                    <ul className="warnings">
                      {ev.warnings.map((w, j) => (
                        <li key={j}>{w}</li>
                      ))}
                    </ul>
                  )}
                  {ev?.choices && ev.choices.length > 0 && <ChoiceList choices={ev.choices} onPick={onPick} disabled={running} />}
                  {((ev?.decisions && ev.decisions.length > 0) || (ev?.calls && ev.calls.length > 0)) && (
                    <details>
                      <summary>
                        Decisions ({ev?.decisions?.length ?? 0}){ev?.calls?.length ? ` and ${ev.calls.length} MCP tool call${ev.calls.length > 1 ? "s" : ""}` : ""}
                      </summary>
                      <ul className="decisions">
                        {(ev?.decisions ?? []).map((d, j) => (
                          <li key={j}>{d}</li>
                        ))}
                      </ul>
                      {ev?.calls && ev.calls.length > 0 && <CallList calls={ev.calls} />}
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="results" aria-live="polite" aria-labelledby="results-heading">
          <h2 id="results-heading" className="sr-only">
            Results
          </h2>
          {!result && !running && !error && (
            <div className="panel empty">
              <p>
                Enter a lineup and city, then run the agent. It resolves the event in Qloo, profiles the audience, ranks brands by affinity, explains
                each match and drafts a pitch. Every Qloo call goes through the official Qloo harness (qloo mcp).
              </p>
            </div>
          )}
          {running && !result && <div className="panel empty">Working through the steps on the left...</div>}
          {result && (
            <>
              <AudiencePanel result={result} />
              <div className="brand-list">
                {result.brands.map((b) => (
                  <BrandCard key={b.id} brand={b} pitch={pitchFor(b)} mock={result.mode.qloo === "mock"} />
                ))}
              </div>
              <p className="footnote">
                {result.toolCallCount} Qloo MCP tool calls. Sponsor fit = 60% Qloo affinity + 25% audience tag overlap + 15% demographic alignment
                (weights renormalize when a part is missing). Affinity scores describe aggregate taste associations, not individual people, and do not
                predict sales.
              </p>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
