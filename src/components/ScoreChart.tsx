"use client";

import { useState } from "react";

export interface ChartPoint {
  iteration: number;
  objective: number;
  accepted: boolean;
  best: number;
  label: string;
}

const W = 640;
const H = 220;
const PAD = { l: 40, r: 16, t: 14, b: 30 };

/**
 * Score history: every lineup Qloo scored (filled = accepted, hollow =
 * rejected) and the best-so-far step line. One y-axis: objective 0-100.
 */
export function ScoreChart({ points, maxIterations }: { points: ChartPoint[]; maxIterations: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return null;
  const values = points.map((p) => p.objective);
  const lo = Math.max(0, Math.floor(Math.min(...values) - 3));
  const hi = Math.min(100, Math.ceil(Math.max(...values) + 3));
  const xMax = Math.max(maxIterations, points.at(-1)!.iteration, 1);
  const x = (i: number) => PAD.l + (i / xMax) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - PAD.t - PAD.b);
  const ticks = Array.from({ length: 4 }, (_, k) => Math.round(lo + ((hi - lo) * k) / 3));
  let step = "";
  points.forEach((p, i) => {
    step += i === 0 ? `M${x(p.iteration)},${y(p.best)}` : `H${x(p.iteration)}V${y(p.best)}`;
  });
  const h = hover !== null ? points[hover] : undefined;

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <strong>Score history</strong>
        <span className="legend small">
          <span>
            <svg width="22" height="10" aria-hidden>
              <line x1="0" y1="5" x2="22" y2="5" className="best-line" />
            </svg>
            best so far
          </span>
          <span>
            <svg width="12" height="12" aria-hidden>
              <circle cx="6" cy="6" r="4.5" className="pt accepted" />
            </svg>
            accepted
          </span>
          <span>
            <svg width="12" height="12" aria-hidden>
              <circle cx="6" cy="6" r="4.5" className="pt rejected" />
            </svg>
            rejected
          </span>
        </span>
      </figcaption>
      <div className="chart-tip small" aria-live="polite">
        {h ? (
          <>
            <strong>{h.iteration === 0 ? "Draft" : `#${h.iteration}`}</strong> {h.label}: {h.objective.toFixed(1)}
            {h.iteration > 0 ? (h.accepted ? " (accepted)" : " (rejected)") : ""}
          </>
        ) : (
          <span className="muted">Hover a point for the move and its Qloo score.</span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Objective score of each lineup Qloo evaluated">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.l - 8} y={y(t) + 4} className="tick" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {Array.from({ length: xMax + 1 }, (_, i) => (
          <text key={i} x={x(i)} y={H - 10} className="tick" textAnchor="middle">
            {i === 0 ? "draft" : i}
          </text>
        ))}
        <path d={step} className="best-line" fill="none" />
        {points.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}>
            <circle cx={x(p.iteration)} cy={y(p.objective)} r={12} className="hit" />
            <circle cx={x(p.iteration)} cy={y(p.objective)} r={5} className={`pt ${p.accepted ? "accepted" : "rejected"} ${hover === i ? "hot" : ""}`} />
            <title>{`${p.iteration === 0 ? "Draft" : `#${p.iteration}`} ${p.label}: ${p.objective.toFixed(1)}`}</title>
          </g>
        ))}
      </svg>
    </figure>
  );
}
