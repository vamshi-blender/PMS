import { withPromptContext } from "@/shared/prompt-context";
import { z } from "zod";
import { RunState } from "@openai/agents";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import type { ClientToolResult } from "@/lib/agents/donna";
import { getPendingRun, takePendingRun } from "@/lib/agents/pending-runs";
import { restoreRunState, streamDonnaRun } from "@/lib/agents/stream-run";
import { pmsScopeSchema, samePmsScope } from "@/shared/pms-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resumeRequestSchema = z
  .object({
    runId: z.string().uuid(),
    scope: pmsScopeSchema,
    conversationId: z.string().min(1).max(200),
    argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
    toolCallId: z.string().min(1).max(300),
    approved: z.boolean(),
    claimId: z.string().uuid().optional(),
    result: z.unknown().optional(),
    error: z.string().max(1_000).optional(),
    // User-provided alternative instruction; only meaningful with approved: false.
    instruction: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export function OPTIONS(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) {
    return Response.json({ error: "Origin is not allowed." }, { status: 403 });
  }

  // SECURITY: the ENABLE_PRODUCTION_CHAT production kill-switch was removed
  // here (dev-phase decision; see this commit).
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  const parsed = resumeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid resume request." },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  const pending = getPendingRun(parsed.data.runId, parsed.data.toolCallId);
  if (!pending) {
    return Response.json(
      { error: "This tool request expired or was already handled." },
      { status: 410, headers: corsHeaders(origin) },
    );
  }

  if (!pending.context?.scope || !samePmsScope(pending.context.scope, parsed.data.scope) ||
      pending.conversationId !== parsed.data.conversationId || pending.argumentsHash !== parsed.data.argumentsHash) {
    return Response.json({ error: "Approval environment, user, conversation or inputs changed. Start a new request." }, { status: 409, headers: corsHeaders(origin) });
  }

  // Client-executed tools return their result from the browser; the tool's
  // execute() reads it out of the run context. Server-executed tools run on
  // approval inside the SDK, so no client result is expected or stored.
  const clientToolResults: Record<string, ClientToolResult> = {};
  if (pending.executor === "client") {
    const clientResult: ClientToolResult = parsed.data.approved
      ? { ok: true, data: parsed.data.result }
      : {
          ok: false,
          error: parsed.data.error ?? "The user declined this request.",
        };

    if (JSON.stringify(clientResult).length > 60_000) {
      return Response.json(
        { error: "The browser tool result is too large." },
        { status: 413, headers: corsHeaders(origin) },
      );
    }

    clientToolResults[pending.toolCallId] = clientResult;
  }

  const context = pending.context ?? { clientToolResults: {} };
  if (
    (pending.claimId && pending.claimId !== parsed.data.claimId) ||
    (pending.executor === "client" && parsed.data.approved && !pending.claimId)
  ) {
    return Response.json(
      { error: "This browser action must be claimed before execution, or is already being handled." },
      { status: 409, headers: corsHeaders(origin) },
    );
  }
  let state;
  try {
    // Keep the live SDK checkpoint whenever possible, including invocation
    // ownership and approval evidence that cannot safely be reconstructed.
    state = pending.state instanceof RunState
      ? pending.state
      : await restoreRunState(pending.serializedState, context);
  } catch {
    return Response.json(
      { error: "This saved request cannot be resumed. Please start a new request." },
      { status: 409, headers: corsHeaders(origin) },
    );
  }
  const interruption = state
    .getInterruptions()
    .find(
      (item) =>
        item.rawItem.type === "function_call" &&
        item.rawItem.callId === pending.toolCallId &&
        item.name === pending.toolName,
    );

  if (!interruption) {
    return Response.json(
      { error: "The saved tool request is invalid." },
      { status: 409, headers: corsHeaders(origin) },
    );
  }

  request.signal.throwIfAborted();
  if (!takePendingRun(parsed.data.runId, pending)) {
    return Response.json(
      { error: "This tool request expired or was already handled." },
      { status: 410, headers: corsHeaders(origin) },
    );
  }
  Object.assign(context.clientToolResults, clientToolResults);

  if (parsed.data.approved) {
    state.approve(interruption);
  } else {
    state.reject(interruption, {
      message: parsed.data.error ?? "The user declined this request.",
    });
    if (parsed.data.instruction) state.addInput(withPromptContext(parsed.data.instruction));
  }

  const stream = streamDonnaRun({
    input: state,
    conversationId: pending.conversationId,
    signal: request.signal,
    context,
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    },
  });
}
