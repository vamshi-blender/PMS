// Fetches the PMS manifest bundle from the Donna backend. The bundle is the
// extension's entire knowledge of PMS actions/lookups — keeping it
// server-hosted means manifest changes reach users via a deploy, without
// re-zipping the extension. The last good bundle is cached in
// chrome.storage.local as an offline/startup fallback.
import { getBackendUrl } from "../api/backend";
import { currentBackendAuthHeaders } from "../api/backendAuth";
import type { PmsBundle } from "./types";
import { scopeForSignal } from "../api/pmsAuth";
import { getSelectedEnvironment, type PmsEnvironment } from "../api/pmsEnvironment";

const BUNDLE_CACHE_KEY = "donnaPmsBundle";
const SUPPORTED_BUNDLE_VERSION = 7;

function isUsableBundle(value: unknown, environment: PmsEnvironment): value is PmsBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as PmsBundle;
  return (
    bundle.version === SUPPORTED_BUNDLE_VERSION &&
    bundle.environment === environment &&
    typeof bundle.lookups === "object" &&
    typeof bundle.actions === "object"
  );
}

async function readCachedBundle(key: string, environment: PmsEnvironment): Promise<PmsBundle | null> {
  const stored = await chrome.storage.local.get(key);
  const cached = stored[key];
  return isUsableBundle(cached, environment) ? cached : null;
}

/**
 * Fresh-first: fetch from the backend and refresh the cache; fall back to
 * the cached copy only when the fetch fails (backend down, offline).
 */
export async function getPmsBundle(signal?: AbortSignal): Promise<PmsBundle> {
  signal?.throwIfAborted();
  const backendUrl = await getBackendUrl();
  const environment = scopeForSignal(signal)?.environment ?? await getSelectedEnvironment();
  const key = `${BUNDLE_CACHE_KEY}:${backendUrl}:${environment}`;
  try {
    const response = await fetch(`${backendUrl}/api/pms/manifests?environment=${environment}`, {
      headers: await currentBackendAuthHeaders(environment),
      signal,
    });
    if (!response.ok) throw new Error(`Bundle fetch failed (${response.status}).`);
    const bundle: unknown = await response.json();
    if (!isUsableBundle(bundle, environment)) {
      throw new Error("The server returned a PMS bundle this extension version does not support.");
    }
    await chrome.storage.local.set({ [key]: bundle });
    return bundle;
  } catch (error) {
    signal?.throwIfAborted();
    const cached = await readCachedBundle(key, environment);
    if (cached) return cached;
    throw error instanceof Error
      ? error
      : new Error("Could not load the PMS manifest bundle.");
  }
}
