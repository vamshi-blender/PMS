import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { POST } from "../app/api/chat/route";
import { DELETE } from "../app/api/conversations/route";

const api = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), delete: vi.fn(), stream: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  conversations = { create: api.create, retrieve: api.retrieve, update: api.update, delete: api.delete };
  static APIError = class extends Error {};
} }));
vi.mock("../lib/agents/stream-run", () => ({ streamDonnaRun: api.stream }));
const scope = { environment: "production" as const, userId: "user", organizationId: "org", sessionId: "00000000-0000-4000-8000-000000000001" };
const request = (body: object) => new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "fake-test-key");
  api.create.mockReset().mockResolvedValue({ id: "conv-new" });
  api.retrieve.mockReset().mockResolvedValue({ metadata: { pms_environment: "production", pms_user: "user", pms_organization: "org" } });
  api.update.mockReset().mockResolvedValue({}); api.delete.mockReset().mockResolvedValue({});
  api.stream.mockReset().mockImplementation(() => new ReadableStream({ start(controller) { controller.close(); } }));
});
afterEach(() => vi.unstubAllEnvs());

it("creates a conversation with durable environment and owner metadata", async () => {
  expect((await POST(request({ message: "Hello", scope }))).status).toBe(200);
  expect(api.create.mock.calls[0][0]).toEqual({ metadata: { pms_environment: "production", pms_user: "user", pms_organization: "org" } });
  expect(api.stream.mock.calls[0][0].context.scope).toEqual(scope);
});

it("refuses to continue a conversation in another environment or account", async () => {
  for (const changed of [{ ...scope, environment: "staging" }, { ...scope, userId: "someone-else" }, { ...scope, organizationId: "another-org" }]) {
    expect((await POST(request({ message: "Hello", conversationId: "conv-old", scope: changed }))).status).toBe(409);
  }
  expect(api.stream).not.toHaveBeenCalled();
});

it("adopts old staging conversations once and refuses unknown production history", async () => {
  api.retrieve.mockResolvedValue({ metadata: {} });
  expect((await POST(request({ message: "Hello", conversationId: "legacy", scope: { ...scope, environment: "staging" } }))).status).toBe(200);
  expect(api.update).toHaveBeenCalledOnce();
  expect((await POST(request({ message: "Hello", conversationId: "legacy", scope }))).status).toBe(409);
});

it("requires an explicit PMS binding and refuses cross-environment deletion", async () => {
  expect((await POST(request({ message: "Hello" }))).status).toBe(400);
  expect((await DELETE(request({ conversationId: "conv", scope: { ...scope, environment: "staging" } }))).status).toBe(409);
  expect(api.delete).not.toHaveBeenCalled();
  expect((await DELETE(request({ conversationId: "conv", scope }))).status).toBe(204);
});
