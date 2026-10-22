// Smoke test: start the local `qloo mcp` server (node_modules binary) over stdio,
// list its tools and call qloo_capabilities. qloo_capabilities does not contact
// Qloo, and no other tool is called, so this needs no key and makes no Qloo request.
// Usage: node scripts/mcp-smoke.mjs [--schemas out.json]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "node_modules", "@qloo", "qloo-harness", "dist", "bin.js");
const qlooHome = process.env.QLOO_HOME || join(tmpdir(), "sponsormatch-qloo-home");
mkdirSync(qlooHome, { recursive: true, mode: 0o700 });

const env = {
  ...process.env,
  QLOO_HOME: qlooHome,
  QLOO_BASE_URL: process.env.QLOO_BASE_URL || "https://hackathon.api.qloo.com",
  QLOO_TRUSTED_BASE_URL: process.env.QLOO_TRUSTED_BASE_URL || "https://hackathon.api.qloo.com",
};

const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env, stderr: "pipe" });
const client = new Client({ name: "sponsormatch-smoke", version: "0.1.0" });
await client.connect(transport);
try {
  const { tools } = await client.listTools();
  console.log(`Connected to qloo mcp (${tools.length} tools): ${tools.map((t) => t.name).join(", ")}`);
  const caps = await client.callTool({ name: "qloo_capabilities", arguments: {} });
  const s = caps.structuredContent ?? {};
  console.log(
    JSON.stringify(
      {
        contract_version: s.contract_version,
        result_schema_version: s.result_schema_version,
        adapter: s.adapter,
        operations: (s.operations ?? []).map((o) => o.id),
        credential: process.env.QLOO_API_KEY ? "set" : "not set",
      },
      null,
      2,
    ),
  );
  const i = process.argv.indexOf("--schemas");
  if (i > -1 && process.argv[i + 1]) {
    writeFileSync(process.argv[i + 1], JSON.stringify({ tools, capabilities: s }, null, 2));
    console.log(`Wrote schemas to ${process.argv[i + 1]}`);
  }
} finally {
  await client.close();
}
