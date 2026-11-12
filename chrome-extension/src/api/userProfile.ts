import { getBackendUrl } from "./backend";
import { backendAuthHeaders } from "./backendAuth";
import { assertPmsScope } from "./pmsAuth";
import { samePmsScope, type PmsScope } from "../../../shared/pms-scope";
import { pmsUserProfileSchema, type PmsUserProfile } from "../../../shared/pms-user-profile";

// Lives only in this extension surface. Reopening starts with a fresh snapshot.
let snapshot: { scope: PmsScope; profile: PmsUserProfile | null } | undefined;

export function clearUserProfile(): void { snapshot = undefined; }

export function currentUserProfile(scope: PmsScope): PmsUserProfile | null {
  return snapshot && samePmsScope(snapshot.scope, scope) ? snapshot.profile : null;
}

export async function refreshUserProfile(scope: PmsScope, signal: AbortSignal): Promise<void> {
  clearUserProfile();
  const token = await assertPmsScope(scope, signal);
  const backend = await getBackendUrl();
  const response = await fetch(`${backend}/api/pms/profile`, {
    headers: backendAuthHeaders(token, scope.environment), signal, cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not load your PMS profile.");
  const body = await response.json();
  const profile = body.profile === null ? null : pmsUserProfileSchema.parse(body.profile);
  await assertPmsScope(scope, signal);
  signal.throwIfAborted();
  snapshot = { scope, profile };
}
