import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { environmentFromUrl, getSelectedEnvironment, PMS_ENVIRONMENTS, selectEnvironment } from "../chrome-extension/src/api/pmsEnvironment";
import { endSessionIfGroupLostPmsTab, ensureSessionTabGroup, getSessionTabs, switchPmsEnvironment } from "../chrome-extension/src/api/pmsSession";
import { assertPmsScope, capturePmsScope, getPmsAuthState, pmsFetch, withPmsScope } from "../chrome-extension/src/api/pmsAuth";
import { getPmsBundle as serverBundle } from "../lib/pms/bundle";
import { getPmsBundle } from "../chrome-extension/src/pms/bundle";
import { toolArgumentsHash } from "../shared/pms-scope";
import { loadChatStore, saveChatStore, type StoredChatStore } from "../chrome-extension/src/api/chatStorage";

let local: Record<string, unknown>;
let session: Record<string, unknown>;
let tabs: chrome.tabs.Tab[];
let groups: Map<number, { id: number; windowId: number }>;
let tokens: Map<number, Record<string, string>>;
let sent: ReturnType<typeof vi.fn>;
let nextId: number;

const tab = (id: number, url: string, groupId = -1, windowId = 1) => ({ id, url, groupId, windowId, active: true, status: "complete" }) as chrome.tabs.Tab;
const area = (data: Record<string, unknown>) => ({
  get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]))),
  set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
  remove: vi.fn(async (key: string) => { delete data[key]; }),
});

beforeEach(() => {
  local = {}; session = {}; tabs = []; groups = new Map(); tokens = new Map(); nextId = 10;
  sent = vi.fn(async () => {});
  vi.stubGlobal("chrome", {
    storage: { local: area(local), session: area(session), sync: area({}), onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: vi.fn(async (id: number) => { if (!groups.has(id)) throw new Error("Missing group"); return groups.get(id); }),
      update: vi.fn(async () => {}),
    },
    tabs: {
      query: vi.fn(async (query: { groupId?: number }) => tabs.filter(t => query.groupId === undefined || t.groupId === query.groupId)),
      create: vi.fn(async (input: Partial<chrome.tabs.Tab>) => { const created = { ...tab(nextId++, input.url!, -1, input.windowId), ...input }; tabs.push(created); return created; }),
      get: vi.fn(async (id: number) => tabs.find(t => t.id === id)),
      update: vi.fn(async (id: number, input: Partial<chrome.tabs.Tab>) => { const found = tabs.find(t => t.id === id)!; Object.assign(found, input); return found; }),
      group: vi.fn(async (input: { groupId?: number; tabIds: number[]; createProperties?: { windowId: number } }) => {
        const id = input.groupId ?? nextId++;
        if (!groups.has(id)) groups.set(id, { id, windowId: input.createProperties!.windowId });
        for (const found of tabs) if (input.tabIds.includes(found.id!)) found.groupId = id;
        return id;
      }),
    },
    scripting: { executeScript: vi.fn(async (input: { target: { tabId: number }; args: string[] }) => [{ result: tokens.get(input.target.tabId)?.[input.args[0]] ?? null }]) },
    runtime: { sendMessage: sent },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function login(id: number, environment: "staging" | "production", expires_at = Date.now() / 1000 + 3600) {
  tokens.set(id, { [PMS_ENVIRONMENTS[environment].storageKey]: JSON.stringify({ access_token: environment + "-token", expires_at }) });
}

it("recognizes only exact PMS HTTPS hosts", () => {
  expect(environmentFromUrl("https://vividminds.quixy.com/apps")).toBe("production");
  expect(environmentFromUrl("https://quixyhomeapp.kwixee.co.in/")).toBe("staging");
  expect(environmentFromUrl("https://homeids.quixy.com/")).toBe("production");
  for (const url of ["https://vividminds.quixy.com.evil.test", "http://vividminds.quixy.com", "invalid"]) expect(environmentFromUrl(url)).toBeNull();
});

it("selects the clicked PMS environment and groups that tab without opening the other one", async () => {
  const clicked = tab(1, PMS_ENVIRONMENTS.production.homeUrl); tabs.push(clicked);
  await ensureSessionTabGroup(clicked);
  expect(await getSelectedEnvironment()).toBe("production");
  expect(await getSessionTabs()).toEqual([clicked]);
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});

it("opens both environments from a random tab and reuses them on another open", async () => {
  const clicked = tab(1, "https://example.com"); tabs.push(clicked);
  const groupId = await ensureSessionTabGroup(clicked);
  expect((await getSessionTabs()).map(t => environmentFromUrl(t.url)).sort()).toEqual(["production", "staging"]);
  expect(await ensureSessionTabGroup(clicked)).toBe(groupId);
  expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
});

it("opens exactly one tab per environment when Chrome only reports pending URLs", async () => {
  const createTab = vi.mocked(chrome.tabs.create).getMockImplementation() as unknown as (input: chrome.tabs.CreateProperties) => Promise<chrome.tabs.Tab>;
  vi.mocked(chrome.tabs.create).mockImplementation(async (input) => {
    const created = await createTab(input);
    created.pendingUrl = created.url;
    created.url = "";
    created.status = "loading";
    return created;
  });
  const clicked = tab(1, "https://example.com"); tabs.push(clicked);
  const groupId = await ensureSessionTabGroup(clicked);
  expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  expect((await getSessionTabs()).map(t => environmentFromUrl(t.pendingUrl)).sort()).toEqual(["production", "staging"]);
  // Reopening while both navigations are pending must reuse both tabs.
  expect(await ensureSessionTabGroup(clicked)).toBe(groupId);
  await switchPmsEnvironment("staging");
  await switchPmsEnvironment("production");
  await endSessionIfGroupLostPmsTab(groupId);
  expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  expect(sent).not.toHaveBeenCalled();
});

it("does not query for the freshly created staging anchor before its URL is available", async () => {
  const createTab = vi.mocked(chrome.tabs.create).getMockImplementation() as unknown as (input: chrome.tabs.CreateProperties) => Promise<chrome.tabs.Tab>;
  vi.mocked(chrome.tabs.create).mockImplementation(async (input) => {
    const created = await createTab(input);
    if (created.url === PMS_ENVIRONMENTS.staging.homeUrl) created.url = "";
    return created;
  });
  const clicked = tab(1, "https://example.com"); tabs.push(clicked);
  await ensureSessionTabGroup(clicked);
  expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
});

it("uses an existing user group and adds both missing PMS tabs", async () => {
  groups.set(5, { id: 5, windowId: 1 }); const clicked = tab(1, "https://example.com", 5); tabs.push(clicked);
  expect(await ensureSessionTabGroup(clicked)).toBe(5);
  expect((await getSessionTabs()).length).toBe(3);
  expect(chrome.tabGroups.update).not.toHaveBeenCalled();
});

it("keeps production open after staging is closed, then recreates staging in the same group", async () => {
  const clicked = tab(1, "https://example.com"); tabs.push(clicked);
  const groupId = await ensureSessionTabGroup(clicked);
  await switchPmsEnvironment("production");
  tabs = tabs.filter(t => environmentFromUrl(t.url) !== "staging");
  await endSessionIfGroupLostPmsTab(groupId);
  expect(sent).not.toHaveBeenCalled();
  await switchPmsEnvironment("staging");
  expect(await getSelectedEnvironment()).toBe("staging");
  expect((await getSessionTabs()).filter(t => environmentFromUrl(t.url) === "staging")).toHaveLength(1);
  expect(session.donnaTabGroupId).toBe(groupId);
  await switchPmsEnvironment("production");
  expect(chrome.tabs.create).toHaveBeenCalledTimes(3);
});

it("checks logins independently and never borrows a token from another group", async () => {
  const clicked = tab(1, "https://example.com"); tabs.push(clicked);
  await ensureSessionTabGroup(clicked);
  const members = await getSessionTabs();
  const prod = members.find(t => environmentFromUrl(t.url) === "production")!;
  login(prod.id!, "production");
  expect(await getPmsAuthState("production")).toMatchObject({ status: "ok", token: "production-token" });
  expect(await getPmsAuthState("staging")).toEqual({ status: "logged-out" });
  const unrelated = tab(99, PMS_ENVIRONMENTS.staging.homeUrl, 999); tabs.push(unrelated); login(99, "staging");
  expect(await getPmsAuthState("staging")).toEqual({ status: "logged-out" });
  login(prod.id!, "production", 1);
  expect(await getPmsAuthState("production")).toEqual({ status: "logged-out" });
});

it("switches to a logged-out environment without requiring the other login", async () => {
  const clicked = tab(1, PMS_ENVIRONMENTS.production.homeUrl); tabs.push(clicked);
  await ensureSessionTabGroup(clicked); login(1, "production");
  await switchPmsEnvironment("staging");
  expect(await getSelectedEnvironment()).toBe("staging");
  expect(await getPmsAuthState("staging")).toEqual({ status: "logged-out" });
  expect(await getPmsAuthState("production")).toMatchObject({ status: "ok" });
});

const store = (id: string): StoredChatStore => ({ activeChatId: id, chats: [{
  id, title: id, titleStatus: "manual", messages: [], conversationId: `conv-${id}`, pinned: false, createdAt: 1, updatedAt: 1,
}] });

it("keeps existing history in staging and independently restores each environment's last chat", async () => {
  local.donnaChatStoreV2 = store("old-staging");
  expect(await loadChatStore("production")).toEqual({ activeChatId: null, chats: [] });
  expect(await loadChatStore("staging")).toEqual(store("old-staging"));
  await saveChatStore(store("prod"), "production");
  await saveChatStore(store("new-staging"), "staging");
  expect(await loadChatStore("production")).toEqual(store("prod"));
  expect(await loadChatStore("staging")).toEqual(store("new-staging"));
});

it("does not migrate a legacy staging conversation into production", async () => {
  local.donnaCurrentChat = { conversationId: "legacy", messages: [{ id: "m1", role: "user", content: "hello" }] };
  expect((await loadChatStore("production")).chats).toHaveLength(0);
  expect((await loadChatStore("staging")).chats[0].conversationId).toBe("legacy");
});

it("blocks unbound PMS calls before making a network request", async () => {
  const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
  await selectEnvironment("production");
  await expect(pmsFetch("/api/App/SaveAppData", { method: "POST" })).rejects.toThrow("bound user session");
  expect(fetchSpy).not.toHaveBeenCalled();
});

async function authenticatedProduction() {
  const clicked = tab(1, PMS_ENVIRONMENTS.production.homeUrl); tabs.push(clicked);
  await ensureSessionTabGroup(clicked);
  const token = crypto.randomUUID();
  tokens.set(1, { [PMS_ENVIRONMENTS.production.storageKey]: JSON.stringify({ access_token: token, expires_at: Date.now() / 1000 + 3600 }) });
  const fetchSpy = vi.fn(async () => Response.json({ UserId: "user-a", OrganizationId: "org", EmployeeCode: "E1", EmailId: "person@example.com" }));
  vi.stubGlobal("fetch", fetchSpy);
  const scope = await capturePmsScope();
  return { scope, fetchSpy, token };
}

it("routes a bound production lookup and write to production with its own token", async () => {
  const { scope, fetchSpy, token } = await authenticatedProduction();
  fetchSpy.mockClear();
  await withPmsScope(scope, undefined, async signal => {
    await pmsFetch("/api/Report/GetViewResult", { signal });
    await pmsFetch("/api/App/SaveAppData", { signal, method: "POST", body: "{}" });
  });
  expect(fetchSpy.mock.calls).toHaveLength(2);
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.map(([url]) => url)).toEqual(["https://homeapi.quixy.com/api/Report/GetViewResult", "https://homeapi.quixy.com/api/App/SaveAppData"]);
  expect(new Headers(calls[1][1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
});

it("rejects an old approval after switching away and back, without dispatching its write", async () => {
  const { scope, fetchSpy } = await authenticatedProduction();
  await selectEnvironment("staging"); await selectEnvironment("production");
  fetchSpy.mockClear();
  await expect(withPmsScope(scope, undefined, signal => pmsFetch("/api/App/SaveAppData", { signal }))).rejects.toThrow("session changed");
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("rejects account changes and expired sessions; a same-user token refresh remains valid", async () => {
  const { scope, fetchSpy } = await authenticatedProduction();
  tokens.set(1, { [PMS_ENVIRONMENTS.production.storageKey]: JSON.stringify({ access_token: crypto.randomUUID(), expires_at: Date.now() / 1000 + 3600 }) });
  await expect(assertPmsScope(scope)).resolves.toBeTypeOf("string");
  tokens.set(1, { [PMS_ENVIRONMENTS.production.storageKey]: JSON.stringify({ access_token: crypto.randomUUID(), expires_at: Date.now() / 1000 + 3600 }) });
  fetchSpy.mockResolvedValue(Response.json({ UserId: "user-b", OrganizationId: "org" }));
  await expect(assertPmsScope(scope)).rejects.toThrow("user changed");
  tokens.clear();
  await expect(assertPmsScope(scope)).rejects.toThrow("not logged in");
});

it("stops between resolver calls when the environment changes", async () => {
  const { scope, fetchSpy } = await authenticatedProduction();
  fetchSpy.mockClear();
  await expect(withPmsScope(scope, undefined, async signal => {
    await pmsFetch("/api/Report/GetViewResult", { signal });
    await selectEnvironment("staging");
    return pmsFetch("/api/App/SaveAppData", { signal });
  })).rejects.toThrow("session changed");
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it("keeps manifest fallback caches separated by backend and environment", async () => {
  const { scope } = await authenticatedProduction();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(serverBundle("production"))));
  expect((await getPmsBundle()).environment).toBe("production");
  await selectEnvironment("staging");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Offline"); }));
  // Staging has no cached bundle (and no session to fetch one with), so the
  // production cache must not be served in its place.
  await expect(getPmsBundle()).rejects.toThrow();
  await selectEnvironment(scope.environment);
  expect((await getPmsBundle()).environment).toBe("production");
});

it("rejects a bundle labelled with the wrong environment", async () => {
  await authenticatedProduction();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(serverBundle("staging"))));
  await expect(getPmsBundle()).rejects.toThrow("does not support");
});

it("separates histories by signed-in user and migrates old history only once", async () => {
  local.donnaChatStoreV2 = store("legacy");
  const a = { userId: "a", organizationId: "org" }, b = { userId: "b", organizationId: "org" };
  expect((await loadChatStore("staging", a)).activeChatId).toBe("legacy");
  expect((await loadChatStore("staging", b)).chats).toEqual([]);
  await saveChatStore(store("b-chat"), "staging", b);
  expect((await loadChatStore("staging", a)).activeChatId).toBe("legacy");
  expect((await loadChatStore("staging", b)).activeChatId).toBe("b-chat");
});

it("fingerprints approved values independently of object order and detects modified inputs", async () => {
  expect(await toolArgumentsHash("action", { a: 1, b: [2] })).toBe(await toolArgumentsHash("action", { b: [2], a: 1 }));
  expect(await toolArgumentsHash("action", { a: 1 })).not.toBe(await toolArgumentsHash("action", { a: 2 }));
});
