import { getBackendUrl } from "./backend";
import { isChatStreamEvent, type ChatStreamEvent } from "./protocol";

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

export function streamChat(options: {
  message: string;
  conversationId?: string;
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}) {
  return streamRequest({
    path: "/api/chat",
    body: {
      message: options.message,
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : {}),
    },
    signal: options.signal,
    onEvent: options.onEvent,
  });
}

export function resumeChat(options: {
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
  return streamRequest({
    path: "/api/chat/resume",
    body: {
      runId: options.runId,
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

export async function claimToolExecution(request: { runId: string; toolCallId: string }, signal: AbortSignal): Promise<string> {
  const backendUrl = await getBackendUrl();
  signal.throwIfAborted();
  const response = await fetch(`${backendUrl}/api/chat/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: request.runId, toolCallId: request.toolCallId }),
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

export async function deleteConversation(conversationId: string): Promise<void> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}/api/conversations`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  });

  if (!response.ok) throw new Error(await readError(response));
}
