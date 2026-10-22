import type {
  QlooClient,
  QlooErrorBody,
  QlooInsightsResponse,
  QlooQuery,
  QlooRequestRecord,
  QlooSearchResponse,
  QlooTagsResponse,
} from "./types";

/**
 * Hackathon keys only work against this host (Qloo Agentic Hackathon Developer
 * Guide, https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide).
 * api.qloo.com and staging.api.qloo.com return 401 for hackathon keys.
 */
export const QLOO_HACKATHON_BASE_URL = "https://hackathon.api.qloo.com";

export type QlooErrorCode =
  | "QLOO_AUTH"
  | "QLOO_FORBIDDEN"
  | "QLOO_BAD_REQUEST"
  | "QLOO_NOT_FOUND"
  | "QLOO_RATE_LIMIT"
  | "QLOO_SERVER"
  | "QLOO_TIMEOUT"
  | "QLOO_NETWORK"
  | "QLOO_AUTH_BLOCKED";

export class QlooApiError extends Error {
  readonly code: QlooErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: QlooErrorCode, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "QlooApiError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** Arrays are comma-joined (GET form style, explode=false); empty values are dropped. */
export function serializeQuery(query: QlooQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      const joined = value.filter((v) => v !== "").join(",");
      if (joined) out[key] = joined;
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export function buildUrl(baseUrl: string, path: string, query: QlooQuery): URL {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.startsWith("//")) {
    throw new Error("Qloo path must be an absolute API path without query or fragment.");
  }
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(serializeQuery(query))) {
    url.searchParams.set(key, value);
  }
  return url;
}

function classifyStatus(status: number): { code: QlooErrorCode; retryable: boolean } {
  if (status === 401) return { code: "QLOO_AUTH", retryable: false };
  if (status === 403) return { code: "QLOO_FORBIDDEN", retryable: false };
  if (status === 404) return { code: "QLOO_NOT_FOUND", retryable: false };
  if (status === 429) return { code: "QLOO_RATE_LIMIT", retryable: true };
  if (status >= 500) return { code: "QLOO_SERVER", retryable: true };
  return { code: "QLOO_BAD_REQUEST", retryable: false };
}

export interface HttpQlooClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Total attempts per request, including the first. Bounded to 1..3. */
  maxAttempts?: number;
  cacheTtlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRequest?: (record: QlooRequestRecord) => void;
}

interface CacheEntry {
  expires: number;
  body: unknown;
}

// Process-wide state shared by every client instance in this server process.
const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;
let authBlockedUntil = 0;

/** For tests only. */
export function resetQlooClientState(): void {
  responseCache.clear();
  authBlockedUntil = 0;
}

const AUTH_BLOCK_MS = 5 * 60 * 1000;

/**
 * Minimal typed client for the Qloo REST API. Keys are sent only in the
 * X-Api-Key header and never appear in errors, logs or request records.
 *
 * Safety rails: a 401 blocks further calls from this process for five minutes
 * (so a bad key is never retried in a loop), retries happen only on 429/5xx/
 * network errors with a small bounded backoff, and identical GETs are cached
 * server-side (allowed by the hackathon developer guide FAQ).
 */
export class HttpQlooClient implements QlooClient {
  readonly mode = "live" as const;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #cacheTtlMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onRequest?: (record: QlooRequestRecord) => void;

  constructor(options: HttpQlooClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error("HttpQlooClient needs an API key; use the mock client when QLOO_API_KEY is unset.");
    }
    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = options.baseUrl ?? QLOO_HACKATHON_BASE_URL;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxAttempts = Math.min(Math.max(options.maxAttempts ?? 2, 1), 3);
    this.#cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#onRequest = options.onRequest;
  }

  search(query: QlooQuery): Promise<QlooSearchResponse> {
    return this.#get<QlooSearchResponse>("/search", query);
  }

  insights(query: QlooQuery): Promise<QlooInsightsResponse> {
    return this.#get<QlooInsightsResponse>("/v2/insights", query);
  }

  tags(query: QlooQuery): Promise<QlooTagsResponse> {
    return this.#get<QlooTagsResponse>("/v2/tags", query);
  }

  async #get<T>(path: string, query: QlooQuery): Promise<T> {
    const url = buildUrl(this.#baseUrl, path, query);
    const record: QlooRequestRecord = { method: "GET", path, query: serializeQuery(query) };
    const cacheKey = url.toString();

    const cached = responseCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      this.#onRequest?.({ ...record, cached: true, status: 200, durationMs: 0 });
      return cached.body as T;
    }

    if (Date.now() < authBlockedUntil) {
      throw new QlooApiError(
        "QLOO_AUTH_BLOCKED",
        "Qloo rejected the API key recently; not retrying. Check QLOO_API_KEY and the hackathon base URL.",
        { status: 401 },
      );
    }

    let lastError: QlooApiError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", "X-Api-Key": this.#apiKey },
          signal: controller.signal,
          cache: "no-store",
        });
      } catch {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        lastError = new QlooApiError(
          timedOut ? "QLOO_TIMEOUT" : "QLOO_NETWORK",
          timedOut ? `Qloo ${path} timed out after ${this.#timeoutMs} ms.` : `Could not reach Qloo ${path}.`,
          { retryable: true },
        );
        this.#onRequest?.({ ...record, durationMs: Date.now() - started });
        if (attempt < this.#maxAttempts) {
          await this.#sleep(this.#backoff(attempt));
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      const durationMs = Date.now() - started;
      this.#onRequest?.({ ...record, status: response.status, durationMs });
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }

      if (response.ok) {
        this.#remember(cacheKey, body);
        return body as T;
      }

      const { code, retryable } = classifyStatus(response.status);
      const detail = (body as QlooErrorBody)?.message ?? (body as QlooErrorBody)?.reason ?? response.statusText;
      lastError = new QlooApiError(code, `Qloo ${path} returned ${response.status}: ${detail || "error"}`, {
        status: response.status,
        retryable,
      });
      if (code === "QLOO_AUTH") {
        authBlockedUntil = Date.now() + AUTH_BLOCK_MS;
        throw lastError;
      }
      if (retryable && attempt < this.#maxAttempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.#backoff(attempt);
        await this.#sleep(Math.min(wait, 2_000));
        continue;
      }
      throw lastError;
    }
    throw lastError ?? new QlooApiError("QLOO_NETWORK", `Qloo ${path} failed.`);
  }

  #backoff(attempt: number): number {
    return Math.min(300 * 2 ** (attempt - 1), 2_000);
  }

  #remember(key: string, body: unknown): void {
    if (this.#cacheTtlMs <= 0) return;
    if (responseCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = responseCache.keys().next().value;
      if (oldest !== undefined) responseCache.delete(oldest);
    }
    responseCache.set(key, { expires: Date.now() + this.#cacheTtlMs, body });
  }
}
