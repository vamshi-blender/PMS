import { z } from "zod";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { callerOwnsScope, requireCaller, scopeForbidden } from "@/lib/http/auth";
import { isRemindersConfigured, listReminders, settleReminders } from "@/lib/reminders/store";
import { pmsScopeSchema } from "@/shared/pms-scope";
import { reminderSettleIdsSchema, type remindersResponseSchema } from "@/shared/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settleSchema = z.object({ scope: pmsScopeSchema, ids: reminderSettleIdsSchema }).strict();

export function OPTIONS(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// The extension reports reminders it has delivered; due ones complete or move
// to their next occurrence. Responds with the fresh open list.
export async function POST(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) {
    return Response.json({ error: "Origin is not allowed." }, { status: 403 });
  }
  const headers = { ...corsHeaders(origin), "Cache-Control": "no-store" };

  const caller = await requireCaller(request, origin);
  if (caller instanceof Response) return caller;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers });
  }

  const parsed = settleSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "A PMS scope and reminder IDs are required." }, { status: 400, headers });
  }
  const { scope, ids } = parsed.data;

  if (!callerOwnsScope(caller, scope)) return scopeForbidden(origin);

  if (!isRemindersConfigured()) {
    return Response.json({ error: "Reminders are not configured." }, { status: 503, headers });
  }

  try {
    const owner = { environment: scope.environment, userId: scope.userId };
    await settleReminders(owner, ids);
    const result: z.infer<typeof remindersResponseSchema> = { reminders: await listReminders(owner) };
    return Response.json(result, { headers });
  } catch (error) {
    console.error("Failed to settle reminders", error);
    return Response.json(
      { error: "Donna could not update your reminders. Please try again." },
      { status: 502, headers },
    );
  }
}
