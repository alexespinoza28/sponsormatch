import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HarnessProcess,
  McpQlooTools,
  QLOO_HACKATHON_BASE_URL,
  harnessBinPath,
  harnessEnv,
  resetAuthBlock,
  stdioConnector,
  type HarnessConnection,
  type ToolCaller,
} from "@/lib/qloo/mcp";
import type { QlooToolCallRecord } from "@/lib/qloo/types";
import { fixture } from "./helpers";

afterEach(() => resetAuthBlock());

/** A fake MCP connection whose callTool replays queued results (or throws Errors). */
function fakeConnector(queue: unknown[]) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  let connects = 0;
  const closeCbs: Array<() => void> = [];
  const connector = async (): Promise<HarnessConnection> => {
    connects += 1;
    const client: ToolCaller = {
      async callTool(params) {
        calls.push(params);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      async close() {},
    };
    return { client, onClose: (cb) => closeCbs.push(cb) };
  };
  return { connector, calls, connects: () => connects, crash: () => closeCbs.forEach((cb) => cb()) };
}

const ok = { structuredContent: fixture("describe-ok.json") };

describe("harness environment", () => {
  it("points the harness at the trusted hackathon host with a dedicated QLOO_HOME", () => {
    const env = harnessEnv({ PATH: "/bin", QLOO_API_KEY: "k", NVIDIA_API_KEY: "secret", HOME: "/home/x" });
    expect(env.QLOO_BASE_URL).toBe(QLOO_HACKATHON_BASE_URL);
    expect(env.QLOO_TRUSTED_BASE_URL).toBe(QLOO_HACKATHON_BASE_URL);
    expect(env.QLOO_API_KEY).toBe("k");
    expect(env.QLOO_HOME).toContain("sponsormatch-qloo-home");
    expect(env.PATH).toBe("/bin");
    expect(env.NVIDIA_API_KEY).toBeUndefined();
  });

  it("keeps explicit overrides", () => {
    const env = harnessEnv({ QLOO_BASE_URL: "https://other.example", QLOO_HOME: "/data/qloo" });
    expect(env.QLOO_BASE_URL).toBe("https://other.example");
    expect(env.QLOO_TRUSTED_BASE_URL).toBe("https://other.example");
    expect(env.QLOO_HOME).toBe("/data/qloo");
  });

  it("uses the project's node_modules harness binary", () => {
    expect(harnessBinPath()).toMatch(/node_modules\/@qloo\/qloo-harness\/dist\/bin\.js$/);
    expect(existsSync(harnessBinPath())).toBe(true);
  });
});

describe("HarnessProcess", () => {
  it("starts lazily, reuses the connection and restarts after the process exits", async () => {
    const f = fakeConnector([]);
    const proc = new HarnessProcess(f.connector);
    expect(f.connects()).toBe(0);
    const a = await proc.get();
    expect(await proc.get()).toBe(a);
    expect(f.connects()).toBe(1);
    f.crash();
    await proc.get();
    expect(f.connects()).toBe(2);
  });

  it("stops restarting after three starts in a minute", async () => {
    const proc = new HarnessProcess(async () => {
      throw new Error("spawn failed");
    });
    for (let i = 0; i < 3; i += 1) await expect(proc.get()).rejects.toThrow("spawn failed");
    await expect(proc.get()).rejects.toThrow("exited repeatedly");
  });
});

describe("McpQlooTools", () => {
  it("returns the structured envelope and records the call with provenance", async () => {
    const f = fakeConnector([ok]);
    const records: QlooToolCallRecord[] = [];
    const tools = new McpQlooTools({ process: new HarnessProcess(f.connector), onCall: (r) => records.push(r) });
    const env = await tools.call("qloo_describe", { entity: "The Fixture Tones", type: "artist" });
    expect(env.status).toBe("ok");
    expect(f.calls[0]).toEqual({ name: "qloo_describe", arguments: { entity: "The Fixture Tones", type: "artist" } });
    expect(records[0]).toMatchObject({ tool: "qloo_describe", status: "ok", attempts: 1 });
    expect(records[0]!.requests![0]!.path).toBe("/entities");
  });

  it("falls back to parsing text content", async () => {
    const f = fakeConnector([{ content: [{ type: "text", text: JSON.stringify(fixture("entity-tags.json")) }] }]);
    const tools = new McpQlooTools({ process: new HarnessProcess(f.connector) });
    expect((await tools.call("qloo_entity_tags", { entities: ["x"] })).operation).toBe("entity_tags");
  });

  it("retries a retryable error once, then returns the result", async () => {
    const f = fakeConnector([{ structuredContent: fixture("error-rate-limit.json"), isError: true }, ok]);
    const waits: number[] = [];
    const records: QlooToolCallRecord[] = [];
    const tools = new McpQlooTools({ process: new HarnessProcess(f.connector), sleep: async (ms) => void waits.push(ms), onCall: (r) => records.push(r) });
    const env = await tools.call("qloo_describe", { entity: "x" });
    expect(env.status).toBe("ok");
    expect(f.calls).toHaveLength(2);
    expect(waits).toEqual([500]);
    expect(records[0]!.attempts).toBe(2);
  });

  it("does not retry twice", async () => {
    const rl = { structuredContent: fixture("error-rate-limit.json"), isError: true };
    const f = fakeConnector([rl, rl, ok]);
    const tools = new McpQlooTools({ process: new HarnessProcess(f.connector), sleep: async () => {} });
    const env = await tools.call("qloo_describe", { entity: "x" });
    expect(env.error?.code).toBe("QLOO_RATE_LIMIT");
    expect(f.calls).toHaveLength(2);
  });

  it("blocks all calls for five minutes after a non-retryable QLOO_AUTH error", async () => {
    let now = 1_000_000;
    const f = fakeConnector([{ structuredContent: fixture("error-auth.json"), isError: true }, ok, ok]);
    const tools = new McpQlooTools({ process: new HarnessProcess(f.connector), now: () => now });
    expect((await tools.call("qloo_recommend", { target_type: "brand" })).error?.code).toBe("QLOO_AUTH");
    expect(f.calls).toHaveLength(1);
    const blocked = await tools.call("qloo_describe", { entity: "x" });
    expect(blocked.error?.code).toBe("QLOO_AUTH_BLOCKED");
    expect(f.calls).toHaveLength(1);
    now += 5 * 60 * 1000 + 1;
    expect((await tools.call("qloo_describe", { entity: "x" })).status).toBe("ok");
    expect(f.calls).toHaveLength(2);
  });

  it("restarts the harness after a transport failure", async () => {
    const f = fakeConnector([new Error("pipe closed"), ok]);
    const tools = new McpQlooTools({ process: new HarnessProcess(f.connector), sleep: async () => {} });
    const env = await tools.call("qloo_describe", { entity: "x" });
    expect(env.status).toBe("ok");
    expect(f.connects()).toBe(2);
  });

  it("turns a malformed result into an error envelope", async () => {
    const f = fakeConnector([{ content: [{ type: "text", text: "not json" }] }]);
    const tools = new McpQlooTools({ process: new HarnessProcess(f.connector) });
    expect((await tools.call("qloo_describe", { entity: "x" })).error?.code).toBe("UNKNOWN");
  });
});

describe("real qloo mcp (no key, no Qloo calls)", () => {
  it("spawns the local harness over stdio and answers qloo_capabilities", { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "sponsormatch-test-qloo-"));
    const proc = new HarnessProcess(stdioConnector(harnessEnv({ PATH: process.env.PATH, QLOO_HOME: home })));
    const conn = await proc.get();
    try {
      const listed = await (conn.client as unknown as { listTools(): Promise<{ tools: Array<{ name: string }> }> }).listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(
        [
          "qloo_audience_demographics",
          "qloo_capabilities",
          "qloo_compare_audiences",
          "qloo_describe",
          "qloo_entity_tags",
          "qloo_find_tags",
          "qloo_rank",
          "qloo_recommend",
          "qloo_trends",
          "qloo_where_popular",
        ].sort(),
      );
      const caps = (await conn.client.callTool({ name: "qloo_capabilities", arguments: {} })) as {
        structuredContent: { adapter: { id: string; ready: boolean }; result_schema_version: string };
      };
      expect(caps.structuredContent.adapter.id).toBe("qloo_harness_mcp");
      expect(caps.structuredContent.adapter.ready).toBe(false); // no credential in this test
      expect(caps.structuredContent.result_schema_version).toBe("1.0-preview.1");
    } finally {
      await proc.reset();
    }
  });
});
