// Published extension zips live in Supabase Storage, one immutable object per
// version: donna-files/extension/donna-<version>.zip. The deploy script
// (scripts/package-extension.mjs) publishes them, and the home page and the
// /donna-extension.zip route read them. Plain .mjs so that script can import it.
//
// The bucket is private. Browsers never get its URL, only a signed link that
// expires after a minute, created by the download route.
import { createClient } from "@supabase/supabase-js";

export const RELEASE_BUCKET = "donna-files";
const RELEASE_FOLDER = "extension";
const SIGNED_URL_SECONDS = 60;

/** @param {string} version */
export function releaseFileName(version) {
  return `donna-${version}.zip`;
}

/** @param {string} version */
export function releasePath(version) {
  return `${RELEASE_FOLDER}/${releaseFileName(version)}`;
}

export function storageConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function bucket() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  globalThis.__donnaReleaseStorage ??= createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return globalThis.__donnaReleaseStorage.storage.from(RELEASE_BUCKET);
}

/**
 * The published zip for a version, or null when none exists.
 * Throws when storage cannot be reached, so callers can tell "missing" from "unknown".
 * @param {string} version
 * @returns {Promise<{ size: number } | null>}
 */
export async function findRelease(version) {
  const name = releaseFileName(version);
  const { data, error } = await bucket().list(RELEASE_FOLDER, { search: name, limit: 10 });
  if (error) throw new Error(`Could not check Supabase Storage: ${error.message}`);
  const found = data.find((file) => file.name === name);
  return found ? { size: Number(found.metadata?.size ?? 0) } : null;
}

/**
 * Stores a version's zip. A version is published once and never replaced: if it
 * already exists (for example a parallel build got there first), that copy stays.
 * @param {string} version
 * @param {Uint8Array} bytes
 * @returns {Promise<"published" | "already-published">}
 */
export async function publishRelease(version, bytes) {
  const { error } = await bucket().upload(releasePath(version), bytes, {
    contentType: "application/zip",
    cacheControl: "31536000",
    upsert: false,
  });
  if (!error) return "published";
  if (/already exists|duplicate/i.test(error.message) || String(error.statusCode) === "409") {
    return "already-published";
  }
  throw new Error(`Could not upload to Supabase Storage: ${error.message}`);
}

/**
 * A one-minute download link for a version's zip, or null when it is not published.
 * @param {string} version
 * @returns {Promise<string | null>}
 */
export async function signedReleaseUrl(version) {
  const { data, error } = await bucket().createSignedUrl(releasePath(version), SIGNED_URL_SECONDS, {
    download: releaseFileName(version),
  });
  if (error) {
    if (/not found/i.test(error.message)) return null;
    throw new Error(`Could not create a download link: ${error.message}`);
  }
  return data.signedUrl;
}
