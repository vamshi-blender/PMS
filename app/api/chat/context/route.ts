import { z } from "zod";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { requireCaller } from "@/lib/http/auth";
import { countBaselineContextTokens } from "@/lib/agents/context-usage";
import { pmsScopeSchema } from "@/shared/pms-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const contextRequestSchema = z
  .object({ environment: pmsScopeSchema.shape.environment })
  .strict();

export function OPTIONS(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// Context a new chat starts with, before the first message is sent.
export async function POST(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) {
    return Response.json({ error: "Origin is not allowed." }, { status: 403 });
  }

  const caller = await requireCaller(request, origin);
  if (caller instanceof Response) return caller;

  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured." },
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

  const parsed = contextRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "A PMS environment is required." },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  try {
    const contextTokens = await countBaselineContextTokens(
      parsed.data.environment,
      request.signal,
    );
    return Response.json({ contextTokens }, { headers: corsHeaders(origin) });
  } catch (error) {
    console.error("Failed to count Donna's baseline context tokens", error);
    return Response.json(
      { error: "Donna could not measure the context window." },
      { status: 502, headers: corsHeaders(origin) },
    );
  }
}
