"use client";

import { useEffect, useState } from "react";
import { ProducerView } from "./ProducerView";
import { SponsorView } from "./SponsorView";

interface Mode {
  qloo: "live" | "mock";
  proposer: "nemotron" | "heuristic";
  model?: string;
}

export function App({ mode }: { mode: Mode }) {
  const [tab, setTab] = useState<"producer" | "sponsor">("producer");
  // ?tab=sponsor opens the sponsor view; ?autorun=1 runs the sample input
  // once on load (mock mode only, so a shared link never spends Qloo quota).
  const [autorun, setAutorun] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab") === "sponsor" ? "sponsor" : "producer";
    const a = q.get("autorun") === "1" && mode.qloo === "mock";
    queueMicrotask(() => {
      setTab(t);
      setAutorun(a);
    });
  }, [mode.qloo]);
  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1>SponsorMatch</h1>
          <p className="tagline">A lineup-optimizing agent for event producers: it searches act, venue and date combinations and keeps only the changes Qloo&apos;s taste graph proves are better for the sponsors you want.</p>
        </div>
        <div className="badges" aria-label="Data sources">
          <span className={`badge ${mode.qloo === "live" ? "ok" : "warn"}`}>Qloo: {mode.qloo === "live" ? "live via qloo mcp" : "mock data"}</span>
          <span className={`badge ${mode.proposer === "nemotron" ? "ok" : "muted"}`}>Planner: {mode.proposer === "nemotron" ? mode.model : "heuristic"}</span>
        </div>
      </header>
      {mode.qloo === "mock" && (
        <div className="notice" role="note">
          Mock mode: no Qloo key is configured, so every score comes from synthetic fixtures (fictional brands, invented numbers). They are not Qloo data.
          Try &ldquo;Phoenix&rdquo; as an act to see how ambiguous names are handled.
        </div>
      )}
      <nav className="tabs" role="tablist" aria-label="Mode">
        <button role="tab" type="button" aria-selected={tab === "producer"} className={tab === "producer" ? "active" : ""} onClick={() => setTab("producer")}>
          Producer: optimize a lineup
        </button>
        <button role="tab" type="button" aria-selected={tab === "sponsor"} className={tab === "sponsor" ? "active" : ""} onClick={() => setTab("sponsor")}>
          Sponsor: find events for my brand
        </button>
      </nav>
      <div hidden={tab !== "producer"}>
        <ProducerView qlooMode={mode.qloo} autorun={autorun && tab === "producer"} />
      </div>
      <div hidden={tab !== "sponsor"}>
        <SponsorView qlooMode={mode.qloo} autorun={autorun && tab === "sponsor"} />
      </div>
    </div>
  );
}
