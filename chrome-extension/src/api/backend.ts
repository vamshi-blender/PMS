const BACKEND_URL_KEY = "donnaBackendUrl";
// The deployed backend, so a colleague who installs the shared zip works without
// touching settings. To develop against a local server, set the backend in the
// sidebar, or build with VITE_DEFAULT_BACKEND_URL=http://localhost:3000.
export const DEFAULT_BACKEND_URL =
  import.meta.env.VITE_DEFAULT_BACKEND_URL || "https://worklogs-wheat.vercel.app";

export function normalizeBackendUrl(value: string): string {
  const url = new URL(value.trim());
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");

  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Use HTTPS, or HTTP only for localhost.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Enter only the backend origin, without credentials or query parameters.");
  }

  return url.origin;
}

export async function getBackendUrl(): Promise<string> {
  const stored = await chrome.storage.sync.get(BACKEND_URL_KEY);
  const candidate = stored[BACKEND_URL_KEY];
  if (typeof candidate !== "string") return DEFAULT_BACKEND_URL;

  try {
    return normalizeBackendUrl(candidate);
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

export async function saveBackendUrl(value: string): Promise<string> {
  // SECURITY: the per-origin chrome.permissions.contains/request flow was
  // removed here — all http/https hosts are now granted via host_permissions
  // in the manifest. Dev-phase decision; see this commit to restore it.
  const backendUrl = normalizeBackendUrl(value);
  await chrome.storage.sync.set({ [BACKEND_URL_KEY]: backendUrl });
  return backendUrl;
}

export function getExtensionOrigin(): string {
  return new URL(chrome.runtime.getURL("/")).origin;
}
