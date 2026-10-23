"use client";

import { useEffect, useRef, useState } from "react";
import type { Choice, SponsorEvent, SponsorResult } from "@/lib/optimizer/types";
import { score, signed, usd } from "./format";
import { CallList, ChoiceList } from "./Shared";
import { readNdjson } from "./stream";

// Sample listings are illustrative, not real announced shows.
const EVENTS = [
  "Harbor Lights Fest | Khruangbin, Men I Trust | Santa Barbara Bowl | Santa Barbara | 2026-11-14 | $12,000",
  "Desert Sessions Night | Mdou Moctar, Hermanos Gutiérrez | The Novo | Los Angeles | 2026-11-21 | $8,000",
  "Soul on State | Leon Bridges | Arlington Theatre | Santa Barbara | 2026-12-05 | $9,500",
  "Surf & Sound | Allah-Las, Cuco | The Observatory | Santa Ana | 2026-12-12 | $6,000",
  "Loop Pedal Live | Tash Sultana | The Wiltern | Los Angeles | 2027-01-16 | $15,000",
].join("\n");

const EXAMPLE = {
  mock: { brand: "Tidewater Cold Brew", budgetUsd: "10000", events: EVENTS },
  live: { brand: "Liquid Death", budgetUsd: "10000", events: EVENTS },
};

type Step = Extract<SponsorEvent, { type: "step" }>;

export function SponsorView({ qlooMode, autorun = false }: { qlooMode: "live" | "mock"; autorun?: boolean }) {
  const [form, setForm] = useState(EXAMPLE[qlooMode]);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<Step[]>([]);
  const [result, setResult] = useState<SponsorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function run(activePins: Record<string, string>) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setSteps([]);
    setResult(null);
    setError(null);
    try {
      const response = await fetch("/api/sponsor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, pins: activePins }),
        signal: controller.signal,
      });
      await readNdjson<SponsorEvent>(response, (e) => {
        if (e.type === "step") setSteps((s) => [...s.filter((x) => x.step !== e.step), e]);
        else if (e.type === "result") setResult(e.result);
        else setError(e.message);
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const started = useRef(false);
  useEffect(() => {
    if (!autorun || started.current) return;
    started.current = true;
    queueMicrotask(() => void run({}));
    // run is recreated each render; autorun fires once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autorun]);

  const onPick = (choice: Choice, id: string) => {
    const next = { ...pins, [choice.input]: id };
    setPins(next);
    void run(next);
  };
  const maxIndex = Math.max(150, ...(result?.events.map((e) => e.index) ?? []));
  const choices = steps.flatMap((s) => s.choices ?? []);

  return (
    <main className="grid">
      <section className="panel form-panel" aria-labelledby="sponsor-heading">
        <h2 id="sponsor-heading">Your brand</h2>
        <form
          className="event-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(pins);
          }}
        >
          <div className="row">
            <label>
              Brand
              <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} required />
            </label>
            <label>
              Budget (USD)
              <input inputMode="numeric" value={form.budgetUsd} onChange={(e) => setForm({ ...form, budgetUsd: e.target.value })} />
            </label>
          </div>
          <label>
            Events you are weighing <span className="hint">Event | Act A, Act B | Venue | City | YYYY-MM-DD | $Ask</span>
            <textarea rows={9} value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} required />
          </label>
          <p className="small muted">
            Qloo has no event listings, so paste the events you are considering (the sample list is illustrative). The agent ranks every act and venue
            against your brand&apos;s audience in shared qloo_rank calls, so all events land on one scale.
          </p>
          <button type="submit" disabled={running}>
            {running ? "Ranking events..." : "Rank events for my audience"}
          </button>
        </form>
        {steps.length > 0 && (
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.step} className={`step ${s.status}`}>
                <div className="step-head">
                  <span className="step-dot" aria-hidden>
                    {s.status === "done" ? "✓" : s.status === "error" ? "!" : "…"}
                  </span>
                  <span className="step-label">{s.step}</span>
                </div>
                {s.summary && <p className="step-summary">{s.summary}</p>}
                {((s.notes && s.notes.length > 0) || (s.calls && s.calls.length > 0)) && (
                  <details>
                    <summary>Notes{s.calls?.length ? ` and ${s.calls.length} MCP tool call${s.calls.length > 1 ? "s" : ""}` : ""}</summary>
                    <ul className="decisions">
                      {(s.notes ?? []).map((n, j) => (
                        <li key={j}>{n}</li>
                      ))}
                    </ul>
                    {s.calls && <CallList calls={s.calls} />}
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
        {choices.length > 0 && <ChoiceList choices={choices} onPick={onPick} disabled={running} />}
      </section>

      <section className="results" aria-live="polite">
        {!result && !running && !error && (
          <div className="panel empty">
            <p>
              Sponsor side: tell the agent your brand and budget, paste the events you are weighing, and it ranks them by how strongly each lineup and
              venue over-index for your brand&apos;s Qloo audience, flags which asks fit the budget, and shows the tastes you share with the top pick.
            </p>
          </div>
        )}
        {error && (
          <p className="error panel" role="alert">
            {error}
          </p>
        )}
        {result && (
          <>
            {result.recommendation && (
              <section className="panel final">
                <h2>Best fit: {result.recommendation.eventName}</h2>
                <p>{result.recommendation.reason}</p>
                {result.sharedTastes?.layout === "parsed" ? (
                  <div>
                    <h4>Tastes {result.brand.name}&apos;s audience shares with this lineup</h4>
                    <div className="chips">
                      {result.sharedTastes.shared.slice(0, 6).map((t) => (
                        <span key={t.id} className="chip strong" title="similarity score from qloo_compare_audiences">
                          {t.name} <span className="chip-score">{score(t.score)}</span>
                        </span>
                      ))}
                    </div>
                    {result.sharedTastes.onlyB.length > 0 && (
                      <p className="small">Only on the event side: {result.sharedTastes.onlyB.slice(0, 4).map((t) => t.name).join(", ")}</p>
                    )}
                    <p className="small muted">qloo_compare_audiences: your brand vs. the event&apos;s acts and venue, in one request.</p>
                  </div>
                ) : result.sharedTastes ? (
                  <p className="small muted">Shared tastes: {result.sharedTastes.note ?? result.sharedTastes.layout}</p>
                ) : null}
              </section>
            )}
            <div className="event-list">
              {result.events.map((e) => (
                <article key={e.listing.name} className="panel event-card">
                  <div className="event-head">
                    <span className="rank">#{e.rank}</span>
                    <div className="brand-title">
                      <h3>{e.listing.name}</h3>
                      <p className="small muted">
                        {e.venue?.name ?? e.listing.venue ?? "Venue n/a"}, {e.listing.city}
                        {e.listing.date ? ` · ${e.listing.date}` : ""}
                        {e.listing.askUsd !== undefined ? ` · ask ${usd(e.listing.askUsd)}` : ""}
                      </p>
                    </div>
                    {e.withinBudget !== undefined && <span className={`badge ${e.withinBudget ? "ok" : "warn"}`}>{e.withinBudget ? "fits budget" : "over budget"}</span>}
                  </div>
                  <div className="index-row">
                    <span className="small">Index</span>
                    <div className="index-track" aria-hidden>
                      <span className="index-avg" style={{ left: `${(100 / maxIndex) * 100}%` }} />
                      <span className="index-fill" style={{ width: `${(e.index / maxIndex) * 100}%` }} />
                    </div>
                    <span className="tabular strong">{e.index}</span>
                  </div>
                  <div className="chips">
                    {e.acts.map((a) => (
                      <span key={a.input} className="chip">
                        {a.name} <span className="chip-score">{score(a.affinity)}</span>
                        {a.momentum ? <span className="chip-score"> · {signed(a.momentum.value * 100, 0)}%</span> : null}
                      </span>
                    ))}
                    {e.venue && (
                      <span className="chip venue">
                        {e.venue.name} <span className="chip-score">{score(e.venue.affinity)}</span>
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <p className="footnote">
              {result.toolCallCount} Qloo MCP tool calls. Score = 75% mean act affinity + 25% venue affinity for {result.brand.name}&apos;s audience (one
              qloo_rank scale); index 100 = the average of the events you pasted. Chip numbers are affinities; percentages are 20-week momentum (window ending about four months ago, since trend data lags) from
              qloo_trends. Affinity describes aggregate taste associations, not attendance or sales.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
