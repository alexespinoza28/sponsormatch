"use client";

import { useEffect, useRef, useState } from "react";
import { GOAL_LABELS } from "@/lib/optimizer/scoring";
import type { Choice, Goal, HeadToHead, IterationEvent, LineupScore, OptimizeResult, OptimizerEvent, SetupEvent } from "@/lib/optimizer/types";
import { pct, score, signed } from "./format";
import { ScoreChart, type ChartPoint } from "./ScoreChart";
import { BudgetMeter, CallList, ChoiceList } from "./Shared";
import { readNdjson } from "./stream";

interface FormState {
  acts: string;
  billSize: number;
  slots: string;
  brands: string;
  goal: Goal;
  budget: number;
}

const ACTS = [
  "Mdou Moctar",
  "Men I Trust",
  "Cuco",
  "Tash Sultana",
  "Leon Bridges",
  "Allah-Las",
  "Khruangbin",
  "Hermanos Gutiérrez | not 2026-11-21",
].join("\n");
const SLOTS = "Santa Barbara Bowl | Santa Barbara | 2026-11-14\nThe Novo | Los Angeles | 2026-11-21";

// Mock mode uses the fictional brands from the synthetic catalog; live mode real ones.
const EXAMPLE = {
  mock: { acts: ACTS, billSize: 3, slots: SLOTS, brands: "Tidewater Cold Brew\nSaltline Surf Supply", goal: "sponsor_fit" as Goal, budget: 40 },
  live: { acts: ACTS, billSize: 3, slots: SLOTS, brands: "Liquid Death\nPatagonia", goal: "sponsor_fit" as Goal, budget: 40 },
};

const MAX_ITERATIONS = 10;
const SETUP_PHASES: Array<SetupEvent["phase"]> = ["resolve", "profile", "baseline"];

function Parts({ s }: { s: LineupScore }) {
  return (
    <span className="parts small">
      fit {score(s.parts.fit)}
      {s.parts.cohesion !== undefined ? ` · cohesion ${score(s.parts.cohesion)}` : ""}
      {s.parts.momentum !== undefined ? ` · momentum ${score(s.parts.momentum)}` : ""}
    </span>
  );
}

function H2H({ h }: { h: HeadToHead }) {
  if (h.layout !== "parsed") return <p className="small muted">Head-to-head (qloo_compare_audiences): {h.note ?? h.layout}</p>;
  return (
    <p className="small">
      Head-to-head (qloo_compare_audiences, one request):{" "}
      {h.targetLean !== undefined ? (
        <>
          target brands lean <strong>{signed(h.targetLean, 3)}</strong> toward the {h.targetLean >= 0 ? "new" : "current"} lineup
        </>
      ) : (
        "target brands not among the rows"
      )}
      {h.topGainers.length ? `; biggest gainers: ${h.topGainers.map((g) => `${g.name} ${signed(g.delta ?? 0, 3)}`).join(", ")}` : ""}.
    </p>
  );
}

function TraceItem({ it, current }: { it: IterationEvent; current?: number }) {
  const status = it.phase === "decision" ? (it.accepted ? "accepted" : "rejected") : "pending";
  return (
    <li className={`trace-item ${status}`}>
      <div className="trace-head">
        <span className="trace-num">#{it.iteration}</span>
        <span className="trace-move">{it.moveText}</span>
        <span className={`badge tiny ${it.proposer === "nemotron" ? "ok" : "muted"}`}>{it.proposer === "nemotron" ? "Nemotron" : "heuristic"}</span>
        {it.phase === "decision" ? (
          <span className={`verdict ${status}`}>{it.accepted ? "accepted" : "rejected"}</span>
        ) : (
          <span className="verdict pending">scoring…</span>
        )}
      </div>
      <div className="trace-body">
        <p className="small">
          <span className="lbl">Proposal</span> {it.rationale ?? "No rationale."}
          {it.proposerNote ? <span className="muted"> {it.proposerNote}</span> : null}
        </p>
        {it.phase !== "proposal" && (
          <div className="small">
            <span className="lbl">Qloo evidence</span>{" "}
            {it.candidate ? (
              <>
                qloo_rank: objective <strong>{it.candidate.objective}</strong>
                {current !== undefined ? <span className="muted"> (was {current})</span> : null} · <Parts s={it.candidate} />
                <div className="brand-chips">
                  {it.candidate.brands.map((b) => (
                    <span key={b.id} className="chip">
                      {b.name} <span className="chip-score">{score(b.affinity)}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <span className="muted">none returned</span>
            )}
            {it.headToHead && <H2H h={it.headToHead} />}
          </div>
        )}
        {it.phase === "decision" && (
          <p className={`small decision ${status}`}>
            <span className="lbl">Decision</span> {it.reason}
          </p>
        )}
        {it.explanation && <p className="explain">{it.explanation}</p>}
        {it.calls && it.calls.length > 0 && (
          <details>
            <summary className="small">{it.calls.length} MCP tool call{it.calls.length > 1 ? "s" : ""}</summary>
            <CallList calls={it.calls} />
          </details>
        )}
      </div>
    </li>
  );
}

function FinalCard({ r }: { r: OptimizeResult }) {
  const actById = (id: string) => r.acts.find((a) => a.entity.id === id);
  const slot = r.slots[r.best.lineup.slot]!;
  const improved = r.best.key !== r.draft.key;
  return (
    <section className="panel final" aria-labelledby="final-heading">
      <div className="final-head">
        <div>
          <h2 id="final-heading">Recommended lineup</h2>
          <p className="muted small">
            Goal: {GOAL_LABELS[r.input.goal]} · {slot.label}
          </p>
        </div>
        <div className="fit">
          <span className="fit-num">{r.best.objective}</span>
          <span className="fit-label">{improved ? `draft ${r.draft.objective}` : "draft kept"}</span>
        </div>
      </div>
      <ol className="bill">
        {r.best.lineup.acts.map((id) => {
          const a = actById(id)!;
          const wasDraft = r.draft.lineup.acts.includes(id);
          return (
            <li key={id}>
              <strong>{a.entity.name}</strong> {!wasDraft && <span className="badge tiny ok">new</span>}
              <span className="small muted">
                {" "}
                brand-audience affinity {score(a.brandAffinity)}
                {a.momentum ? ` · momentum ${signed(a.momentum.value * 100, 0)}% (${a.momentum.metric})` : ""}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="evidence-grid">
        {r.best.brands.map((b) => {
          const before = r.draft.brands.find((x) => x.id === b.id);
          return (
            <div key={b.id} className="ev-card">
              <h4>Fit with {b.name}</h4>
              <p className="ev-num">
                {score(b.affinity)} {before && improved ? <span className="delta">{pct(before.affinity, b.affinity)}</span> : null}
              </p>
              <p className="small muted">
                qloo_rank affinity for this bill&apos;s audience{before && improved ? `, draft ${score(before.affinity)}` : ""}.
              </p>
            </div>
          );
        })}
        {r.finalHeadToHead && (
          <div className="ev-card">
            <h4>Draft vs. recommended, head-to-head</h4>
            <H2H h={r.finalHeadToHead} />
          </div>
        )}
        {r.cohesionPairs.length > 0 && (
          <div className="ev-card">
            <h4>Shared audience on the bill</h4>
            <ul className="plain small">
              {r.cohesionPairs.map((p) => (
                <li key={`${p.a}-${p.b}`}>
                  {p.a} + {p.b}: overlap {score(p.overlap)}
                  {p.shared.length ? <span className="muted"> ({p.shared.join(", ")})</span> : null}
                </li>
              ))}
            </ul>
            <p className="small muted">Weighted overlap of each act&apos;s qloo_entity_tags.</p>
          </div>
        )}
        {r.nextSponsors.length > 0 && (
          <div className="ev-card">
            <h4>Next sponsors to pitch</h4>
            <ul className="plain small">
              {r.nextSponsors.map((s) => (
                <li key={s.id}>
                  <strong>{s.name}</strong> {score(s.affinity)}
                  {s.drivers[0] ? <span className="muted"> · driven most by {s.drivers[0].name} ({Math.round(s.drivers[0].score * 100)}%)</span> : null}
                </li>
              ))}
            </ul>
            <p className="small muted">qloo_recommend for this bill and city, with explainability.</p>
          </div>
        )}
      </div>

      {r.acceptedMoves.length > 0 ? (
        <div className="moves">
          <h4>How it got here</h4>
          <ol className="small">
            {r.acceptedMoves.map((m) => (
              <li key={m.iteration}>{m.explanation}</li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="small">No tested change beat your draft on Qloo evidence, so the agent recommends keeping it.</p>
      )}
      <p className="footnote">
        Stopped: {r.stopReason} {r.budget.used} of {r.budget.limit} Qloo calls used ({r.budget.setup} setup). Proposals by{" "}
        {r.mode.proposer === "nemotron" ? r.mode.model : "the built-in heuristic (no NVIDIA key)"}; every score above is a Qloo tool result or arithmetic on
        one. Affinity describes aggregate taste associations, not individual attendees or ticket sales.
      </p>
    </section>
  );
}

export function ProducerView({ qlooMode, autorun = false }: { qlooMode: "live" | "mock"; autorun?: boolean }) {
  const [form, setForm] = useState<FormState>(EXAMPLE[qlooMode]);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [setup, setSetup] = useState<Partial<Record<SetupEvent["phase"], SetupEvent>>>({});
  const [iters, setIters] = useState<IterationEvent[]>([]);
  const [stop, setStop] = useState<string | null>(null);
  const [budget, setBudget] = useState<{ used: number; limit: number; setup: number } | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function run(activePins: Record<string, string>) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setSetup({});
    setIters([]);
    setStop(null);
    setBudget(null);
    setResult(null);
    setError(null);
    const onEvent = (e: OptimizerEvent) => {
      if ("budget" in e) setBudget(e.budget);
      if (e.type === "setup") setSetup((s) => ({ ...s, [e.phase]: e }));
      else if (e.type === "iteration") setIters((xs) => [...xs.filter((x) => x.iteration !== e.iteration), e].sort((a, b) => a.iteration - b.iteration));
      else if (e.type === "stop") setStop(e.reason);
      else if (e.type === "result") {
        setResult(e.result);
        setBudget(e.result.budget);
      }
      else if (e.type === "error") setError(e.message);
    };
    try {
      const response = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, pins: activePins }),
        signal: controller.signal,
      });
      await readNdjson(response, onEvent);
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

  // Chart points: the draft, then each decided iteration.
  const points: ChartPoint[] = [];
  const currentBefore = new Map<number, number>();
  const draft = setup.baseline?.score;
  if (draft) {
    let best = draft.objective;
    points.push({ iteration: 0, objective: best, accepted: true, best, label: "your draft" });
    for (const it of iters) {
      currentBefore.set(it.iteration, best);
      if (it.phase !== "decision" || !it.candidate) continue;
      if (it.accepted) best = it.candidate.objective;
      points.push({ iteration: it.iteration, objective: it.candidate.objective, accepted: !!it.accepted, best, label: it.moveText });
    }
  }
  const choices = SETUP_PHASES.flatMap((p) => setup[p]?.choices ?? []);
  const pinCount = Object.keys(pins).length;

  return (
    <main className="grid">
      <section className="panel form-panel" aria-labelledby="producer-heading">
        <h2 id="producer-heading">Your show</h2>
        <form
          className="event-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(pins);
          }}
        >
          <label>
            Candidate acts{" "}
            <span className="hint">
              first {form.billSize} = your draft bill, rest = alternates; add &ldquo;| not YYYY-MM-DD&rdquo; for conflicts
            </span>
            <textarea rows={8} value={form.acts} onChange={(e) => set("acts", e.target.value)} required />
          </label>
          <label>
            Venue and date options <span className="hint">Venue | City | YYYY-MM-DD, first = draft</span>
            <textarea rows={3} value={form.slots} onChange={(e) => set("slots", e.target.value)} required />
          </label>
          <label>
            Target sponsors <span className="hint">1-3 brands, first = primary</span>
            <textarea rows={2} value={form.brands} onChange={(e) => set("brands", e.target.value)} required />
          </label>
          <div className="row">
            <label>
              Bill size
              <select value={form.billSize} onChange={(e) => set("billSize", Number(e.target.value))}>
                {[2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} acts
                  </option>
                ))}
              </select>
            </label>
            <label>
              Qloo call budget
              <input type="number" min={12} max={60} value={form.budget} onChange={(e) => set("budget", Number(e.target.value))} />
            </label>
          </div>
          <fieldset className="goal">
            <legend>Optimize for</legend>
            {(Object.keys(GOAL_LABELS) as Goal[]).map((g) => (
              <label key={g} className="radio">
                <input type="radio" name="goal" value={g} checked={form.goal === g} onChange={() => set("goal", g)} />
                {GOAL_LABELS[g]}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={running}>
            {running ? "Agent searching..." : "Optimize lineup"}
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

        <h2 className="steps-heading">Setup</h2>
        <ol className="steps">
          {SETUP_PHASES.map((p, i) => {
            const ev = setup[p];
            const status = ev?.status ?? "pending";
            return (
              <li key={p} className={`step ${status}`}>
                <div className="step-head">
                  <span className="step-dot" aria-hidden>
                    {status === "done" ? "✓" : status === "error" ? "!" : i + 1}
                  </span>
                  <span className="step-label">{ev?.title ?? ["Resolve sponsors, acts and venues", "Profile each act: taste tags and momentum", "Score your draft lineup"][i]}</span>
                </div>
                {ev?.summary && <p className="step-summary">{ev.summary}</p>}
                {ev?.warnings && ev.warnings.length > 0 && (
                  <ul className="warnings">
                    {ev.warnings.map((w, j) => (
                      <li key={j}>{w}</li>
                    ))}
                  </ul>
                )}
                {((ev?.notes && ev.notes.length > 0) || (ev?.calls && ev.calls.length > 0)) && (
                  <details>
                    <summary>
                      Notes{ev?.calls?.length ? ` and ${ev.calls.length} MCP tool call${ev.calls.length > 1 ? "s" : ""}` : ""}
                    </summary>
                    <ul className="decisions">
                      {(ev?.notes ?? []).map((d, j) => (
                        <li key={j}>{d}</li>
                      ))}
                    </ul>
                    {ev?.calls && <CallList calls={ev.calls} />}
                  </details>
                )}
              </li>
            );
          })}
        </ol>
        {choices.length > 0 && <ChoiceList choices={choices} onPick={onPick} disabled={running} />}
      </section>

      <section className="results" aria-live="polite" aria-labelledby="search-heading">
        <h2 id="search-heading" className="sr-only">
          Agent search
        </h2>
        {!budget && !running && !error && (
          <div className="panel empty">
            <p>
              List the acts you could book, the venue/date options and the sponsors you want to land. The agent scores your draft bill with Qloo, then
              tries one change at a time (swap an act, move the date), keeps a change only when Qloo&apos;s numbers say it is better, and stops when
              nothing beats the current bill or the Qloo call budget runs out.
            </p>
          </div>
        )}
        {budget && (
          <div className="panel">
            <BudgetMeter {...budget} />
            {points.length > 0 && <ScoreChart points={points} maxIterations={Math.max(MAX_ITERATIONS / 2, iters.length)} />}
          </div>
        )}
        {result && <FinalCard r={result} />}
        {iters.length > 0 && (
          <div className="panel">
            <h3 className="trace-title">Agent trace: proposal → Qloo evidence → decision</h3>
            <ol className="trace">
              {iters.map((it) => (
                <TraceItem key={it.iteration} it={it} current={currentBefore.get(it.iteration)} />
              ))}
            </ol>
            {stop && <p className="stop small">Stopped: {stop}</p>}
          </div>
        )}
        {error && (
          <p className="error panel" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
