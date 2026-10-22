"use client";

import { useState } from "react";
import type { BrandEvidence, Pitch } from "@/lib/agent/types";
import { score } from "./format";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="copy" onClick={copy} aria-live="polite">
      {copied ? "Copied" : "Copy pitch"}
    </button>
  );
}

export function BrandCard({ brand, pitch, mock }: { brand: BrandEvidence; pitch?: Pitch; mock: boolean }) {
  const moved = brand.qlooRank - brand.rank;
  return (
    <article className="panel brand">
      <header className="brand-head">
        <span className="rank">#{brand.rank}</span>
        <div className="brand-title">
          <h3>
            {brand.name}{" "}
            {brand.source !== "recommended" && (
              <span className="badge tiny muted">{brand.source === "both" ? "on your list + recommended" : "from your list"}</span>
            )}
          </h3>
          {brand.description && <p className="muted">{brand.description}</p>}
        </div>
        <div className="fit" title="Sponsor fit, 0-100">
          <span className="fit-num">{Math.round(brand.sponsorFit)}</span>
          <span className="fit-label">fit</span>
        </div>
      </header>

      <dl className="metrics">
        <div>
          <dt>Qloo affinity</dt>
          <dd>
            {score(brand.qlooAffinity, 3)}
            {brand.source !== "requested" && (
              <span className="small muted">
                {" "}
                (Qloo #{brand.qlooRank}
                {moved > 0 ? `, up ${moved}` : moved < 0 ? `, down ${-moved}` : ""})
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Tag overlap</dt>
          <dd>{score(brand.tagOverlapScore)}</dd>
        </div>
        <div>
          <dt>Demo alignment</dt>
          <dd>{brand.demographicAlignment === undefined ? "n/a" : score(brand.demographicAlignment)}</dd>
        </div>
        <div>
          <dt>Popularity</dt>
          <dd>{score(brand.popularity)}</dd>
        </div>
      </dl>

      <div className="evidence">
        <div>
          <h4>Shared taste tags</h4>
          {brand.overlappingTags.length ? (
            <ul className="chips">
              {brand.overlappingTags.map((t) => (
                <li key={t.id} className="chip strong" title={t.id}>
                  {t.name} <span className="chip-score">{score(t.audienceAffinity)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">None of this brand&apos;s tags are in the audience&apos;s top tags.</p>
          )}
        </div>
        {brand.contributors.length > 0 && (
          <div>
            <h4>What drives the affinity</h4>
            <ul className="contrib">
              {brand.contributors.map((c) => (
                <li key={c.id}>
                  <span>
                    {c.name}
                    {c.kind === "venue" ? <span className="muted small"> (venue)</span> : null}
                  </span>
                  <span className="contrib-track">
                    <span className="contrib-fill" style={{ width: `${Math.round(c.score * 100)}%` }} />
                  </span>
                  <span className="small">{score(c.score)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h4>Brand&apos;s top Qloo tags</h4>
          {brand.brandTags.length ? (
            <ul className="chips">
              {brand.brandTags.slice(0, 8).map((t) => (
                <li key={t.id} className="chip" title={t.id}>
                  {t.name} {t.affinity !== undefined && <span className="chip-score">{score(t.affinity)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{brand.brandTagsChecked ? "Qloo returned no tags." : "Not available."}</p>
          )}
        </div>
        {brand.hotspotsChecked && (
          <div>
            <h4>Local hotspots</h4>
            {brand.hotspots.length ? (
              <ul className="places">
                {brand.hotspots.map((h) => (
                  <li key={`${h.latitude},${h.longitude}`}>
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${h.latitude}&mlon=${h.longitude}#map=15/${h.latitude}/${h.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {h.latitude.toFixed(3)}, {h.longitude.toFixed(3)}
                    </a>
                    {h.affinity !== undefined ? <span className="chip-score"> affinity {score(h.affinity)}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No heatmap points in this city.</p>
            )}
          </div>
        )}
      </div>

      {pitch && (
        <div className="pitch">
          <div className="pitch-head">
            <h4>
              Pitch draft{" "}
              <span className={`badge ${pitch.source === "nemotron" ? "ok" : "muted"}`}>
                {pitch.source === "nemotron" ? "Nemotron" : "Template"}
              </span>
            </h4>
            <CopyButton text={pitch.text} />
          </div>
          <p className="pitch-text">{pitch.text}</p>
          {pitch.note && <p className="muted small">{pitch.note}</p>}
          {mock && <p className="muted small">Drafted from synthetic mock data; do not send.</p>}
        </div>
      )}
    </article>
  );
}
