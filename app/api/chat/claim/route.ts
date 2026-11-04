import { z } from "zod";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { claimPendingRun, getPendingRun } from "@/lib/agents/pending-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ runId: z.string().uuid(), toolCallId: z.string().min(1).max(300) }).strict();

export function OPTIONS(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// Claim before executing in the browser, so expired or concurrently handled
// approvals cannot submit a client-side action and only fail at resume time.
export async function POST(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return Response.json({ error: "Origin is not allowed." }, { status: 403 });
  const headers = { ...corsHeaders(origin), "Cache-Control": "no-store" };
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid approval request." }, { status: 400, headers });
  request.signal.throwIfAborted();
  const pending = getPendingRun(parsed.data.runId, parsed.data.toolCallId);
  if (!pending) return Response.json({ error: "This tool request expired or was already handled." }, { status: 410, headers });
  if (pending.executor !== "client") return Response.json({ error: "This tool runs on the server." }, { status: 409, headers });
  const claimId = claimPendingRun(parsed.data.runId, parsed.data.toolCallId);
  if (!claimId) return Response.json({ error: "This action is already being handled. Check its result before trying again." }, { status: 409, headers });
  return Response.json({ claimId }, { headers });
}
