import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  MenuTwoLineIcon,
  PanelRightIcon,
  PictureInPictureOnIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { getSavedMode, switchMode, type DisplayMode } from "../mode";
import Sidebar, { type SidebarChat } from "./Sidebar";
import Composer from "./Composer";
import Greeting from "./Greeting";
import VoiceScreen from "./VoiceScreen";
import MessageList, {
  type AgentWorkLog,
  type ChatMessage,
  type ToolWorkItem,
} from "./MessageList";
import {
  claimToolExecution,
  deleteConversation,
  generateConversationTitle,
  resumeChat,
  streamChat,
} from "../api/chat";
import { createChatSearcher } from "../api/chatSearch";
import { fetchBaselineContextTokens } from "../api/contextUsage";
import { executeClientTool } from "../api/clientTools";
import { capturePmsScope, getPmsUserDetails } from "../api/pmsAuth";
import type { PmsScope } from "../../../shared/pms-scope";
import { PMS_ENVIRONMENTS, type PmsEnvironment } from "../api/pmsEnvironment";
import type { ToolApprovalRequest } from "../api/protocol";
import type { ChatStreamEvent } from "../api/protocol";
import { useVoiceSession } from "../realtime/useVoiceSession";
import {
  createChatTitle,
  EMPTY_CHAT_STORE,
  loadChatStore,
  saveChatStore,
  type StoredChat,
  type StoredChatStore,
} from "../api/chatStorage";
import "./ChatLayout.css";

const EMPTY_MESSAGES: ChatMessage[] = [];

// Read-only client tools that execute silently: no approval card, the run
// resumes automatically. They still show up in the agent work log. Anything
// that writes (submit_pms_action) keeps the explicit approval card.
const AUTO_EXECUTED_TOOLS = new Set(["pms_lookup"]);

function getWorkLog(message: ChatMessage, startedAt = Date.now()): AgentWorkLog {
  return message.work ?? { startedAt, items: [] };
}

function setToolStatus(
  message: ChatMessage,
  callId: string,
  status: ToolWorkItem["status"],
  completedAt?: number,
): ChatMessage {
  if (!message.work) return message;
  let found = false;
  const items = message.work.items.map((item) => {
    if (item.type !== "tool" || item.callId !== callId) return item;
    found = true;
    return {
      ...item,
      status,
      ...(completedAt ? { completedAt } : {}),
    };
  });

  return found ? { ...message, work: { ...message.work, items } } : message;
}

function resumeWorkClock(message: ChatMessage, resumedAt = Date.now()): ChatMessage {
  if (!message.work?.pausedAt) return message;
  const pausedDuration = Math.max(0, resumedAt - message.work.pausedAt);
  return {
    ...message,
    work: {
      ...message.work,
      startedAt: message.work.startedAt + pausedDuration,
      pausedAt: undefined,
    },
  };
}

interface ChatLayoutProps {
  ctx: DisplayMode;
  environment: PmsEnvironment;
  onEnvironmentChange: (environment: PmsEnvironment) => void;
}

export default function ChatLayout({ ctx, environment, onEnvironmentChange }: ChatLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode | null>(null);
  const [modeHint, setModeHint] = useState("");
  const [chatStore, setChatStore] = useState<StoredChatStore>(EMPTY_CHAT_STORE);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  // Real identity from the PMS session; empty until the fetch resolves.
  const [userName, setUserName] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceClosing, setVoiceClosing] = useState(false);
  // What a new chat occupies before its first message; null until measured.
  const [baselineContextTokens, setBaselineContextTokens] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  // A silent tool request captured mid-stream; consumed (execute + resume)
  // as soon as the paused stream settles.
  const autoToolRef = useRef<ToolApprovalRequest | null>(null);
  const busyRef = useRef(false);
  const modeSwitchingRef = useRef(false);
  const persistedStoreRef = useRef<StoredChatStore | null>(null);
  const ownerRef = useRef<PmsScope | undefined>(undefined);
  if (hydrated) persistedStoreRef.current = chatStore;

  const activeChat =
    chatStore.chats.find((chat) => chat.id === chatStore.activeChatId) ?? null;
  const messages = activeChat?.messages ?? EMPTY_MESSAGES;
  const voiceSession = useVoiceSession(messages, userName, handleCloseVoice);
  const conversationId = activeChat?.conversationId ?? null;
  const hasMessages = messages.length > 0;
  const isNewChat = hydrated && !activeChat;
  const contextTokens = activeChat
    ? activeChat.contextTokens ?? 0
    : baselineContextTokens ?? 0;
  const hasPendingApproval = messages.some((message) => message.status === "approval");
  const sidebarChats: SidebarChat[] = [...chatStore.chats]
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return right.updatedAt - left.updatedAt;
    })
    .map(({ id, title, titleStatus, pinned }) => ({
      id,
      title,
      titlePending: titleStatus === "pending",
      pinned,
    }));
  const searchChats = useMemo(
    () => createChatSearcher(chatStore.chats),
    [chatStore.chats],
  );

  useEffect(() => {
    let cancelled = false;
    void capturePmsScope().then(scope => {
      if (cancelled || scope.environment !== environment) return undefined;
      ownerRef.current = scope;
      return loadChatStore(environment, scope);
    }).then(store => {
      if (!store) return;
      if (!cancelled) { setChatStore(store); setHydrated(true); }
    }).catch(() => {});

    return () => {
      cancelled = true;
      activeRequestRef.current?.abort();
      // Flush the debounce when switching, logging out, or closing the UI.
      if (persistedStoreRef.current) void saveChatStore(persistedStoreRef.current, environment, ownerRef.current);
    };
  }, [environment]);

  // ChatLayout only mounts with a live PMS session (App.tsx gates it), so
  // this normally resolves; on failure the UI just stays nameless.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    getPmsUserDetails(controller.signal, environment)
      .then((user) => {
        if (!cancelled) setUserName(user.firstName);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [environment]);

  // Measure the starting context each time a new chat is opened, so the ring
  // shows instructions + tools instead of an empty 0.
  useEffect(() => {
    if (!isNewChat) return;
    const controller = new AbortController();
    fetchBaselineContextTokens(environment, controller.signal)
      .then(setBaselineContextTokens)
      .catch(() => {});
    return () => controller.abort();
  }, [isNewChat, environment]);

  useEffect(() => {
    if (!hydrated) return;
    const timeout = setTimeout(() => {
      void saveChatStore(chatStore, environment, ownerRef.current);
    }, 150);
    return () => clearTimeout(timeout);
  }, [chatStore, hydrated, environment]);

  useEffect(() => {
    const flush = () => {
      if (persistedStoreRef.current) void saveChatStore(persistedStoreRef.current, environment, ownerRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [environment]);

  useEffect(() => {
    if (!hydrated) return;

    for (const chat of chatStore.chats) {
      if (chat.titleStatus !== "pending") continue;
      const firstUserMessage = chat.messages.find(
        (message) => message.role === "user",
      );
      if (!firstUserMessage) continue;
      void generateTitle(chat.id, firstUserMessage.content);
    }
    // Pending titles are retried once when persisted chats are restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const dock = composerDockRef.current;
    if (!dock) return;

    // Track the floating composer dock's real height so the spacer below the
    // messages can match it exactly — otherwise a growing composer (e.g. a
    // long, multi-line message) covers message content instead of the
    // content scrolling clear of it.
    let lastHeight = dock.getBoundingClientRect().height;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      setComposerHeight(height);
      // Stay pinned to bottom only when the dock's height changes (e.g. the
      // composer growing with a longer message) — a width-only change (e.g.
      // resizing the panel) should never force a scroll.
      if (height !== lastHeight && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      lastHeight = height;
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, [hasMessages]);

  useEffect(() => {
    getSavedMode().then(setDisplayMode);
  }, []);

  useEffect(() => {
    function handleNewChatShortcut(event: globalThis.KeyboardEvent) {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        activeRequestRef.current?.abort();
        setChatStore((current) => ({ ...current, activeChatId: null }));
      }
    }

    window.addEventListener("keydown", handleNewChatShortcut);
    return () => window.removeEventListener("keydown", handleNewChatShortcut);
  }, []);

  async function handleToggleDisplayMode(next: DisplayMode) {
    if (modeSwitchingRef.current || next === displayMode) return;
    modeSwitchingRef.current = true;
    setModeHint("");
    setDisplayMode(next);
    try {
      await switchMode(next, ctx, setModeHint);
    } finally {
      modeSwitchingRef.current = false;
    }
  }

  function setBusyState(next: boolean) {
    busyRef.current = next;
    setBusy(next);
  }

  function updateChat(chatId: string, update: (chat: StoredChat) => StoredChat) {
    setChatStore((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === chatId ? update(chat) : chat)),
    }));
  }

  function updateAssistant(
    chatId: string,
    messageId: string,
    update: (message: ChatMessage) => ChatMessage,
  ) {
    updateChat(chatId, (chat) => ({
      ...chat,
      messages: chat.messages.map((message) =>
        message.id === messageId ? update(message) : message,
      ),
    }));
  }

  async function generateTitle(chatId: string, firstUserMessage: string) {
    try {
      const title = await generateConversationTitle(firstUserMessage);
      updateChat(chatId, (chat) =>
        chat.titleStatus === "pending"
          ? { ...chat, title, titleStatus: "generated" }
          : chat,
      );
    } catch (error) {
      console.error("Could not generate a conversation title", error);
      updateChat(chatId, (chat) =>
        chat.titleStatus === "pending"
          ? {
              ...chat,
              title: createChatTitle(firstUserMessage),
              titleStatus: "fallback",
            }
          : chat,
      );
    }
  }

  function handleStreamEvent(
    chatId: string,
    messageId: string,
    event: ChatStreamEvent,
  ) {
    if (event.type === "response.started") {
      updateChat(chatId, (chat) => ({
        ...chat,
        conversationId: event.conversationId,
      }));
      updateAssistant(chatId, messageId, (message) => resumeWorkClock(message));
    } else if (event.type === "response.delta") {
      updateAssistant(chatId, messageId, (message) => {
        if (event.phase === "commentary") {
          const work = getWorkLog(message);
          const existingIndex = work.items.findIndex(
            (item) => item.type === "commentary" && item.id === event.itemId,
          );
          const items = [...work.items];

          if (existingIndex === -1) {
            items.push({
              id: event.itemId,
              type: "commentary",
              content: event.delta,
            });
          } else {
            const existing = items[existingIndex];
            if (existing.type === "commentary") {
              const trailingNewlines = existing.content.match(/\n+$/)?.[0].length ?? 0;
              const segmentBreak =
                event.startsNewSegment && existing.content.length > 0
                  ? "\n".repeat(Math.max(0, 2 - trailingNewlines))
                  : "";
              items[existingIndex] = {
                ...existing,
                content: existing.content + segmentBreak + event.delta,
              };
            }
          }

          return {
            ...message,
            work: { ...work, items },
            status: "streaming",
            error: undefined,
          };
        }

        const trailingNewlines = message.content.match(/\n+$/)?.[0].length ?? 0;
        const segmentBreak =
          event.startsNewSegment && message.content.length > 0
            ? "\n".repeat(Math.max(0, 2 - trailingNewlines))
            : "";
        const work = message.work?.items.length
          ? {
              ...message.work,
              pausedAt: undefined,
              completedAt: message.work.completedAt ?? Date.now(),
            }
          : message.work;

        return {
          ...message,
          content: message.content + segmentBreak + event.delta,
          work,
          status: "streaming",
          error: undefined,
        };
      });
    } else if (event.type === "tool.started") {
      updateAssistant(chatId, messageId, (message) => {
        const work = getWorkLog(message, event.startedAt);
        const existingIndex = work.items.findIndex(
          (item) => item.type === "tool" && item.callId === event.callId,
        );
        const tool: ToolWorkItem = {
          id: `tool-${event.callId}`,
          type: "tool",
          callId: event.callId,
          name: event.name,
          executor: event.executor,
          arguments: event.arguments,
          status: "running",
          startedAt: event.startedAt,
        };
        const items = [...work.items];
        if (existingIndex === -1) items.push(tool);
        else {
          const existing = items[existingIndex];
          items[existingIndex] =
            existing.type === "tool"
              ? { ...existing, ...tool, status: "running" }
              : tool;
        }

        return {
          ...message,
          work: { ...work, pausedAt: undefined, completedAt: undefined, items },
          status: "streaming",
          error: undefined,
        };
      });
    } else if (event.type === "tool.completed") {
      updateAssistant(chatId, messageId, (message) => {
        if (!message.work) return message;
        const existingIndex = message.work.items.findIndex(
          (item) => item.type === "tool" && item.callId === event.callId,
        );
        // Alternative-instruction resumes stream into a fresh bubble while
        // the rejected tool remains in the previous bubble's work log.
        if (existingIndex === -1) return message;

        const items = [...message.work.items];
        const existing = items[existingIndex];
        if (existing.type === "tool") {
          if (existing.status === "rejected" || existing.status === "failed") {
            return message;
          }
          items[existingIndex] = {
            ...existing,
            status: "completed",
            ...(event.output ? { output: event.output } : {}),
            completedAt: event.completedAt,
          };
        }

        return {
          ...message,
          work: { ...message.work, items },
          status: "streaming",
        };
      });
    } else if (event.type === "tool_approval.request") {
      if (AUTO_EXECUTED_TOOLS.has(event.name)) {
        // Silent tool: no approval card. Keep the tool spinning in the work
        // log and stash the request; executeRequest resumes the run once
        // this (about-to-pause) stream closes.
        autoToolRef.current = event;
        updateAssistant(chatId, messageId, (message) => ({
          ...setToolStatus(message, event.toolCallId, "running"),
          status: "pending",
        }));
      } else {
        updateAssistant(chatId, messageId, (message) => ({
          ...setToolStatus(message, event.toolCallId, "awaiting_approval"),
          status: "approval",
          toolRequest: event,
        }));
      }
    } else if (event.type === "response.paused") {
      updateAssistant(chatId, messageId, (message) => ({
        ...message,
        work: message.work?.items.length
          ? { ...message.work, pausedAt: event.pausedAt }
          : message.work,
      }));
      if (event.contextTokens !== undefined) {
        updateChat(chatId, (chat) => ({ ...chat, contextTokens: event.contextTokens }));
      }
    } else if (event.type === "response.completed") {
      updateAssistant(chatId, messageId, (message) => ({
        ...message,
        status: "done",
        toolRequest: undefined,
        work: message.work?.items.length
          ? {
              ...message.work,
              pausedAt: undefined,
              completedAt: message.work.completedAt ?? Date.now(),
            }
          : message.work,
      }));
      updateChat(chatId, (chat) => ({
        ...chat,
        conversationId: event.conversationId,
        ...(event.contextTokens === undefined
          ? {}
          : { contextTokens: event.contextTokens }),
      }));
    } else if (event.type === "response.error") {
      updateAssistant(chatId, messageId, (message) => {
        const failedAt = Date.now();
        return {
          ...message,
          status: "error",
          error: event.message,
          toolRequest: undefined,
          work: message.work?.items.length
            ? {
                ...message.work,
                pausedAt: undefined,
                completedAt: message.work.completedAt ?? failedAt,
                items: message.work.items.map((item) =>
                  item.type === "tool" &&
                  (item.status === "running" || item.status === "awaiting_approval")
                    ? { ...item, status: "failed" as const, completedAt: failedAt }
                    : item,
                ),
              }
            : message.work,
        };
      });
    }
  }

  async function executeRequest(
    chatId: string,
    messageId: string,
    request: (signal: AbortSignal, onEvent: (event: ChatStreamEvent) => void) => Promise<void>,
  ) {
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setBusyState(true);
    // Anything stashed by a previous stream is stale by definition.
    autoToolRef.current = null;

    try {
      const onEvent = (event: ChatStreamEvent) => {
        if (activeRequestRef.current === controller && !controller.signal.aborted) {
          handleStreamEvent(chatId, messageId, event);
        }
      };
      await request(controller.signal, onEvent);
      controller.signal.throwIfAborted();

      // One controller owns the whole chain, including browser work between
      // streams. Stop must never start a fresh, uncancelled resume request.
      while (true) {
        // Stream callbacks populate this ref asynchronously.
        const toolRequest = autoToolRef.current as ToolApprovalRequest | null;
        if (!toolRequest) break;
        autoToolRef.current = null;
        updateAssistant(chatId, messageId, (current) => resumeWorkClock(current));
        const claimId = await claimToolExecution(toolRequest, controller.signal);
        let result: unknown;
        let error: string | undefined;
        try {
          result = await executeClientTool(toolRequest, controller.signal);
        } catch (toolError) {
          controller.signal.throwIfAborted();
          error = toolError instanceof Error ? toolError.message : "The PMS call failed.";
          updateAssistant(chatId, messageId, (current) =>
            setToolStatus(current, toolRequest.toolCallId, "failed", Date.now()),
          );
        }
        controller.signal.throwIfAborted();
        await resumeChat({
          request: toolRequest,
          runId: toolRequest.runId,
          toolCallId: toolRequest.toolCallId,
          approved: error === undefined,
          claimId,
          result,
          error,
          signal: controller.signal,
          onEvent,
        });
        controller.signal.throwIfAborted();
      }
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      updateAssistant(chatId, messageId, (message) => {
        const stoppedAt = Date.now();
        return {
          ...message,
          status: cancelled && message.content ? "done" : "error",
          error:
            cancelled && !message.content
              ? "Response stopped."
              : cancelled
                ? undefined
                : error instanceof Error
                  ? error.message
                  : "Donna could not respond.",
          toolRequest: undefined,
          work: message.work?.items.length
            ? {
                ...message.work,
                pausedAt: undefined,
                completedAt: message.work.completedAt ?? stoppedAt,
                items: message.work.items.map((item) =>
                  item.type === "tool" &&
                  (item.status === "running" || item.status === "awaiting_approval")
                    ? { ...item, status: "failed" as const, completedAt: stoppedAt }
                    : item,
                ),
              }
            : message.work,
        };
      });
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        autoToolRef.current = null;
        setBusyState(false);
      }
    }
  }

  function handleSend(content: string) {
    if (!hydrated || busyRef.current || hasPendingApproval) return;
    const chatId = activeChat?.id ?? crypto.randomUUID();
    const requestConversationId = activeChat?.conversationId ?? undefined;
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const replyId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: replyId,
      role: "assistant",
      content: "",
      status: "pending",
      work: { startedAt: now, items: [] },
    };

    setChatStore((current) => {
      const existing = current.chats.find((chat) => chat.id === chatId);
      if (existing) {
        return {
          ...current,
          activeChatId: chatId,
          chats: current.chats.map((chat) =>
            chat.id === chatId
              ? {
                  ...chat,
                  messages: [...chat.messages, userMessage, assistantMessage],
                  updatedAt: now,
                }
              : chat,
          ),
        };
      }

      const chat: StoredChat = {
        id: chatId,
        title: "",
        titleStatus: "pending",
        messages: [userMessage, assistantMessage],
        conversationId: null,
        // Start from the measured baseline so the ring does not drop to 0
        // while the first response is in flight.
        ...(baselineContextTokens === null
          ? {}
          : { contextTokens: baselineContextTokens }),
        pinned: false,
        createdAt: now,
        updatedAt: now,
      };
      return {
        activeChatId: chatId,
        chats: [chat, ...current.chats],
      };
    });

    if (!activeChat) void generateTitle(chatId, content);

    void executeRequest(chatId, replyId, (signal, onEvent) =>
      streamChat({
        environment,
        scope: ownerRef.current,
        message: content,
        conversationId: requestConversationId,
        signal,
        onEvent,
      }),
    );
  }

  function handleCancel() {
    activeRequestRef.current?.abort();
  }

  function handleOpenVoice() {
    setVoiceClosing(false);
    setVoiceOpen(true);
    void voiceSession.start(ownerRef.current);
  }

  function handleCloseVoice() {
    if (voiceClosing) return;
    voiceSession.end();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVoiceOpen(false);
      return;
    }

    setVoiceClosing(true);
  }

  function handleVoiceExitComplete() {
    setVoiceOpen(false);
    setVoiceClosing(false);
  }

  function handleNewChat() {
    handleCancel();
    setChatStore((current) => ({ ...current, activeChatId: null }));
  }

  function handleSelectChat(chatId: string) {
    if (chatId === chatStore.activeChatId) return;
    handleCancel();
    setChatStore((current) =>
      current.chats.some((chat) => chat.id === chatId)
        ? { ...current, activeChatId: chatId }
        : current,
    );
  }

  function handleRenameChat(chatId: string, title: string) {
    const normalized = title.replace(/\s+/g, " ").trim().slice(0, 56);
    if (!normalized) return;
    updateChat(chatId, (chat) => ({
      ...chat,
      title: normalized,
      titleStatus: "manual",
    }));
  }

  function handleTogglePinChat(chatId: string) {
    updateChat(chatId, (chat) => ({ ...chat, pinned: !chat.pinned }));
  }

  async function handleDeleteChat(chatId: string): Promise<boolean> {
    const chat = chatStore.chats.find((candidate) => candidate.id === chatId);
    if (!chat) return true;

    try {
      if (chat.conversationId) {
        await deleteConversation(chat.conversationId, ownerRef.current);
      }
    } catch (error) {
      console.error("Could not delete Donna conversation", error);
      return false;
    }

    if (chatId === chatStore.activeChatId) handleCancel();
    setChatStore((current) => ({
      activeChatId:
        current.activeChatId === chatId ? null : current.activeChatId,
      chats: current.chats.filter((candidate) => candidate.id !== chatId),
    }));
    return true;
  }

  async function handleToolDecision(messageId: string, approved: boolean) {
    if (busyRef.current) return;
    const chatId = activeChat?.id;
    if (!chatId) return;
    const message = messages.find((candidate) => candidate.id === messageId);
    const toolRequest = message?.toolRequest;
    if (!toolRequest) return;

    setBusyState(true);

    updateAssistant(chatId, messageId, (current) => ({
      ...setToolStatus(
        resumeWorkClock(current),
        toolRequest.toolCallId,
        approved ? "running" : "rejected",
        approved ? undefined : Date.now(),
      ),
      status: "pending",
      toolRequest: undefined,
    }));

    await executeRequest(chatId, messageId, async (signal, onEvent) => {
      let result: unknown;
      let error: string | undefined;
      let claimId: string | undefined;
      if (approved && toolRequest.executor === "client") {
        claimId = await claimToolExecution(toolRequest, signal);
        try {
          result = await executeClientTool(toolRequest, signal);
        } catch (toolError) {
          signal.throwIfAborted();
          approved = false;
          error = toolError instanceof Error ? toolError.message : "The tool could not complete.";
          updateAssistant(chatId, messageId, (current) =>
            setToolStatus(current, toolRequest.toolCallId, "failed", Date.now()),
          );
        }
      } else if (!approved) {
        error = "The user declined this request.";
      }
      signal.throwIfAborted();
      await resumeChat({
        request: toolRequest,
        runId: toolRequest.runId,
        toolCallId: toolRequest.toolCallId,
        approved,
        claimId,
        result,
        error,
        signal,
        onEvent,
      });
    });
  }

  function handleToolInstruction(messageId: string, instruction: string) {
    if (busyRef.current) return;
    const chatId = activeChat?.id;
    if (!chatId) return;
    const message = messages.find((candidate) => candidate.id === messageId);
    const toolRequest = message?.toolRequest;
    if (!toolRequest) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: instruction,
    };
    const replyId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: replyId,
      role: "assistant",
      content: "",
      status: "pending",
      work: { startedAt: Date.now(), items: [] },
    };

    // Show the instruction as a normal user turn, then stream the resumed
    // run into a fresh assistant bubble below it. The paused approval bubble
    // is closed out — or dropped entirely if the model had no text yet.
    updateChat(chatId, (chat) => ({
      ...chat,
      updatedAt: Date.now(),
      messages: [
        ...chat.messages.map((candidate) =>
            candidate.id === messageId
              ? {
                  ...setToolStatus(
                    candidate,
                    toolRequest.toolCallId,
                    "rejected",
                    Date.now(),
                  ),
                  status: "done" as const,
                  toolRequest: undefined,
                  work: candidate.work?.items.length
                    ? {
                        ...candidate.work,
                        pausedAt: undefined,
                        completedAt: candidate.work.completedAt ?? Date.now(),
                      }
                    : candidate.work,
                }
              : candidate,
          ),
        userMessage,
        assistantMessage,
      ],
    }));

    void executeRequest(chatId, replyId, (signal, onEvent) =>
      resumeChat({
        request: toolRequest,
        runId: toolRequest.runId,
        toolCallId: toolRequest.toolCallId,
        approved: false,
        instruction,
        signal,
        onEvent,
      }),
    );
  }

  function handleRetry(messageId: string) {
    if (busyRef.current || hasPendingApproval) return;
    const chatId = activeChat?.id;
    if (!chatId) return;
    const failedIndex = messages.findIndex((message) => message.id === messageId);
    if (failedIndex < 1) return;
    const previousUser = [...messages.slice(0, failedIndex)]
      .reverse()
      .find((message) => message.role === "user");
    if (!previousUser) return;

    updateAssistant(chatId, messageId, (message) => ({
      ...message,
      content: "",
      status: "pending",
      error: undefined,
      work: { startedAt: Date.now(), items: [] },
    }));
    void executeRequest(chatId, messageId, (signal, onEvent) =>
      streamChat({
        environment,
        scope: ownerRef.current,
        message: previousUser.content,
        conversationId: conversationId ?? undefined,
        signal,
        onEvent,
      }),
    );
  }

  return (
    <div
      className={`chat-layout${
        voiceOpen && !voiceClosing ? " chat-layout--voice-open" : ""
      }${voiceClosing ? " chat-layout--voice-closing" : ""}`}
    >
      <div className="chat-stage">
        <header className="chat-topbar">
          <div className="chat-topbar-brand">
            <button
              type="button"
              className="icon-button sidebar-trigger app-tooltip app-tooltip--bottom app-tooltip--start"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
              data-tooltip="Open sidebar"
            >
              <HugeiconsIcon icon={MenuTwoLineIcon} size={20} />
            </button>
            <span className="chat-brand-labels">
              <span className="chat-brand-name">Donna</span>
              <span className="chat-environment-separator" aria-hidden="true">•</span>
              <span className="chat-environment">{PMS_ENVIRONMENTS[environment].label}</span>
            </span>
          </div>
          <div className="chat-topbar-actions">
            <button
              type="button"
              className="icon-button app-tooltip app-tooltip--bottom app-tooltip--multiline"
              onClick={handleNewChat}
              aria-label="New chat"
              aria-keyshortcuts="Control+Shift+O"
              data-tooltip={"New chat\nCtrl+Shift+O"}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={20} />
            </button>
            <button
              type="button"
              className="display-mode-toggle-btn app-tooltip app-tooltip--bottom app-tooltip--end"
              aria-pressed={displayMode === "sidepanel"}
              onClick={() =>
                handleToggleDisplayMode(displayMode === "sidepanel" ? "popout" : "sidepanel")
              }
              aria-label={
                displayMode === "sidepanel" ? "Switch to pop-out window" : "Switch to side panel"
              }
              data-tooltip={displayMode === "sidepanel" ? "Pop out window" : "Side panel"}
            >
              <HugeiconsIcon
                icon={displayMode === "sidepanel" ? PictureInPictureOnIcon : PanelRightIcon}
                size={20}
              />
            </button>
          </div>
        </header>
        {modeHint && <p className="chat-topbar-hint">{modeHint}</p>}

        {hasMessages ? (
          <div className="chat-thread">
            <div className="chat-scroll" ref={scrollRef}>
              <MessageList
                messages={messages}
                onApproveTool={(messageId) => void handleToolDecision(messageId, true)}
                onRejectTool={(messageId) => void handleToolDecision(messageId, false)}
                onInstructTool={handleToolInstruction}
                onRetry={handleRetry}
              />
              {/* Keep the last message actions comfortably clear of the floating composer. */}
              <div
                className="chat-scroll-spacer"
                style={{ height: `calc(${composerHeight}px + var(--space-6))` }}
              />
            </div>
            <div className="chat-composer-dock" ref={composerDockRef}>
              <div className="chat-composer-area">
                <Composer
                  onSend={handleSend}
                  busy={busy}
                  disabled={!hydrated || hasPendingApproval}
                  captureGlobalTyping={!sidebarOpen && !voiceOpen}
                  onCancel={handleCancel}
                  onVoiceMode={handleOpenVoice}
                  contextTokens={contextTokens}
                />
              </div>
            </div>
          </div>
        ) : (
          <main className="chat-main">
            <div className="chat-composer-area">
              {userName && <Greeting userName={userName} />}
              <Composer
                onSend={handleSend}
                busy={busy}
                disabled={!hydrated || hasPendingApproval}
                captureGlobalTyping={!sidebarOpen && !voiceOpen}
                onCancel={handleCancel}
                onVoiceMode={handleOpenVoice}
                contextTokens={contextTokens}
              />
            </div>
          </main>
        )}
      </div>

      {voiceOpen && (
        <VoiceScreen
          status={voiceSession.status}
          turns={voiceSession.turns}
          muted={voiceSession.muted}
          error={voiceSession.error}
          onMutedChange={voiceSession.setMuted}
          onRetry={() => void voiceSession.start()}
          orbRef={voiceSession.setOrbElement}
          closing={voiceClosing}
          onClose={handleCloseVoice}
          onExitComplete={handleVoiceExitComplete}
        />
      )}

      <Sidebar
        open={sidebarOpen}
        userName={userName}
        environment={environment}
        onEnvironmentChange={onEnvironmentChange}
        chats={sidebarChats}
        activeChatId={chatStore.activeChatId}
        busy={busy}
        onClose={() => setSidebarOpen(false)}
        onSearchChats={searchChats}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onRenameChat={handleRenameChat}
        onTogglePinChat={handleTogglePinChat}
        onDeleteChat={handleDeleteChat}
      />
    </div>
  );
}
