import { App } from "@/components/App";
import { resolveModel } from "@/lib/llm/nemotron";

export const dynamic = "force-dynamic";

export default function Home() {
  // Only mode flags and the public model name reach the client, never key values.
  const nvidia = Boolean(process.env.NVIDIA_API_KEY?.trim());
  const mode = {
    qloo: process.env.QLOO_API_KEY?.trim() ? ("live" as const) : ("mock" as const),
    proposer: nvidia ? ("nemotron" as const) : ("heuristic" as const),
    model: nvidia ? resolveModel() : undefined,
  };
  return <App mode={mode} />;
}
