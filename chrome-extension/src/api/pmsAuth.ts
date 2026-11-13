// Dynamic PMS authentication. The Bearer token is read fresh out of a PMS
// tab's localStorage on every call — never cached — so the extension always
// rides the session the user currently has in the PMS web app. pmsFetch() is
// the single entry point all authenticated PMS calls (lookups, resolvers,
// executors) must go through.
import { ensureEnvironmentTab, getSessionTabs, isPmsTab } from "./pmsSession";
import { DEFAULT_ENVIRONMENT, getPmsSessionId, getSelectedEnvironment, PMS_ENVIRONMENTS, type PmsEnvironment } from "./pmsEnvironment";
import { samePmsScope, type PmsScope } from "../../../shared/pms-scope";

const requestScopes = new WeakMap<AbortSignal, PmsScope>();
const identityCache = new Map<PmsEnvironment, { token: string; user: PmsUser }>();

// The Quixy SPA stores its OIDC session under this literal key in the
// localStorage of the quixyhome origin. The login page lives on the
// quixyhomeapp origin, whose storage never holds the token — so a tab parked
// on the login page correctly reads as logged out.
export type PmsAuthState =
  | { status: "ok"; token: string }
  // At least one PMS tab exists, fully loaded, but none holds a live token.
  | { status: "logged-out" }
  // A PMS tab exists but is still loading — too early to call it logged out.
  | { status: "loading" }
  | { status: "no-tab" };

async function findPmsTabs(environment: PmsEnvironment): Promise<chrome.tabs.Tab[]> {
  return (await getSessionTabs()).filter(tab => tab.id !== undefined && isPmsTab(tab, environment));
}

// Runs inside the PMS page; must stay self-contained.
function readStorageEntry(storageKey: string): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

async function readTokenFromTab(tabId: number, environment: PmsEnvironment): Promise<string | null> {
  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readStorageEntry,
      args: [PMS_ENVIRONMENTS[environment].storageKey],
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

export async function getPmsAuthState(environment: PmsEnvironment = DEFAULT_ENVIRONMENT): Promise<PmsAuthState> {
  const tabs = await findPmsTabs(environment);
  if (tabs.length === 0) return { status: "no-tab" };

  let anyLoading = false;
  for (const tab of tabs) {
    const token = await readTokenFromTab(tab.id!, environment);
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

export async function getPmsAccessToken(environment: PmsEnvironment = DEFAULT_ENVIRONMENT): Promise<string> {
  const state = await getPmsAuthState(environment);
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
  const scope = init.signal ? requestScopes.get(init.signal) : undefined;
  if (!scope) throw new Error("PMS requests require a bound user session. Start a new request.");
  const token = await assertPmsScope(scope, init.signal ?? undefined);
  init.signal?.throwIfAborted();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!path.startsWith("/api/") || path.includes("\\") || path.includes("#")) throw new Error("Invalid PMS API path.");
  return fetch(`${PMS_ENVIRONMENTS[scope.environment].apiUrl}${path}`, { ...init, headers, redirect: "error" });
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

export async function getPmsUserDetails(signal?: AbortSignal, environment?: PmsEnvironment): Promise<PmsUser> {
  const bound = signal ? requestScopes.get(signal) : undefined;
  if (bound) {
    await assertPmsScope(bound, signal);
    return identityCache.get(bound.environment)!.user;
  }
  environment ??= await getSelectedEnvironment();
  const token = await getPmsAccessToken(environment);
  return userForToken(environment, token, signal);
}

async function userForToken(environment: PmsEnvironment, token: string, signal?: AbortSignal): Promise<PmsUser> {
  signal?.throwIfAborted();
  const cached = identityCache.get(environment);
  if (cached?.token === token) return cached.user;
  const response = await fetch(`${PMS_ENVIRONMENTS[environment].apiUrl}/api/User/GetUserDetails`, {
    signal, headers: { Authorization: `Bearer ${token}` }, redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`PMS user lookup failed (${response.status}).`);
  }
  const data: unknown = await response.json();
  const record = (data ?? {}) as Record<string, unknown>;
  const str = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  const user = {
    firstName: str("FirstName"),
    lastName: str("LastName"),
    email: str("EmailId"),
    fullName: `${str("FirstName")} ${str("LastName")}`.trim(),
    userId: str("UserId"),
    employeeCode: str("EmployeeCode"),
    contactNumber: str("ContactNumber"),
    organizationId: str("OrganizationId"),
  };
  if (!user.userId || !user.organizationId) throw new Error("PMS did not return a valid user identity.");
  identityCache.set(environment, { token, user });
  return user;
}

/** Capture once per text run/voice session, then recheck before every PMS call.
 * A changed token is resolved afresh; a refresh for the same user is allowed. */
export async function capturePmsScope(signal?: AbortSignal): Promise<PmsScope> {
  const environment = await getSelectedEnvironment();
  const sessionId = await getPmsSessionId();
  const user = await getPmsUserDetails(signal, environment);
  const scope = { environment, sessionId, userId: user.userId, organizationId: user.organizationId };
  await assertPmsScope(scope, signal);
  return scope;
}

export async function assertPmsScope(scope: PmsScope, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const environment = await getSelectedEnvironment();
  const sessionId = await getPmsSessionId();
  if (scope.environment !== environment || scope.sessionId !== sessionId) throw new Error("PMS environment or session changed. Start a new request.");
  const token = await getPmsAccessToken(environment);
  const user = await userForToken(environment, token, signal);
  if (!samePmsScope(scope, { environment, sessionId, userId: user.userId, organizationId: user.organizationId })) {
    throw new Error("The signed-in PMS user changed. Start a new request.");
  }
  // Recheck after asynchronous identity resolution, immediately before dispatch.
  if (await getSelectedEnvironment() !== environment || await getPmsSessionId() !== sessionId) throw new Error("PMS environment or session changed. Start a new request.");
  signal?.throwIfAborted();
  return token;
}

export function scopeForSignal(signal?: AbortSignal): PmsScope | undefined {
  return signal ? requestScopes.get(signal) : undefined;
}

export async function withPmsScope<T>(scope: PmsScope, signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const changed = () => {
    void Promise.all([getSelectedEnvironment(), getPmsSessionId()]).then(([environment, sessionId]) => {
      if (scope.environment !== environment || scope.sessionId !== sessionId) controller.abort(new Error("PMS session changed."));
    });
  };
  chrome.storage.onChanged.addListener(changed);
  requestScopes.set(controller.signal, scope);
  try {
    await assertPmsScope(scope, controller.signal);
    return await execute(controller.signal);
  } finally {
    requestScopes.delete(controller.signal);
    signal?.removeEventListener("abort", abort);
    chrome.storage.onChanged.removeListener(changed);
  }
}

/**
 * Brings a PMS tab to the foreground so the user can log in: activates the
 * tab, focuses its window (restoring it if minimized), or opens a fresh PMS
 * tab when none exists.
 */
export async function focusPmsTab(environment: PmsEnvironment): Promise<void> {
  const tab = await ensureEnvironmentTab(environment, true);
  const win = await chrome.windows.get(tab.windowId);
  await chrome.windows.update(tab.windowId, {
    focused: true,
    ...(win.state === "minimized" ? { state: "normal" as const } : {}),
  });
}
