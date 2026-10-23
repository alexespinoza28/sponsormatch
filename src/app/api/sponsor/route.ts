import { BudgetedQloo, CallLog } from "@/lib/optimizer/budget";
import { InputError, validateSponsorInput } from "@/lib/optimizer/input";
import { runSponsorRanking, SPONSOR_CALL_CAP } from "@/lib/optimizer/sponsor";
import type { SponsorEvent } from "@/lib/optimizer/types";
import { createQlooTools } from "@/lib/qloo";
import { ndjsonResponse } from "@/lib/stream";

// Sponsor-side event ranking. Server-only, like /api/optimize. A fixed cap of
// 12 Qloo tool calls bounds a run (a typical one uses 5 or 6).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  let input;
  try {
    input = validateSponsorInput(await request.json());
  } catch (error) {
    return Response.json({ error: error instanceof InputError ? error.message : "Invalid request body." }, { status: 400 });
  }
  const log = new CallLog();
  const qloo = new BudgetedQloo(await createQlooTools({ onCall: log.push, mockLatencyMs: 40 }), SPONSOR_CALL_CAP);
  return ndjsonResponse<SponsorEvent>((emit) => runSponsorRanking(input, { qloo, log, emit }));
}
