import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { getPmsBundle } from "@/lib/pms/bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// Serves the PMS manifest bundle the extension's generic executor runs on.
// The extension fetches this on open (and caches it), so manifest changes
// reach every user via a server deploy — no extension re-zip needed.
export function GET(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) {
    return Response.json({ error: "Origin is not allowed." }, { status: 403 });
  }

  const environment = new URL(request.url).searchParams.get("environment");
  if (environment !== "staging" && environment !== "production") {
    return Response.json({ error: "A PMS environment is required." }, { status: 400, headers: corsHeaders(origin) });
  }
  return Response.json(getPmsBundle(environment), {
    headers: {
      ...corsHeaders(origin),
      "Cache-Control": "no-cache",
    },
  });
}
