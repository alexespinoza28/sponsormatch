// Health check for the hosting platform. In live mode it starts (or reuses) the
// local `qloo mcp` process and asks qloo_capabilities for readiness. That tool
// never contacts Qloo, so health checks do not use Qloo quota.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!process.env.QLOO_API_KEY?.trim()) {
    return Response.json({ ok: true, qloo: "mock" });
  }
  try {
    const { harnessReadiness, sharedHarness } = await import("@/lib/qloo/mcp");
    const readiness = await harnessReadiness(sharedHarness());
    return Response.json({ ok: readiness.ready, qloo: "live (qloo mcp)", harness: readiness }, { status: readiness.ready ? 200 : 503 });
  } catch (error) {
    return Response.json(
      { ok: false, qloo: "live (qloo mcp)", error: error instanceof Error ? error.message : "harness unavailable" },
      { status: 503 },
    );
  }
}
