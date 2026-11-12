import { getBackendUrl } from "./backend";
import { currentBackendAuthHeaders } from "./backendAuth";
import type { PmsEnvironment } from "./pmsEnvironment";

/** Tokens a new chat occupies before the first message (instructions + tools). */
export async function fetchBaselineContextTokens(
  environment: PmsEnvironment,
  signal: AbortSignal,
): Promise<number> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}/api/chat/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...await currentBackendAuthHeaders(environment),
    },
    body: JSON.stringify({ environment }),
    signal,
  });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);

  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("contextTokens" in body) ||
    typeof body.contextTokens !== "number" ||
    !Number.isFinite(body.contextTokens)
  ) {
    throw new Error("The backend returned an invalid context size.");
  }
  return body.contextTokens;
}
