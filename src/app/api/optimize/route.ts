import { resolveModel } from "@/lib/llm/nemotron";
import { BudgetedQloo, CallLog } from "@/lib/optimizer/budget";
import { InputError, validateOptimizeInput } from "@/lib/optimizer/input";
import { runOptimizer } from "@/lib/optimizer/search";
import type { OptimizerEvent } from "@/lib/optimizer/types";
import { createQlooTools } from "@/lib/qloo";
import { ndjsonResponse } from "@/lib/stream";

// Lineup optimizer endpoint. Server-only: QLOO_API_KEY and NVIDIA_API_KEY are
// read here and never sent to the browser. With QLOO_API_KEY set, Qloo is
// reached only through the local `qloo mcp` harness process, so this route
// needs a long-running Node server (not serverless).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  let input;
  try {
    input = validateOptimizeInput(await request.json());
  } catch (error) {
    return Response.json({ error: error instanceof InputError ? error.message : "Invalid request body." }, { status: 400 });
  }
  const log = new CallLog();
  const qloo = new BudgetedQloo(await createQlooTools({ onCall: log.push, mockLatencyMs: 40 }), input.budget);
  const nvidiaKey = process.env.NVIDIA_API_KEY?.trim();
  return ndjsonResponse<OptimizerEvent>((emit) =>
    runOptimizer(input, { qloo, log, emit, llm: { enabled: Boolean(nvidiaKey), apiKey: nvidiaKey, model: resolveModel() } }),
  );
}
