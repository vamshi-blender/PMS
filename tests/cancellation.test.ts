import { afterEach, expect, it, vi } from "vitest";
import { setTracingDisabled } from "@openai/agents";
import { ScriptedModel, assistantMessage, modelResponder } from "@openai/agents/testing";
import { donnaAgent } from "../lib/agents/donna";
import { streamDonnaRun } from "../lib/agents/stream-run";
import { streamChat } from "../chrome-extension/src/api/chat";
import { getPmsBundle } from "../chrome-extension/src/pms/bundle";

vi.mock("../chrome-extension/src/api/backend", () => ({ getBackendUrl: async () => "http://localhost" }));
vi.mock("../chrome-extension/src/api/pmsAuth", () => ({ assertPmsScope: async () => "token", getPmsAccessToken: async () => "token", scopeForSignal: () => undefined }));
vi.mock("../chrome-extension/src/api/pmsEnvironment", () => ({ getSelectedEnvironment: async () => "staging" }));
const scope = { environment: "staging" as const, userId: "user", organizationId: "org", sessionId: "00000000-0000-4000-8000-000000000001" };
setTracingDisabled(true);
const originalModel = donnaAgent.model;
afterEach(() => {
  donnaAgent.model = originalModel;
  vi.unstubAllGlobals();
});

it("does not call the model when the incoming request is already aborted", async () => {
  const model = new ScriptedModel([[assistantMessage("Unused")]]);
  donnaAgent.model = model;
  const controller = new AbortController();
  controller.abort();
  const response = new Response(streamDonnaRun({ input: "Hello", conversationId: "conv-test", signal: controller.signal }));
  expect(await response.text()).toBe("");
  expect(model.calls).toHaveLength(0);
});

it("aborts the model when the stream reader cancels, without writing to the closed stream", async () => {
  let cleanedUp = false;
  const model = new ScriptedModel([modelResponder(async ({ request }) => {
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) resolve();
      else request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    cleanedUp = true;
    return [assistantMessage("This must not reach the cancelled stream")];
  })]);
  donnaAgent.model = model;
  const reader = streamDonnaRun({ input: "Hello", conversationId: "conv-test", signal: new AbortController().signal }).getReader();
  await reader.read();
  await vi.waitFor(() => expect(model.calls).toHaveLength(1));
  await reader.cancel();
  await vi.waitFor(() => expect(cleanedUp).toBe(true));
  expect(model.firstCall?.request.signal?.aborted).toBe(true);
});

it("rejects a truncated response instead of leaving the chat waiting", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"type":"response.started","requestId":"r","conversationId":"c"}\n'));
  vi.stubGlobal("fetch", fetchMock);
  await expect(streamChat({ message: "Hello", scope, environment: "staging", signal: new AbortController().signal, onEvent: vi.fn() }))
    .rejects.toThrow("connection ended before Donna finished");
  // The backend only accepts requests carrying the user's PMS session.
  expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer token", "X-Pms-Environment": "staging" });
});

it("cancels and unlocks the reader when a malformed event is received", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"invalid"}\n')); },
    cancel,
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  await expect(streamChat({ message: "Hello", scope, environment: "staging", signal: new AbortController().signal, onEvent: vi.fn() })).rejects.toThrow("unknown stream event");
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it("does not fall back to cached PMS data after cancellation", async () => {
  const controller = new AbortController();
  const readCache = vi.fn();
  vi.stubGlobal("chrome", { storage: { local: { get: readCache } } });
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    expect(options.signal).toBe(controller.signal);
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  }));
  await expect(getPmsBundle(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(readCache).not.toHaveBeenCalled();
});
