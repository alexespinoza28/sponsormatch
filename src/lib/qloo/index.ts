import { MockQlooTools } from "./mock";
import type { QlooToolCallRecord, QlooTools } from "./types";

export * from "./types";
export { MockQlooTools } from "./mock";

/**
 * Live tools over `qloo mcp` when QLOO_API_KEY is set; otherwise the offline
 * mock, which never spawns the harness. Server-only.
 */
export async function createQlooTools(options: {
  env?: Record<string, string | undefined>;
  onCall?: (record: QlooToolCallRecord) => void;
  mockLatencyMs?: number;
} = {}): Promise<QlooTools> {
  const env = options.env ?? process.env;
  if (env.QLOO_API_KEY?.trim()) {
    // Imported lazily so mock mode never loads the MCP SDK or spawns anything.
    const { McpQlooTools, sharedHarness } = await import("./mcp");
    return new McpQlooTools({ process: sharedHarness(), onCall: options.onCall });
  }
  return new MockQlooTools({ onCall: options.onCall, latencyMs: options.mockLatencyMs ?? 0 });
}
