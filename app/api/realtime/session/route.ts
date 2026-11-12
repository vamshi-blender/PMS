import OpenAI from "openai";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { requireCaller } from "@/lib/http/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const headers = { ...corsHeaders(origin), "Cache-Control": "no-store" };
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 503, headers },
    );
  }

  try {
    const secret = await new OpenAI().realtime.clientSecrets.create({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "realtime",
        model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
        output_modalities: ["audio"],
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "auto",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: process.env.OPENAI_REALTIME_VOICE ?? "marin" },
        },
      },
    });

    return Response.json(
      { value: secret.value, expiresAt: secret.expires_at },
      { headers },
    );
  } catch (error) {
    console.error("Failed to create a Realtime client secret", error);
    return Response.json(
      { error: "Donna could not start a voice session. Please try again." },
      { status: 502, headers },
    );
  }
}
