import { PMS_ENVIRONMENT_HEADER } from "../../shared/pms-api";

// SECURITY: the exact-origin CORS allowlist (ALLOWED_EXTENSION_ORIGINS env
// var, same-origin check, origin-less request rejection in production) was
// replaced here with a wildcard, so the extension works from any install
// (extension IDs vary per machine/build) without an env allowlist.
// Dev-phase decision; see this commit to restore the allowlist. CORS is not
// what protects these endpoints: every route authenticates the caller (see
// lib/http/auth.ts).
export function getAllowedOrigin(_request: Request): string | null {
  return "*";
}

export function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, Authorization, ${PMS_ENVIRONMENT_HEADER}`,
    "Access-Control-Max-Age": "86400",
  };
}
