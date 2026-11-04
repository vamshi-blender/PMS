import { getBackendUrl } from "./backend";

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Fall back to a status-based message below.
  }
  return `Request failed with status ${response.status}.`;
}

export async function createRealtimeClientSecret(
  signal: AbortSignal,
): Promise<string> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}/api/realtime/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });

  if (!response.ok) throw new Error(await readError(response));
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("value" in body) ||
    typeof body.value !== "string" ||
    !body.value
  ) {
    throw new Error("The backend returned an invalid Realtime credential.");
  }
  return body.value;
}
