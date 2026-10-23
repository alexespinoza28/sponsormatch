import type { QlooEnvelope, QlooToolCallRecord, QlooToolInputs, QlooToolName, QlooTools } from "@/lib/qloo/types";

/** Thrown when Qloo rejects the credential: the run stops. */
export class QlooAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QlooAuthError";
  }
}

/** Collects MCP tool-call records so each trace event can show the calls it made. */
export class CallLog {
  #pending: QlooToolCallRecord[] = [];
  total = 0;
  readonly push = (record: QlooToolCallRecord) => {
    this.#pending.push(record);
    this.total += 1;
  };
  drain(): QlooToolCallRecord[] {
    const out = this.#pending;
    this.#pending = [];
    return out;
  }
}

export const BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED";

/**
 * Hard cap on Qloo MCP tool calls. Once `limit` calls have been made, further
 * calls are refused locally (status "error", code BUDGET_EXHAUSTED) and never
 * reach the harness, so a misbehaving loop cannot spend shared quota.
 */
export class BudgetedQloo implements QlooTools {
  readonly mode: "live" | "mock";
  readonly limit: number;
  readonly #inner: QlooTools;
  used = 0;

  constructor(inner: QlooTools, limit: number) {
    this.#inner = inner;
    this.mode = inner.mode;
    this.limit = Math.max(0, Math.floor(limit));
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  async call<T extends QlooToolName>(tool: T, args: QlooToolInputs[T]): Promise<QlooEnvelope> {
    if (this.used >= this.limit) {
      return {
        schema_version: "1.0-preview.1",
        operation: tool.replace(/^qloo_/, ""),
        status: "error",
        summary: `Qloo call budget of ${this.limit} reached; ${tool} was not sent.`,
        results: [],
        result_count: 0,
        error: { code: BUDGET_EXHAUSTED, layer: "sponsormatch", retryable: false, recovery: "Raise the budget and run again." },
        execution: { transport: "mcp", transport_name: "SponsorMatch budget guard", correlation_id: "budget", duration_ms: 0 },
      };
    }
    this.used += 1;
    return this.#inner.call(tool, args);
  }
}

export type EnvelopeClass = "ok" | "empty" | "needs_input" | "error";

/**
 * Classifies an envelope. partial/degraded count as usable, with the summary
 * returned as a warning; QLOO_AUTH stops the run.
 */
export function classify(env: QlooEnvelope): { status: EnvelopeClass; warning?: string; error?: string } {
  switch (env.status) {
    case "ok":
      return { status: "ok", warning: env.warnings?.length ? env.warnings.join("; ") : undefined };
    case "partial":
    case "degraded":
      return { status: "ok", warning: `${env.status}: ${env.summary ?? "reduced result"}` };
    case "empty":
      return { status: "empty" };
    case "needs_input":
      return { status: "needs_input" };
    default: {
      const code = env.error?.code ?? "UNKNOWN";
      if (code === "QLOO_AUTH" || code === "QLOO_AUTH_BLOCKED") {
        throw new QlooAuthError(`${env.summary ?? "Qloo rejected the credential."} ${env.error?.recovery ?? ""}`.trim());
      }
      return { status: "error", error: `${code}: ${env.summary ?? "error"}` };
    }
  }
}
