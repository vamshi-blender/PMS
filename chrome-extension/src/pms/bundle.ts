// Fetches the PMS manifest bundle from the Donna backend. The bundle is the
// extension's entire knowledge of PMS actions/lookups — keeping it
// server-hosted means manifest changes reach users via a deploy, without
// re-zipping the extension. The last good bundle is cached in
// chrome.storage.local as an offline/startup fallback.
import { getBackendUrl } from "../api/backend";
import type { PmsBundle } from "./types";

const BUNDLE_CACHE_KEY = "donnaPmsBundle";
const SUPPORTED_BUNDLE_VERSION = 1;

function isUsableBundle(value: unknown): value is PmsBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as PmsBundle;
  return (
    bundle.version === SUPPORTED_BUNDLE_VERSION &&
    typeof bundle.lookups === "object" &&
    typeof bundle.actions === "object"
  );
}

async function readCachedBundle(): Promise<PmsBundle | null> {
  const stored = await chrome.storage.local.get(BUNDLE_CACHE_KEY);
  const cached = stored[BUNDLE_CACHE_KEY];
  return isUsableBundle(cached) ? cached : null;
}

/**
 * Fresh-first: fetch from the backend and refresh the cache; fall back to
 * the cached copy only when the fetch fails (backend down, offline).
 */
export async function getPmsBundle(signal?: AbortSignal): Promise<PmsBundle> {
  signal?.throwIfAborted();
  const backendUrl = await getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/pms/manifests`, { signal });
    if (!response.ok) throw new Error(`Bundle fetch failed (${response.status}).`);
    const bundle: unknown = await response.json();
    if (!isUsableBundle(bundle)) {
      throw new Error("The server returned a PMS bundle this extension version does not support.");
    }
    await chrome.storage.local.set({ [BUNDLE_CACHE_KEY]: bundle });
    return bundle;
  } catch (error) {
    signal?.throwIfAborted();
    const cached = await readCachedBundle();
    if (cached) return cached;
    throw error instanceof Error
      ? error
      : new Error("Could not load the PMS manifest bundle.");
  }
}
