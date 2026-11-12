import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { requireCaller } from "@/lib/http/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const titleRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(20_000),
  })
  .strict();

const titleResponseSchema = z.object({
  title: z.string().min(1).max(35),
});

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

export async function POST(request: Request) {
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

  const parsed = titleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "A non-empty first message is required." },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  try {
    const openai = new OpenAI();
    const response = await openai.responses.parse(
      {
        model: process.env.OPENAI_TITLE_MODEL ?? "gpt-5.6-luna",
        store: false,
        reasoning: { effort: "none" },
        max_output_tokens: 64,
        instructions: [
          "Create a concise title for a chat using only the user's first message.",
          "Use 3 to 7 words and no more than 35 characters.",
          "Capture the user's specific topic or intent in the user's language.",
          "Do not answer the message. Do not use quotation marks, emoji, or ending punctuation.",
        ].join(" "),
        input: parsed.data.message,
        text: {
          format: zodTextFormat(titleResponseSchema, "conversation_title"),
          verbosity: "low",
        },
      },
      { signal: request.signal },
    );
    const title = response.output_parsed?.title ?? null;

    if (!title) throw new Error("The model returned an invalid conversation title.");

    return Response.json({ title }, { headers: corsHeaders(origin) });
  } catch (error) {
    console.error("Failed to generate an OpenAI conversation title", error);
    return Response.json(
      { error: "Donna could not name this conversation." },
      { status: 502, headers: corsHeaders(origin) },
    );
  }
}
