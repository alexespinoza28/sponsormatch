import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { QlooEnvelope, QlooToolCallRecord, QlooToolInputs, QlooToolName, QlooTools } from "./types";

// Live Qloo access through the official harness: `qloo mcp` from the pinned
// @qloo/qloo-harness package, spawned as a local stdio MCP server and driven
// with the official MCP SDK client (as in the kit's starter/mcp-client).
// One long-lived server per Node process, started lazily and restarted if it
// exits. Server-only module.

/** Hackathon keys only work on this host; the harness defaults to api.qloo.com. */
export const QLOO_HACKATHON_BASE_URL = "https://hackathon.api.qloo.com";
const AUTH_BLOCK_MS = 5 * 60 * 1000;

/** Minimal surface of the MCP SDK client that this module uses (lets tests fake it). */
export interface ToolCaller {
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: undefined, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface HarnessConnection {
  client: ToolCaller;
  /** Registers a callback for when the server process goes away. */
  onClose(cb: () => void): void;
}

export type HarnessConnector = () => Promise<HarnessConnection>;

/** Path to the harness CLI inside this project's node_modules (never a global install). */
export function harnessBinPath(cwd = process.cwd()): string {
  return process.env.QLOO_HARNESS_BIN || join(cwd, "node_modules", "@qloo", "qloo-harness", "dist", "bin.js");
}

const FORWARDED_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

/**
 * Environment for the harness process: QLOO_* settings plus a few system
 * variables. Other secrets (e.g. NVIDIA_API_KEY) are not forwarded.
 * Defaults point the harness at the hackathon host and mark it trusted, and
 * give it a dedicated QLOO_HOME so it never reads ~/.qloo/config.
 */
export function harnessEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FORWARDED_ENV) if (source[key]) env[key] = source[key]!;
  for (const [key, value] of Object.entries(source)) if (key.startsWith("QLOO_") && value) env[key] = value;
  const base = source.QLOO_BASE_URL?.trim() || QLOO_HACKATHON_BASE_URL;
  env.QLOO_BASE_URL = base;
  env.QLOO_TRUSTED_BASE_URL = source.QLOO_TRUSTED_BASE_URL?.trim() || base;
  env.QLOO_HOME = source.QLOO_HOME?.trim() || join(tmpdir(), "sponsormatch-qloo-home");
  return env;
}

/** Spawns `node node_modules/@qloo/qloo-harness/dist/bin.js mcp` and connects over stdio. */
export function stdioConnector(env: Record<string, string> = harnessEnv()): HarnessConnector {
  return async () => {
    mkdirSync(env.QLOO_HOME!, { recursive: true, mode: 0o700 });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [harnessBinPath(), "mcp"],
      env,
      stderr: "ignore",
    });
    const client = new Client({ name: "sponsormatch", version: "0.2.0" });
    const closers: Array<() => void> = [];
    transport.onclose = () => closers.forEach((cb) => cb());
    await client.connect(transport);
    return { client: client as unknown as ToolCaller, onClose: (cb) => closers.push(cb) };
  };
}

/** Lazily started, self-restarting harness connection. */
export class HarnessProcess {
  readonly #connect: HarnessConnector;
  #conn?: Promise<HarnessConnection>;
  #starts: number[] = [];
  starts = 0;

  constructor(connect: HarnessConnector) {
    this.#connect = connect;
  }

  get(): Promise<HarnessConnection> {
    if (!this.#conn) {
      const now = Date.now();
      this.#starts = this.#starts.filter((t) => now - t < 60_000);
      if (this.#starts.length >= 3) {
        return Promise.reject(new Error("qloo mcp exited repeatedly; not restarting for a minute."));
      }
      this.#starts.push(now);
      this.starts += 1;
      const pending = this.#connect().then((conn) => {
        conn.onClose(() => {
          if (this.#conn === pending) this.#conn = undefined;
        });
        return conn;
      });
      pending.catch(() => {
        if (this.#conn === pending) this.#conn = undefined;
      });
      this.#conn = pending;
    }
    return this.#conn;
  }

  /** Drops the current connection (after a transport failure) so the next call restarts. */
  async reset(): Promise<void> {
    const conn = this.#conn;
    this.#conn = undefined;
    if (conn) await conn.then((c) => c.client.close()).catch(() => undefined);
  }
}

function localError(tool: string, code: string, summary: string, retryable: boolean, recovery: string): QlooEnvelope {
  return {
    schema_version: "1.0-preview.1",
    operation: tool.replace(/^qloo_/, ""),
    status: "error",
    summary,
    results: [],
    result_count: 0,
    error: { code, layer: "sponsormatch", retryable, recovery },
    execution: { transport: "mcp", transport_name: "Qloo canonical MCP", correlation_id: "local", duration_ms: 0 },
  };
}

function toEnvelope(tool: string, raw: unknown): QlooEnvelope {
  const r = raw as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
  let env: unknown = r?.structuredContent;
  if (!env && Array.isArray(r?.content)) {
    const text = r.content.find((c) => c.type === "text")?.text;
    try {
      env = text ? JSON.parse(text) : undefined;
    } catch {
      env = undefined;
    }
  }
  const e = env as QlooEnvelope | undefined;
  if (!e || typeof e !== "object" || typeof e.status !== "string") {
    return localError(tool, "UNKNOWN", "qloo mcp returned a result without a status.", false, "Check the harness version.");
  }
  if (e.status === "error" && !e.error) {
    return { ...e, error: { code: "UNKNOWN", layer: "harness", retryable: false, recovery: "Inspect the harness logs." } };
  }
  return e;
}

export interface McpQlooToolsOptions {
  process: HarnessProcess;
  onCall?: (record: QlooToolCallRecord) => void;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Process-wide: a rejected key blocks every client in this process.
let authBlockedUntil = 0;
export function resetAuthBlock(): void {
  authBlockedUntil = 0;
}

/**
 * QlooTools over `qloo mcp`. Always resolves to an envelope (transport failures
 * become status "error" envelopes). Retries at most once, and only when the
 * envelope says error.retryable (the harness already retries 429/5xx itself).
 * A non-retryable QLOO_AUTH error blocks all calls for five minutes.
 */
export class McpQlooTools implements QlooTools {
  readonly mode = "live" as const;
  readonly #proc: HarnessProcess;
  readonly #onCall?: (record: QlooToolCallRecord) => void;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: McpQlooToolsOptions) {
    this.#proc = options.process;
    this.#onCall = options.onCall;
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  async call<T extends QlooToolName>(tool: T, args: QlooToolInputs[T]): Promise<QlooEnvelope> {
    const started = this.#now();
    const record = (env: QlooEnvelope, attempts: number) => {
      this.#onCall?.({
        tool,
        args: args as Record<string, unknown>,
        status: env.status,
        summary: env.summary,
        errorCode: env.error?.code,
        durationMs: this.#now() - started,
        requests: env.provenance?.requests,
        attempts,
      });
      return env;
    };

    if (this.#now() < authBlockedUntil) {
      return record(
        localError(tool, "QLOO_AUTH_BLOCKED", "Qloo rejected the credential recently; not calling Qloo for five minutes.", false, "Check QLOO_API_KEY and QLOO_BASE_URL, then restart the server."),
        0,
      );
    }

    let env: QlooEnvelope | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const conn = await this.#proc.get();
        const raw = await conn.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, {
          timeout: this.#timeoutMs,
        });
        env = toEnvelope(tool, raw);
      } catch (error) {
        await this.#proc.reset();
        env = localError(
          tool,
          "HARNESS_UNAVAILABLE",
          `Could not run ${tool} on qloo mcp: ${error instanceof Error ? error.message : String(error)}`,
          true,
          "The harness process is restarted on the next call.",
        );
      }
      if (env.status !== "error") return record(env, attempt);
      if (env.error?.code === "QLOO_AUTH" && !env.error.retryable) {
        authBlockedUntil = this.#now() + AUTH_BLOCK_MS;
        return record(env, attempt);
      }
      if (env.error?.retryable && attempt < 2) {
        await this.#sleep(500);
        continue;
      }
      return record(env, attempt);
    }
    return record(env!, 2);
  }
}

/**
 * Harness readiness from qloo_capabilities, which never contacts Qloo.
 * Used by the health check; starts the harness if it is not running.
 */
export async function harnessReadiness(proc: HarnessProcess): Promise<{ ready: boolean; tools: number; contract?: string }> {
  const conn = await proc.get();
  const raw = (await conn.client.callTool({ name: "qloo_capabilities", arguments: {} }, undefined, { timeout: 15_000 })) as {
    structuredContent?: { adapter?: { ready?: boolean; supported_operation_ids?: string[] }; contract_version?: string };
  };
  const s = raw?.structuredContent;
  return { ready: Boolean(s?.adapter?.ready), tools: s?.adapter?.supported_operation_ids?.length ?? 0, contract: s?.contract_version };
}

// One harness process per server process; kept on globalThis so Next.js dev
// reloads do not spawn duplicates.
const GLOBAL_KEY = Symbol.for("sponsormatch.qlooHarness");
type GlobalWithHarness = typeof globalThis & { [GLOBAL_KEY]?: HarnessProcess };

export function sharedHarness(): HarnessProcess {
  const g = globalThis as GlobalWithHarness;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new HarnessProcess(stdioConnector());
  return g[GLOBAL_KEY]!;
}
