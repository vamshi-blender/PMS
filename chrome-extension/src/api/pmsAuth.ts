// Dynamic PMS authentication. The Bearer token is read fresh out of a PMS
// tab's localStorage on every call — never cached — so the extension always
// rides the session the user currently has in the PMS web app. pmsFetch() is
// the single entry point all authenticated PMS calls (lookups, resolvers,
// executors) must go through.
import { getSessionTabs, isPmsUrl, PMS_HOME_URL } from "./pmsSession";

export const PMS_API_URL = "https://quixyhomeapi.kwixee.co.in";

// The Quixy SPA stores its OIDC session under this literal key in the
// localStorage of the quixyhome origin. The login page lives on the
// quixyhomeapp origin, whose storage never holds the token — so a tab parked
// on the login page correctly reads as logged out.
const OIDC_STORAGE_KEY =
  "oidc.user:https://quixyhomeapp.kwixee.co.in/:angular_spa";

export type PmsAuthState =
  | { status: "ok"; token: string }
  // At least one PMS tab exists, fully loaded, but none holds a live token.
  | { status: "logged-out" }
  // A PMS tab exists but is still loading — too early to call it logged out.
  | { status: "loading" }
  | { status: "no-tab" };

/** PMS tabs to try, session-group tabs first, then any PMS tab anywhere. */
async function findPmsTabs(): Promise<chrome.tabs.Tab[]> {
  const [sessionTabs, allTabs] = await Promise.all([
    getSessionTabs(),
    chrome.tabs.query({}),
  ]);
  const seen = new Set<number>();
  const candidates: chrome.tabs.Tab[] = [];
  for (const tab of [...sessionTabs, ...allTabs]) {
    if (tab.id === undefined || seen.has(tab.id) || !isPmsUrl(tab.url)) continue;
    seen.add(tab.id);
    candidates.push(tab);
  }
  return candidates;
}

// Runs inside the PMS page; must stay self-contained.
function readStorageEntry(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

async function readTokenFromTab(tabId: number): Promise<string | null> {
  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readStorageEntry,
      args: [OIDC_STORAGE_KEY],
    });
    const raw = execution?.result;
    if (typeof raw !== "string") return null;
    const oidc: unknown = JSON.parse(raw);
    if (typeof oidc !== "object" || oidc === null) return null;
    const { access_token, expires_at } = oidc as {
      access_token?: unknown;
      expires_at?: unknown;
    };
    if (typeof access_token !== "string" || access_token.length === 0) {
      return null;
    }
    if (typeof expires_at === "number" && expires_at * 1000 <= Date.now()) {
      return null;
    }
    return access_token;
  } catch {
    // Tab is mid-navigation, discarded, or otherwise not scriptable.
    return null;
  }
}

export async function getPmsAuthState(): Promise<PmsAuthState> {
  const tabs = await findPmsTabs();
  if (tabs.length === 0) return { status: "no-tab" };

  let anyLoading = false;
  for (const tab of tabs) {
    const token = await readTokenFromTab(tab.id!);
    if (token) return { status: "ok", token };
    if (tab.status === "loading") anyLoading = true;
  }
  // The PMS SPA writes its session to localStorage only after it finishes
  // its own client-side bootstrap, which can trail the tab's "complete"
  // status by a few seconds — so treat "loading" as the tab having existed
  // for well under our polling window, and let the caller's own grace period
  // (not just this one tab flag) decide how long to wait before showing the
  // login gate.
  return { status: anyLoading ? "loading" : "logged-out" };
}

export async function getPmsAccessToken(): Promise<string> {
  const state = await getPmsAuthState();
  if (state.status !== "ok") {
    throw new Error(
      state.status === "no-tab"
        ? "No PMS tab is open."
        : "You are not logged in to PMS.",
    );
  }
  return state.token;
}

/** Authenticated fetch against the PMS API; token is re-read on every call. */
export async function pmsFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  init.signal?.throwIfAborted();
  const token = await getPmsAccessToken();
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${PMS_API_URL}${path}`, { ...init, headers });
}

export interface PmsUser {
  firstName: string;
  lastName: string;
  email: string;
  /** Identity fields the PMS executor/resolvers key their calls on. */
  fullName: string;
  userId: string;
  employeeCode: string;
  contactNumber: string;
  organizationId: string;
}

export async function getPmsUserDetails(signal?: AbortSignal): Promise<PmsUser> {
  const response = await pmsFetch("/api/User/GetUserDetails", { signal });
  if (!response.ok) {
    throw new Error(`PMS user lookup failed (${response.status}).`);
  }
  const data: unknown = await response.json();
  const record = (data ?? {}) as Record<string, unknown>;
  const str = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  return {
    firstName: str("FirstName"),
    lastName: str("LastName"),
    email: str("EmailId"),
    fullName: `${str("FirstName")} ${str("LastName")}`.trim(),
    userId: str("UserId"),
    employeeCode: str("EmployeeCode"),
    contactNumber: str("ContactNumber"),
    organizationId: str("OrganizationId"),
  };
}

/**
 * Brings a PMS tab to the foreground so the user can log in: activates the
 * tab, focuses its window (restoring it if minimized), or opens a fresh PMS
 * tab when none exists.
 */
export async function focusPmsTab(): Promise<void> {
  const [tab] = await findPmsTabs();
  if (tab?.id === undefined) {
    await chrome.tabs.create({ url: PMS_HOME_URL, active: true });
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  const win = await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId, {
    focused: true,
    ...(win.state === "minimized" ? { state: "normal" as const } : {}),
  });
}
