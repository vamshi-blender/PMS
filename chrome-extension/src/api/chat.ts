import { getBackendUrl } from "./backend";
import { isChatStreamEvent, type ChatStreamEvent } from "./protocol";
import type { ToolApprovalRequest } from "./protocol";
import { assertPmsScope } from "./pmsAuth";
import { toolArgumentsHash, type PmsScope } from "../../../shared/pms-scope";
import type { PmsEnvironment } from "./pmsEnvironment";

async function approvalBinding(request: ToolApprovalRequest, signal: AbortSignal) {
  if (!request.scope || !request.conversationId || !request.argumentsHash ||
      request.argumentsHash !== await toolArgumentsHash(request.name, request.arguments)) {
    throw new Error("This approval is unbound or its inputs changed. Start a new request.");
  }
  await assertPmsScope(request.scope, signal);
  return { scope: request.scope, conversationId: request.conversationId, argumentsHash: request.argumentsHash };
}

interface StreamRequestOptions {
  path: "/api/chat" | "/api/chat/resume";
  body: Record<string, unknown>;
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Fall back to a status-based message below.
  }
  return `Request failed with status ${response.status}.`;
}

async function streamRequest({
  path,
  body,
  signal,
  onEvent,
}: StreamRequestOptions): Promise<void> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw new Error(await readError(response));
  if (!response.body) throw new Error("The backend returned no response stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let terminal = false;
  const emit = (line: string) => {
    if (!line.trim()) return;
    signal.throwIfAborted();
    const event: unknown = JSON.parse(line);
    if (!isChatStreamEvent(event)) {
      throw new Error("The backend sent an unknown stream event.");
    }
    terminal ||= event.type === "response.completed" ||
      event.type === "response.paused" || event.type === "response.error";
    onEvent(event);
  };

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) emit(line);
      if (done) break;
    }
    emit(buffer);
    signal.throwIfAborted();
    if (!terminal) {
      throw new Error("The response connection ended before Donna finished. Please try again.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamChat(options: {
  message: string;
  environment: PmsEnvironment;
  scope: PmsScope | undefined;
  conversationId?: string;
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}) {
  const scope = options.scope;
  if (!scope) throw new Error("PMS session is not ready. Try again.");
  await assertPmsScope(scope, options.signal);
  if (scope.environment !== options.environment) throw new Error("PMS environment changed. Start a new request.");
  return streamRequest({
    path: "/api/chat",
    body: {
      message: options.message,
      scope,
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : {}),
    },
    signal: options.signal,
    onEvent: options.onEvent,
  });
}

export async function resumeChat(options: {
  request: ToolApprovalRequest;
  runId: string;
  toolCallId: string;
  approved: boolean;
  claimId?: string;
  result?: unknown;
  error?: string;
  instruction?: string;
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}) {
  const binding = await approvalBinding(options.request, options.signal);
  if (options.runId !== options.request.runId || options.toolCallId !== options.request.toolCallId) throw new Error("Approval call changed.");
  return streamRequest({
    path: "/api/chat/resume",
    body: {
      runId: options.runId,
      ...binding,
      toolCallId: options.toolCallId,
      approved: options.approved,
      ...(options.claimId ? { claimId: options.claimId } : {}),
      ...(options.result === undefined ? {} : { result: options.result }),
      ...(options.error ? { error: options.error } : {}),
      ...(options.instruction ? { instruction: options.instruction } : {}),
    },
    signal: options.signal,
    onEvent: options.onEvent,
  });
}

export async function claimToolExecution(request: ToolApprovalRequest, signal: AbortSignal): Promise<string> {
  const binding = await approvalBinding(request, signal);
  const backendUrl = await getBackendUrl();
  signal.throwIfAborted();
  const response = await fetch(`${backendUrl}/api/chat/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: request.runId, toolCallId: request.toolCallId, ...binding }),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("claimId" in body) || typeof body.claimId !== "string") {
    throw new Error("The backend returned an invalid approval claim.");
  }
  return body.claimId;
}

export async function generateConversationTitle(message: string): Promise<string> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}/api/conversations/title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) throw new Error(await readError(response));

  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("title" in body) ||
    typeof body.title !== "string" ||
    !body.title.trim()
  ) {
    throw new Error("The backend returned an invalid conversation title.");
  }

  return body.title.trim().slice(0, 56);
}

export async function deleteConversation(conversationId: string, scope: PmsScope | undefined): Promise<void> {
  if (!scope) throw new Error("PMS session is not ready.");
  await assertPmsScope(scope);
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}/api/conversations`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, scope }),
  });

  if (!response.ok) throw new Error(await readError(response));
}
