import { AgentError, CallLog, runAgent, validateInput } from "@/lib/agent/pipeline";
import type { AgentEvent } from "@/lib/agent/types";
import { resolveModel } from "@/lib/llm/nemotron";
import { createQlooTools } from "@/lib/qloo";

// Server-only route: QLOO_API_KEY and NVIDIA_API_KEY are read here and never
// sent to the browser. With QLOO_API_KEY set, Qloo is reached only through the
// local `qloo mcp` harness process (src/lib/qloo/mcp.ts), so this route needs a
// long-running Node server (not serverless). The response is newline-delimited
// JSON so the UI can show each agent step as it happens.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  let input;
  try {
    input = validateInput(await request.json());
  } catch (error) {
    const message = error instanceof AgentError ? error.message : "Invalid request body.";
    return Response.json({ error: message }, { status: 400 });
  }

  const log = new CallLog();
  const qloo = await createQlooTools({ onCall: log.push, mockLatencyMs: 80 });
  const nvidiaKey = process.env.NVIDIA_API_KEY?.trim();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AgentEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await runAgent(input, {
          qloo,
          log,
          emit,
          llm: { enabled: Boolean(nvidiaKey), apiKey: nvidiaKey, model: resolveModel() },
        });
      } catch {
        // runAgent already emitted an error event.
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(): Promise<Response> {
  return Response.json({
    qloo: process.env.QLOO_API_KEY?.trim() ? "live (qloo mcp)" : "mock",
    llm: process.env.NVIDIA_API_KEY?.trim() ? "nemotron" : "template",
    model: process.env.NVIDIA_API_KEY?.trim() ? resolveModel() : undefined,
  });
}
