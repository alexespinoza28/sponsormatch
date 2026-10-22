import { readFileSync } from "node:fs";
import { join } from "node:path";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as T;
}

export interface FakeCall {
  url: URL;
  init: RequestInit;
}

/** A fetch stand-in that replays queued responses and records calls. */
export function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: FakeCall[] = [];
  const queue = [...responses];
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    const next = queue.shift() ?? { status: 500, body: { message: "no more fake responses" } };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json", ...(next.headers ?? {}) },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}
