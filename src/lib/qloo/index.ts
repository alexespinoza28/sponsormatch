import { HttpQlooClient } from "./client";
import { MockQlooClient } from "./mock";
import type { QlooClient, QlooRequestRecord } from "./types";

export * from "./types";
export { HttpQlooClient, QlooApiError, QLOO_HACKATHON_BASE_URL, buildUrl, serializeQuery } from "./client";
export { MockQlooClient } from "./mock";

/**
 * Live client when QLOO_API_KEY is set, otherwise the offline mock.
 * Server-only: the key is read from the environment and never leaves the server.
 */
export function createQlooClient(options: {
  env?: Record<string, string | undefined>;
  onRequest?: (record: QlooRequestRecord) => void;
  mockLatencyMs?: number;
} = {}): QlooClient {
  const env = options.env ?? process.env;
  const key = env.QLOO_API_KEY?.trim();
  if (key) return new HttpQlooClient({ apiKey: key, onRequest: options.onRequest });
  return new MockQlooClient({ onRequest: options.onRequest, latencyMs: options.mockLatencyMs ?? 0 });
}
