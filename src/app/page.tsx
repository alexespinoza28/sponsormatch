import { SponsorMatchApp } from "@/components/SponsorMatchApp";
import { resolveModel } from "@/lib/llm/nemotron";

export const dynamic = "force-dynamic";

export default function Home() {
  // Only booleans and the public model name reach the client, never key values.
  const mode = {
    qloo: process.env.QLOO_API_KEY?.trim() ? ("live" as const) : ("mock" as const),
    llm: process.env.NVIDIA_API_KEY?.trim() ? ("nemotron" as const) : ("template" as const),
    model: process.env.NVIDIA_API_KEY?.trim() ? resolveModel() : undefined,
  };
  return <SponsorMatchApp mode={mode} />;
}
