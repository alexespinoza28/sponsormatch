import { describe, expect, it } from "vitest";
import { Notes, rankOptions } from "@/lib/optimizer/qloo-steps";
import type { QlooEnvelope, QlooTools } from "@/lib/qloo/types";

// Shapes from a live qloo_rank (option_type place) probe on Oct 22, 2026:
// "The Troubadour" came back ambiguous with three non-LA candidates, while
// "Hollywood Bowl" offered the LA amphitheater and a bowling alley in Brazil.
const BOWL = "2CEEDDB4-7758-4FBB-A7CC-F78FF61CA11F";
const WILTERN = "44900455-A680-43B6-A23A-F35BA330D31F";
const SANTA_MONICA_BLVD = "4966D78C-DA83-499B-B57F-EE8F5A0DAB0F";

const needsInput: QlooEnvelope = {
  status: "needs_input",
  resolution: {
    issues: [
      {
        input: "The Troubadour",
        kind: "ambiguous",
        input_kind: "entity",
        field: "options",
        candidates: [
          { id: "8486EE14-724B-464D-A437-4AF1E77F2F43", name: "The Troubadour", type: "urn:entity:place", address: "7 Caledonia Pl St Helier Jersey JE2 3NG Jersey" },
          { id: "72D22A03-BE9C-4B13-9FAC-460C97CD6997", name: "the Troubadour", type: "urn:entity:place", address: "Bleijenhoek 6 5531 BM Bladel Netherlands" },
        ],
      },
      {
        input: "Hollywood Bowl",
        kind: "ambiguous",
        input_kind: "entity",
        field: "options",
        candidates: [
          { id: "3E04D764-AA46-4387-BFBF-D1908E132181", name: "Hollywood Bowl", type: "urn:entity:place", address: "Av. Atlântica, 2850 - Centro Balneário Camboriú - SC 88330-018 Brazil" },
          { id: BOWL, name: "Hollywood Bowl", type: "urn:entity:place", address: "2301 Highland Ave Los Angeles, CA 90068" },
        ],
      },
    ],
  },
} as unknown as QlooEnvelope;

const place = (entity_id: string, name: string, affinity: number, address: string) => ({ entity_id, name, type: "urn:entity", subtype: "urn:entity:place", affinity, properties: { address } });

function stub(): QlooTools & { sent: string[][] } {
  const t = {
    mode: "mock" as const,
    sent: [] as string[][],
    async call(_tool: string, args: Record<string, unknown>) {
      const options = args.options as string[];
      t.sent.push(options);
      if (t.sent.length === 1) return needsInput;
      return {
        status: "ok",
        interpretation: { options: [{ input: "Troubadour", entityId: SANTA_MONICA_BLVD, name: "Troubadour", match: "semantic" }, { input: "The Wiltern", entityId: WILTERN, name: "The Wiltern", match: "exact" }] },
        results: [
          place(BOWL, "Hollywood Bowl", 0.81, "2301 Highland Ave Los Angeles, CA 90068"),
          place(WILTERN, "The Wiltern", 0.8, "3790 Wilshire Blvd Los Angeles, CA 90010"),
          place(SANTA_MONICA_BLVD, "Troubadour", 0.79, "9081 N Santa Monica Blvd West Hollywood, CA 90069"),
        ].filter((r) => options.includes(r.entity_id) || options.some((o) => o === r.name)),
      } as unknown as QlooEnvelope;
    },
  };
  return t as unknown as QlooTools & { sent: string[][] };
}

describe("venue resolution (live place shapes)", () => {
  it("picks the candidate in the venue's city and never falls back to a candidate elsewhere", async () => {
    const qloo = stub();
    const notes = new Notes();
    const out = await rankOptions(qloo, notes, {
      options: ["The Troubadour", "Hollywood Bowl", "The Wiltern"],
      optionType: "place",
      signals: ["brand"],
      pins: {},
      field: "venue",
      label: "Rank venues",
      hints: { "The Troubadour": "Los Angeles", "Hollywood Bowl": "Los Angeles", "The Wiltern": "Los Angeles" },
    });
    expect(qloo.sent[1]).toEqual(expect.arrayContaining([BOWL, "The Wiltern"]));
    expect(qloo.sent[1]).not.toContain("8486EE14-724B-464D-A437-4AF1E77F2F43");
    expect(out.get("Hollywood Bowl")).toMatchObject({ id: BOWL, match: "agent_pick" });
    expect(out.has("The Troubadour")).toBe(false);
    expect(notes.notes.join("\n")).toMatch(/"The Troubadour": none of Qloo's 2 places with that name is in Los Angeles/);
    expect(notes.choices.find((c) => c.input === "The Troubadour")?.chosen).toBeUndefined();
  });

  it("flags a directly resolved venue whose address doesn't mention the stated city", async () => {
    const qloo = stub();
    qloo.sent.push([]); // skip the needs_input answer
    const notes = new Notes();
    const out = await rankOptions(qloo, notes, {
      options: ["Troubadour", "The Wiltern"],
      optionType: "place",
      signals: ["brand"],
      pins: {},
      field: "venue",
      label: "Rank venues",
      hints: { Troubadour: "Los Angeles", "The Wiltern": "Los Angeles" },
    });
    expect(out.get("Troubadour")).toMatchObject({ id: SANTA_MONICA_BLVD });
    expect(notes.notes.filter((n) => n.includes("check it's the right place"))).toEqual([expect.stringContaining("West Hollywood")]);
  });
});
