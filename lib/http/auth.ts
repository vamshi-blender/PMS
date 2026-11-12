import { createHash, timingSafeEqual } from "node:crypto";
import { corsHeaders } from "./cors";
import { PMS_API_URLS, PMS_ENVIRONMENT_HEADER } from "../../shared/pms-api";
import type { PmsEnvironment, PmsScope } from "../../shared/pms-scope";

// Every API route requires one of two credentials in `Authorization: Bearer`:
//  - a PMS access token, which PMS itself confirms (the normal path: users
//    only ever log in to PMS, and the extension forwards that session), or
//  - DONNA_DEV_API_KEY, a local-testing bypass for curl/scripts.
// The token is only ever forwarded to the fixed PMS origins above. Never log
// or persist it.

export type Caller =
  | { kind: "pms"; environment: PmsEnvironment; userId: string; organizationId: string }
  | { kind: "dev" };

const MAX_TOKEN_LENGTH = 8_192;
const MIN_DEV_KEY_LENGTH = 32;
const VERIFY_TIMEOUT_MS = 10_000;
// A verified token is trusted this long before PMS is asked again, so a PMS
// logout takes at most this long to reach Donna.
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 500;

type PmsCaller = Extract<Caller, { kind: "pms" }>;
const verified = new Map<string, { caller: PmsCaller; expiresAt: number }>();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function devApiKey(): string | null {
  const key = process.env.DONNA_DEV_API_KEY;
  // Never honored on a production deployment, even if set there by mistake.
  if (!key || key.length < MIN_DEV_KEY_LENGTH || process.env.VERCEL_ENV === "production") {
    return null;
  }
  return key;
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "");
  return match && match[1].length <= MAX_TOKEN_LENGTH ? match[1] : null;
}

function environmentOf(request: Request): PmsEnvironment | null {
  const value = request.headers.get(PMS_ENVIRONMENT_HEADER);
  return value === "staging" || value === "production" ? value : null;
}

type Verification = { caller: PmsCaller } | { status: 401 | 502 };

async function verifyWithPms(
  environment: PmsEnvironment,
  token: string,
  signal: AbortSignal,
): Promise<Verification> {
  const cacheKey = `${environment}:${digest(token).toString("hex")}`;
  const cached = verified.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { caller: cached.caller };
  verified.delete(cacheKey);

  let response: Response;
  try {
    response = await fetch(`${PMS_API_URLS[environment]}/api/User/GetUserDetails`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]),
    });
  } catch {
    return { status: 502 };
  }
  if (response.status === 401 || response.status === 403) return { status: 401 };
  if (!response.ok) return { status: 502 };

  const record = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const userId = record?.UserId;
  const organizationId = record?.OrganizationId;
  if (typeof userId !== "string" || !userId || typeof organizationId !== "string" || !organizationId) {
    return { status: 401 };
  }

  const caller: PmsCaller = { kind: "pms", environment, userId, organizationId };
  if (verified.size >= CACHE_LIMIT) {
    const now = Date.now();
    for (const [key, entry] of verified) if (entry.expiresAt <= now) verified.delete(key);
    if (verified.size >= CACHE_LIMIT) verified.clear();
  }
  verified.set(cacheKey, { caller, expiresAt: Date.now() + CACHE_TTL_MS });
  return { caller };
}

/** The authenticated caller, or the error response to return as-is. */
export async function requireCaller(request: Request, origin: string): Promise<Caller | Response> {
  const deny = (status: 401 | 502, error: string) =>
    Response.json({ error }, { status, headers: { ...corsHeaders(origin), "Cache-Control": "no-store" } });

  const token = bearerToken(request);
  if (!token) return deny(401, "Sign in to PMS to use Donna.");

  const devKey = devApiKey();
  if (devKey && timingSafeEqual(digest(token), digest(devKey))) return { kind: "dev" };

  const environment = environmentOf(request);
  if (!environment) return deny(401, "Sign in to PMS to use Donna.");

  const result = await verifyWithPms(environment, token, request.signal);
  if ("caller" in result) return result.caller;
  return result.status === 401
    ? deny(401, "Your PMS session is not valid. Sign in to PMS again.")
    : deny(502, "Donna could not confirm your PMS session. Please try again.");
}

/**
 * Whether the caller may act as the user a request body claims to be. The
 * body's IDs are only claims; the caller's come from PMS.
 */
export function callerOwnsScope(caller: Caller, scope: PmsScope): boolean {
  return caller.kind === "dev" || (
    caller.environment === scope.environment &&
    caller.userId === scope.userId &&
    caller.organizationId === scope.organizationId
  );
}

export function scopeForbidden(origin: string): Response {
  return Response.json(
    { error: "This request does not match the signed-in PMS user. Start a new request." },
    { status: 403, headers: corsHeaders(origin) },
  );
}

/** Test hook: forget previously verified tokens. */
export function clearVerifiedCallers(): void {
  verified.clear();
}
