export type { PmsEnvironment } from "../../../shared/pms-scope";
import type { PmsEnvironment } from "../../../shared/pms-scope";
import { PMS_API_URLS } from "../../../shared/pms-api";

export const PMS_ENVIRONMENTS = {
  staging: {
    label: "Staging",
    homeUrl: "https://quixyhome.kwixee.co.in",
    hosts: ["quixyhome.kwixee.co.in", "quixyhomeapp.kwixee.co.in"],
    apiUrl: PMS_API_URLS.staging,
    storageKey: "oidc.user:https://quixyhomeapp.kwixee.co.in/:angular_spa",
  },
  production: {
    label: "Production",
    homeUrl: "https://vividminds.quixy.com",
    hosts: ["vividminds.quixy.com", "homeids.quixy.com"],
    apiUrl: PMS_API_URLS.production,
    storageKey: "oidc.user:https://homeids.quixy.com/:angular_spa",
  },
} as const;

export const ENVIRONMENT_KEY = "donnaPmsEnvironment";
export const PMS_SESSION_KEY = "donnaPmsSessionId";
export const ENVIRONMENT_IDS: PmsEnvironment[] = ["staging", "production"];

export function environmentFromUrl(url: string | undefined): PmsEnvironment | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return ENVIRONMENT_IDS.find(env =>
      (PMS_ENVIRONMENTS[env].hosts as readonly string[]).includes(parsed.hostname),
    ) ?? null;
  } catch { return null; }
}

export async function getSelectedEnvironment(): Promise<PmsEnvironment> {
  const stored = await chrome.storage.session.get(ENVIRONMENT_KEY);
  return stored[ENVIRONMENT_KEY] === "production" ? "production" : "staging";
}

export async function selectEnvironment(environment: PmsEnvironment): Promise<void> {
  const current = await getSelectedEnvironment();
  const stored = await chrome.storage.session.get(PMS_SESSION_KEY);
  await chrome.storage.session.set({
    [ENVIRONMENT_KEY]: environment,
    [PMS_SESSION_KEY]: current !== environment || !stored[PMS_SESSION_KEY]
      ? crypto.randomUUID() : stored[PMS_SESSION_KEY],
  });
}

export async function getPmsSessionId(): Promise<string> {
  const stored = await chrome.storage.session.get(PMS_SESSION_KEY);
  if (typeof stored[PMS_SESSION_KEY] === "string") return stored[PMS_SESSION_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [PMS_SESSION_KEY]: id });
  return id;
}
