"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentEvent, AgentResult, BrandEvidence, Pitch, StepEvent, StepId } from "@/lib/agent/types";
import { AudiencePanel } from "./AudiencePanel";
import { BrandCard } from "./BrandCard";

const STEP_ORDER: Array<{ id: StepId; label: string; hint: string }> = [
  { id: "resolve", label: "Resolve", hint: "Match performers, venue and city to Qloo entities" },
  { id: "profile", label: "Profile", hint: "Audience demographics and brand-taste tags" },
  { id: "rank", label: "Rank", hint: "Brand affinity for the lineup in this city" },
  { id: "explain", label: "Explain", hint: "Shared tags, demographic fit, local presence" },
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
}

const EXAMPLE: FormState = {
  performers: "Khruangbin\nLeon Bridges",
  venue: "Santa Barbara Bowl",
  city: "Santa Barbara",
  date: "2026-11-14",
  category: "",
};

type StepState = Partial<Record<StepId, StepEvent>>;

export function SponsorMatchApp({ mode }: { mode: Mode }) {
  const [form, setForm] = useState<FormState>(EXAMPLE);
  const [steps, setSteps] = useState<StepState>({});
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const update = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const run = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setSteps({});
      setResult(null);
      setError(null);
      try {
        const response = await fetch("/api/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            performers: form.performers.split("\n").map((s) => s.trim()).filter(Boolean),
            venue: form.venue,
            city: form.city,
            date: form.date,
            category: form.category,
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

      function handleEvent(event: AgentEvent) {
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
      }
    },
    [form],
  );

  const pitchFor = (b: BrandEvidence): Pitch | undefined => result?.pitches.find((p) => p.brandId === b.id);

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>SponsorMatch</h1>
          <p className="tagline">Find the brands your audience already loves, with Qloo taste-graph evidence and a ready-to-send pitch for each.</p>
        </div>
        <div className="badges" aria-label="Data sources">
          <span className={`badge ${mode.qloo === "live" ? "ok" : "warn"}`}>
            Qloo: {mode.qloo === "live" ? "live API" : "mock data"}
          </span>
          <span className={`badge ${mode.llm === "nemotron" ? "ok" : "muted"}`}>
            Pitches: {mode.llm === "nemotron" ? mode.model : "template"}
          </span>
        </div>
      </header>

      {mode.qloo === "mock" && (
        <div className="notice" role="note">
          Mock mode: no Qloo key is configured, so results come from synthetic fixtures with fictional brands and invented scores. They are
          not Qloo data.
        </div>
      )}

      <main className="grid">
        <section className="panel form-panel" aria-labelledby="event-heading">
          <h2 id="event-heading">Your event</h2>
          <form onSubmit={run} className="event-form">
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
            <button type="submit" disabled={running}>
              {running ? "Agent running..." : "Find sponsors"}
            </button>
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
                  {ev?.decisions && ev.decisions.length > 0 && (
                    <details>
                      <summary>
                        Decisions ({ev.decisions.length}){ev.requests?.length ? ` and ${ev.requests.length} Qloo calls` : ""}
                      </summary>
                      <ul className="decisions">
                        {ev.decisions.map((d, j) => (
                          <li key={j}>{d}</li>
                        ))}
                      </ul>
                      {ev.requests && ev.requests.length > 0 && (
                        <ul className="requests">
                          {ev.requests.map((r, j) => (
                            <li key={j}>
                              <code>
                                GET {r.path}?{new URLSearchParams(r.query).toString().replace(/%3A/g, ":").replace(/%2C/g, ",")}
                              </code>
                              {r.cached ? <span className="cached">cached</span> : null}
                            </li>
                          ))}
                        </ul>
                      )}
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
              <p>Enter a lineup and city, then run the agent. It resolves the event in Qloo, profiles the audience, ranks brands by affinity, explains each match and drafts a pitch.</p>
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
                {result.requestCount} Qloo requests. Sponsor fit = 60% Qloo affinity + 25% audience tag overlap + 15% demographic alignment
                (weights renormalize when a part is missing). Affinity scores describe aggregate taste associations, not individual people,
                and do not predict sales.
              </p>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
