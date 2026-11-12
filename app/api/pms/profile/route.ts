import { requireCaller } from "@/lib/http/auth";
import { corsHeaders, getAllowedOrigin } from "@/lib/http/cors";
import { enrichEmployeeProfile, pmsUserProfile } from "@/lib/pms/user-profile";
import { PMS_API_URLS } from "@/shared/pms-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  const origin = getAllowedOrigin(request);
  return new Response(null, { status: origin === null ? 403 : 204, headers: origin === null ? {} : corsHeaders(origin) });
}

/** A fresh profile snapshot for this opening of the extension. */
export async function GET(request: Request) {
  const origin = getAllowedOrigin(request);
  if (origin === null) return new Response(null, { status: 403 });
  const headers = { ...corsHeaders(origin), "Cache-Control": "no-store" };
  const caller = await requireCaller(request, origin);
  if (caller instanceof Response) return caller;
  if (caller.kind === "dev") return Response.json({ profile: null }, { headers });
  try {
    const token = request.headers.get("Authorization")!.slice("Bearer ".length);
    const apiUrl = PMS_API_URLS[caller.environment];
    const response = await fetch(`${apiUrl}/api/User/GetUserDetails`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("Profile unavailable");
    const user = await response.json();
    if (user?.UserId !== caller.userId || user?.OrganizationId !== caller.organizationId) {
      return Response.json({ error: "PMS account changed. Reopen Donna." }, { status: 403, headers });
    }
    const profile = await enrichEmployeeProfile(pmsUserProfile(user), user.EmployeeCode, apiUrl, token, request.signal);
    return Response.json({ profile }, { headers });
  } catch {
    return Response.json({ error: "Could not load your PMS profile." }, { status: 502, headers });
  }
}
