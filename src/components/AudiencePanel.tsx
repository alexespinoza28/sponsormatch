import type { AgentResult } from "@/lib/agent/types";
import { AGE_LABELS, formatDate, score, signed } from "./format";

export function AudiencePanel({ result }: { result: AgentResult }) {
  const { resolution, audience, input } = result;
  const demo = audience.demographics;
  const maxAbs = demo ? Math.max(0.01, ...Object.values(demo.age).map((v) => Math.abs(v))) : 1;
  const when = formatDate(input.date);
  return (
    <div className="panel audience">
      <div className="audience-head">
        <h3>Audience profile</h3>
        <p className="muted">
          {resolution.performers.map((p) => p.name).join(" + ")}
          {resolution.venue ? ` at ${resolution.venue.name}` : ""}, {resolution.locality?.name ?? input.city}
          {when ? `, ${when}` : ""}
        </p>
      </div>
      <div className="audience-grid">
        <div>
          <h4>Brand-taste tags (Qloo affinity)</h4>
          {audience.tags.length ? (
            <ul className="chips">
              {audience.tags.slice(0, 10).map((t) => (
                <li key={t.id} className="chip" title={t.id}>
                  {t.name} <span className="chip-score">{score(t.affinity)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Qloo returned no brand-taste tags for this lineup.</p>
          )}
        </div>
        <div>
          <h4>Age affinity vs. average</h4>
          {demo ? (
            <ul className="bars" aria-label="Age affinity">
              {Object.entries(demo.age).map(([bucket, v]) => (
                <li key={bucket}>
                  <span className="bar-label">{AGE_LABELS[bucket] ?? bucket}</span>
                  <span className="bar-track">
                    <span
                      className={`bar-fill ${v >= 0 ? "pos" : "neg"}`}
                      style={{ width: `${(Math.abs(v) / maxAbs) * 50}%`, [v >= 0 ? "left" : "right"]: "50%" }}
                    />
                  </span>
                  <span className="bar-value">{signed(v)}</span>
                </li>
              ))}
              <li>
                <span className="bar-label">Gender</span>
                <span className="gender-text">
                  female {signed(demo.gender.female)} / male {signed(demo.gender.male)}
                </span>
              </li>
            </ul>
          ) : (
            <p className="muted">Demographics unavailable.</p>
          )}
        </div>
      </div>
      {resolution.unresolved.length > 0 && (
        <p className="muted small">Not found in Qloo: {resolution.unresolved.join(", ")}</p>
      )}
    </div>
  );
}
