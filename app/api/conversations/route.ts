import OpenAI from "openai";
import { z } from "zod";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { callerOwnsScope, requireCaller, scopeForbidden } from "@/lib/http/auth";
import { pmsScopeSchema } from "@/shared/pms-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deleteConversationSchema = z
  .object({
    conversationId: z.string().min(1).max(200),
    scope: pmsScopeSchema,
  })
  .strict();

function unavailableReason(): string | null {
  if (!process.env.OPENAI_API_KEY) return "OPENAI_API_KEY is not configured.";
  // SECURITY: the ENABLE_PRODUCTION_CHAT production kill-switch was removed
  // here (dev-phase decision; see this commit).
  return null;
}

export function OPTIONS(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function DELETE(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) {
    return Response.json({ error: "Origin is not allowed." }, { status: 403 });
  }

  const caller = await requireCaller(request, origin);
  if (caller instanceof Response) return caller;

  const unavailable = unavailableReason();
  if (unavailable) {
    return Response.json(
      { error: unavailable },
      { status: 503, headers: corsHeaders(origin) },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  const parsed = deleteConversationSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "A valid conversation ID is required." },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  if (!callerOwnsScope(caller, parsed.data.scope)) return scopeForbidden(origin);

  try {
    const openai = new OpenAI();
    const conversation = await openai.conversations.retrieve(parsed.data.conversationId, { signal: request.signal });
    const metadata = (conversation.metadata ?? {}) as Record<string, unknown>;
    const scope = parsed.data.scope;
    if (metadata.pms_environment ?
      metadata.pms_environment !== scope.environment || metadata.pms_user !== scope.userId || metadata.pms_organization !== scope.organizationId :
      scope.environment !== "staging") {
      return Response.json({ error: "This conversation belongs to another PMS environment or user." }, { status: 409, headers: corsHeaders(origin) });
    }
    await openai.conversations.delete(parsed.data.conversationId, {
      signal: request.signal,
    });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  } catch (error) {
    if (error instanceof OpenAI.APIError && error.status === 404) {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    console.error("Failed to delete an OpenAI conversation", error);
    return Response.json(
      { error: "Donna could not delete that conversation. Please try again." },
      { status: 502, headers: corsHeaders(origin) },
    );
  }
}
