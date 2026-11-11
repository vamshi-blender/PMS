import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChatLayout from "../chrome-extension/src/components/ChatLayout";
import type { ChatStreamEvent } from "../chrome-extension/src/api/protocol";

const api = vi.hoisted(() => ({
  stream: vi.fn(), resume: vi.fn(), execute: vi.fn(), claim: vi.fn(),
}));
vi.mock("../chrome-extension/src/api/chat", () => ({
  streamChat: api.stream, resumeChat: api.resume, claimToolExecution: api.claim,
  generateConversationTitle: async () => "Test", deleteConversation: vi.fn(),
}));
vi.mock("../chrome-extension/src/api/clientTools", () => ({ executeClientTool: api.execute }));
vi.mock("../chrome-extension/src/api/pmsAuth", () => ({ getPmsUserDetails: async () => ({ firstName: "Test" }), capturePmsScope: async () => ({ environment: "staging", userId: "user", organizationId: "org", sessionId: "00000000-0000-4000-8000-000000000001" }) }));
vi.mock("../chrome-extension/src/api/chatStorage", async (original) => ({
  ...await original<object>(),
  loadChatStore: async () => ({ activeChatId: null, chats: [] }),
  saveChatStore: vi.fn(),
}));
vi.mock("../chrome-extension/src/mode", () => ({ getSavedMode: async () => "sidepanel", switchMode: vi.fn() }));
vi.mock("../chrome-extension/src/realtime/useVoiceSession", () => ({ useVoiceSession: () => ({}) }));
vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("../chrome-extension/src/components/Composer", () => ({ default: (props: object) => createElement("div", { ...props, "data-testid": "composer" }) }));
vi.mock("../chrome-extension/src/components/MessageList", () => ({ default: (props: object) => createElement("div", { ...props, "data-testid": "messages" }) }));
vi.mock("../chrome-extension/src/components/Sidebar", () => ({ default: () => null }));
vi.mock("../chrome-extension/src/components/Greeting", () => ({ default: () => null }));
vi.mock("../chrome-extension/src/components/VoiceScreen", () => ({ default: () => null }));

let renderer: ReactTestRenderer;
let toolSignal: AbortSignal;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  api.resume.mockReset();
  api.claim.mockReset().mockResolvedValue("claim-test");
  api.execute.mockReset().mockImplementation((_request, signal: AbortSignal) => {
    toolSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  api.stream.mockReset();
  await act(async () => { renderer = create(createElement(ChatLayout, { ctx: "sidepanel", environment: "staging", onEnvironmentChange: vi.fn() })); });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

function pauseWithTool(name: string) {
  api.stream.mockImplementation(async ({ onEvent }: { onEvent: (event: ChatStreamEvent) => void }) => {
    onEvent({ type: "response.started", requestId: "r", conversationId: "conv-test" });
    onEvent({
      type: "tool_approval.request", runId: "run-test", toolCallId: "call-test",
      name, executor: "client", arguments: {}, title: "Confirm", description: "Confirm action",
      confirmLabel: "Allow", requiresApproval: true,
    });
    onEvent({ type: "response.paused", runId: "run-test", pausedAt: Date.now() });
  });
}

it("Stop cancels an automatic browser lookup without sending a resume", async () => {
  pauseWithTool("pms_lookup");
  await act(async () => renderer.root.findByProps({ "data-testid": "composer" }).props.onSend("Check my balance"));
  expect(api.execute).toHaveBeenCalledOnce();
  expect(renderer.root.findByProps({ "data-testid": "composer" }).props.busy).toBe(true);
  await act(async () => renderer.root.findByProps({ "data-testid": "composer" }).props.onCancel());
  expect(toolSignal.aborted).toBe(true);
  expect(api.resume).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ "data-testid": "composer" }).props.busy).toBe(false);
});

it("Stop also covers a browser action after manual approval", async () => {
  pauseWithTool("submit_pms_action");
  await act(async () => renderer.root.findByProps({ "data-testid": "composer" }).props.onSend("Submit leave"));
  const messageList = renderer.root.findByProps({ "data-testid": "messages" });
  const message = messageList.props.messages.find((item: { status?: string }) => item.status === "approval");
  await act(async () => messageList.props.onApproveTool(message.id));
  expect(api.execute).toHaveBeenCalledOnce();
  await act(async () => renderer.root.findByProps({ "data-testid": "composer" }).props.onCancel());
  expect(toolSignal.aborted).toBe(true);
  expect(api.resume).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ "data-testid": "composer" }).props.busy).toBe(false);
});

it("never executes a client action when the backend refuses the approval claim", async () => {
  pauseWithTool("submit_pms_action");
  api.claim.mockRejectedValue(new Error("This tool request expired or was already handled."));
  await act(async () => renderer.root.findByProps({ "data-testid": "composer" }).props.onSend("Submit leave"));
  const messageList = renderer.root.findByProps({ "data-testid": "messages" });
  const message = messageList.props.messages.find((item: { status?: string }) => item.status === "approval");
  await act(async () => messageList.props.onApproveTool(message.id));
  expect(api.execute).not.toHaveBeenCalled();
  expect(api.resume).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ "data-testid": "composer" }).props.busy).toBe(false);
});
