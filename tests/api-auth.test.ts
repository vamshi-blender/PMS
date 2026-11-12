import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as chat } from "../app/api/chat/route";
import { POST as resume } from "../app/api/chat/resume/route";
import { POST as claim } from "../app/api/chat/claim/route";
import { POST as context } from "../app/api/chat/context/route";
import { DELETE as deleteConversation } from "../app/api/conversations/route";
import { POST as title } from "../app/api/conversations/title/route";
import { POST as transcribe } from "../app/api/transcriptions/route";
import { POST as realtime } from "../app/api/realtime/session/route";
import { GET as manifests } from "../app/api/pms/manifests/route";
import { clearVerifiedCallers } from "../lib/http/auth";

const api = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  conversations = { create: api.create };
  static APIError = class extends Error {};
} }));
vi.mock("../lib/agents/stream-run", () => ({ streamDonnaRun: api.stream, restoreRunState: vi.fn() }));

const DEV_KEY = "local-test-key-0123456789abcdef0123456789";
const scope = { environment: "staging" as const, userId: "user-1", organizationId: "org-1", sessionId: "00000000-0000-4000-8000-000000000001" };
const pms = vi.fn();

function pmsUser(userId = "user-1", organizationId = "org-1") {
  return Response.json({ UserId: userId, OrganizationId: organizationId, FirstName: "Test" });
}

function chatRequest(headers: Record<string, string>, body: object = { message: "Hi", scope }) {
  return new Request("http://localhost/api/chat", { method: "POST", headers, body: JSON.stringify(body) });
}

const asPmsUser = { Authorization: "Bearer pms-token", "X-Pms-Environment": "staging" };

beforeEach(() => {
  clearVerifiedCallers();
  vi.stubEnv("OPENAI_API_KEY", "fake-test-key");
  vi.stubGlobal("fetch", pms);
  pms.mockReset().mockImplementation(async () => pmsUser());
  api.create.mockReset().mockResolvedValue({ id: "conv-new" });
  api.stream.mockReset().mockImplementation(() => new ReadableStream({ start(controller) { controller.close(); } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("rejects every route when no credential is sent", async () => {
  const post = (url: string) => new Request(url, { method: "POST", body: "{}" });
  const responses = await Promise.all([
    chat(post("http://localhost/api/chat")),
    resume(post("http://localhost/api/chat/resume")),
    claim(post("http://localhost/api/chat/claim")),
    context(post("http://localhost/api/chat/context")),
    title(post("http://localhost/api/conversations/title")),
    transcribe(post("http://localhost/api/transcriptions")),
    realtime(post("http://localhost/api/realtime/session")),
    deleteConversation(new Request("http://localhost/api/conversations", { method: "DELETE", body: "{}" })),
    manifests(new Request("http://localhost/api/pms/manifests?environment=staging")),
  ]);
  expect(responses.map(response => response.status)).toEqual(Array(9).fill(401));
  expect(pms).not.toHaveBeenCalled();
  expect(api.stream).not.toHaveBeenCalled();
});

it("accepts a PMS token that PMS confirms, asking the right environment", async () => {
  expect((await chat(chatRequest(asPmsUser))).status).toBe(200);
  expect(pms).toHaveBeenCalledOnce();
  const [url, init] = pms.mock.calls[0];
  expect(url).toBe("https://quixyhomeapi.kwixee.co.in/api/User/GetUserDetails");
  expect(init.headers).toEqual({ Authorization: "Bearer pms-token" });
  expect(api.stream.mock.calls[0][0].context.scope).toEqual(scope);
});

it("asks PMS once per token, then reuses the answer", async () => {
  await chat(chatRequest(asPmsUser));
  await chat(chatRequest(asPmsUser));
  expect(pms).toHaveBeenCalledOnce();
  await chat(chatRequest({ ...asPmsUser, Authorization: "Bearer other-token" }));
  expect(pms).toHaveBeenCalledTimes(2);
});

it("rejects a token PMS does not accept, and does not remember it", async () => {
  pms.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await chat(chatRequest(asPmsUser))).status).toBe(401);
  expect(api.stream).not.toHaveBeenCalled();
  expect((await chat(chatRequest(asPmsUser))).status).toBe(200);
});

it("reports a PMS outage as an error instead of letting the caller in", async () => {
  pms.mockRejectedValueOnce(new Error("network down"));
  expect((await chat(chatRequest(asPmsUser))).status).toBe(502);
  pms.mockResolvedValueOnce(new Response(null, { status: 500 }));
  expect((await chat(chatRequest(asPmsUser))).status).toBe(502);
  expect(api.stream).not.toHaveBeenCalled();
});

it("rejects a token without a known environment", async () => {
  expect((await chat(chatRequest({ Authorization: "Bearer pms-token" }))).status).toBe(401);
  expect((await chat(chatRequest({ Authorization: "Bearer pms-token", "X-Pms-Environment": "elsewhere" }))).status).toBe(401);
  expect(pms).not.toHaveBeenCalled();
});

it("refuses to act as a different user, organization or environment than PMS confirmed", async () => {
  for (const claimed of [
    { ...scope, userId: "someone-else" },
    { ...scope, organizationId: "other-org" },
    { ...scope, environment: "production" },
  ]) {
    expect((await chat(chatRequest(asPmsUser, { message: "Hi", scope: claimed }))).status).toBe(403);
  }
  expect(api.stream).not.toHaveBeenCalled();
});

it("accepts the dev key without contacting PMS", async () => {
  vi.stubEnv("DONNA_DEV_API_KEY", DEV_KEY);
  expect((await chat(chatRequest({ Authorization: `Bearer ${DEV_KEY}` }))).status).toBe(200);
  expect(pms).not.toHaveBeenCalled();
});

it("ignores the dev key when it is unset, too short, or on a production deployment", async () => {
  const withDevKey = () => chat(chatRequest({ Authorization: `Bearer ${DEV_KEY}` }));
  expect((await withDevKey()).status).toBe(401);

  vi.stubEnv("DONNA_DEV_API_KEY", "short");
  expect((await chat(chatRequest({ Authorization: "Bearer short" }))).status).toBe(401);

  vi.stubEnv("DONNA_DEV_API_KEY", DEV_KEY);
  vi.stubEnv("VERCEL_ENV", "production");
  expect((await withDevKey()).status).toBe(401);
  expect(api.stream).not.toHaveBeenCalled();
});
