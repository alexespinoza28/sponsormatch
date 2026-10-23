"use client";

import type { Choice } from "@/lib/optimizer/types";
import type { QlooToolCallRecord } from "@/lib/qloo/types";

const STATUS_CLASS: Record<string, string> = {
  ok: "ok",
  partial: "warn",
  degraded: "warn",
  needs_input: "warn",
  empty: "muted",
  error: "bad",
  failed: "bad",
};

function short(v: unknown): string {
  const s = String(v);
  return s.length > 14 && /^[0-9A-F-]{20,}$/i.test(s) ? `${s.slice(0, 8)}…` : s;
}

function argSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.map(short).join(", ")}]` : short(v)}`)
    .join(" ");
}

/** MCP tool calls with status and the Qloo API requests the harness reports (never the key). */
export function CallList({ calls }: { calls: QlooToolCallRecord[] }) {
  return (
    <ul className="requests">
      {calls.map((c, j) => (
        <li key={j}>
          <code>
            {c.tool} {argSummary(c.args)}
          </code>{" "}
          <span className={`badge tiny ${STATUS_CLASS[c.status] ?? "muted"}`}>{c.status}</span>
          {c.attempts && c.attempts > 1 ? <span className="retried"> retried</span> : null}
          {c.summary && c.status !== "ok" ? <div className="muted small">{c.summary}</div> : null}
          {c.requests && c.requests.length > 0 && (
            <div className="muted small">
              {c.requests.slice(0, 3).map((r, k) => (
                <div key={k} className="req">
                  GET {r.path}
                  {r.query && typeof r.query === "object"
                    ? `?${Object.entries(r.query as Record<string, unknown>)
                        .map(([qk, qv]) => `${qk}=${Array.isArray(qv) ? qv.map(short).join(",") : short(qv)}`)
                        .join("&")}`
                    : ""}
                </div>
              ))}
              {c.requests.length > 3 ? <div>+{c.requests.length - 3} more requests</div> : null}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** needs_input candidates: the agent continued with one; clicking another re-runs with that exact entity. */
export function ChoiceList({ choices, onPick, disabled }: { choices: Choice[]; onPick: (c: Choice, id: string) => void; disabled: boolean }) {
  return (
    <div className="choices">
      {choices.map((c, i) => (
        <div key={i} className="choice">
          <p className="small">
            <strong>
              {c.field} &ldquo;{c.input}&rdquo;
            </strong>{" "}
            is {c.kind.replace(/_/g, " ")} in Qloo{c.chosen ? `; using ${c.chosen.name} for now` : ""}.
            {c.candidates.length > 1 ? " Pick the right one to re-run:" : ""}
          </p>
          {c.candidates.length > 0 && (
            <div className="chips">
              {c.candidates.map((cand) => (
                <button
                  key={cand.id}
                  type="button"
                  className={`chip-button ${c.chosen?.id === cand.id ? "active" : ""}`}
                  title={cand.description ?? cand.id}
                  disabled={disabled}
                  onClick={() => onPick(c, cand.id)}
                >
                  {cand.name}
                  {cand.type ? <span className="cand-type"> {cand.type.replace("urn:entity:", "")}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function BudgetMeter({ used, limit, setup }: { used: number; limit: number; setup: number }) {
  const s = Math.min(setup, used);
  return (
    <div className="budget" aria-label={`Qloo calls used: ${used} of ${limit}`}>
      <div className="budget-head">
        <strong>Qloo call budget</strong>
        <span className="tabular">
          {used} / {limit}
        </span>
      </div>
      <div className="budget-track">
        <span className="budget-fill setup" style={{ width: `${(s / limit) * 100}%` }} />
        <span className="budget-fill search" style={{ width: `${((used - s) / limit) * 100}%` }} />
      </div>
      <div className="budget-legend small muted">
        <span>
          <i className="sw setup" /> setup {s}
        </span>
        <span>
          <i className="sw search" /> search {used - s}
        </span>
        <span>hard cap: calls past {limit} are refused before reaching Qloo</span>
      </div>
    </div>
  );
}
