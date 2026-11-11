import type { PmsEnvironment } from "./pmsEnvironment";
import type { PmsScope } from "../../../shared/pms-scope";
import type {
  AgentToolStatus,
  AgentWorkItem,
  AgentWorkLog,
  ChatMessage,
} from "../components/MessageList";

const CHAT_STORE_KEY = "donnaChatStoreV2";
const LEGACY_CURRENT_CHAT_KEY = "donnaCurrentChat";
const DEFAULT_CHAT_TITLE = "New chat";
const MAX_TITLE_LENGTH = 56;

export type ChatTitleStatus = "pending" | "generated" | "fallback" | "manual";

export interface StoredChat {
  id: string;
  title: string;
  titleStatus: ChatTitleStatus;
  messages: ChatMessage[];
  conversationId: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StoredChatStore {
  activeChatId: string | null;
  chats: StoredChat[];
}

export const EMPTY_CHAT_STORE: StoredChatStore = {
  activeChatId: null,
  chats: [],
};

export function createChatTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return DEFAULT_CHAT_TITLE;
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

const TOOL_STATUSES = new Set<AgentToolStatus>([
  "running",
  "awaiting_approval",
  "completed",
  "rejected",
  "failed",
]);

function restoreWorkItem(value: unknown): AgentWorkItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<AgentWorkItem>;

  if (
    item.type === "commentary" &&
    typeof item.id === "string" &&
    typeof item.content === "string"
  ) {
    return { id: item.id, type: "commentary", content: item.content };
  }

  if (
    item.type !== "tool" ||
    typeof item.id !== "string" ||
    typeof item.callId !== "string" ||
    typeof item.name !== "string" ||
    (item.executor !== "client" && item.executor !== "server") ||
    !item.arguments ||
    typeof item.arguments !== "object" ||
    Array.isArray(item.arguments) ||
    !item.status ||
    !TOOL_STATUSES.has(item.status) ||
    typeof item.startedAt !== "number"
  ) {
    return null;
  }

  return {
    id: item.id,
    type: "tool",
    callId: item.callId,
    name: item.name,
    executor: item.executor,
    arguments: item.arguments,
    status: item.status,
    ...(typeof item.output === "string" ? { output: item.output } : {}),
    startedAt: item.startedAt,
    ...(typeof item.completedAt === "number"
      ? { completedAt: item.completedAt }
      : {}),
  };
}

function restoreWorkLog(value: unknown): AgentWorkLog | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const work = value as Partial<AgentWorkLog>;
  if (typeof work.startedAt !== "number" || !Array.isArray(work.items)) {
    return undefined;
  }

  return {
    startedAt: work.startedAt,
    ...(typeof work.pausedAt === "number" ? { pausedAt: work.pausedAt } : {}),
    ...(typeof work.completedAt === "number"
      ? { completedAt: work.completedAt }
      : {}),
    items: work.items
      .map(restoreWorkItem)
      .filter((item): item is AgentWorkItem => item !== null),
  };
}

function restoreMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Partial<ChatMessage>;
  if (
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant") ||
    typeof message.content !== "string"
  ) {
    return null;
  }

  const work = restoreWorkLog(message.work);

  if (
    message.role === "assistant" &&
    (message.status === "pending" ||
      message.status === "streaming" ||
      message.status === "approval")
  ) {
    const interruptedAt = Date.now();
    return {
      id: message.id,
      role: "assistant",
      content: message.content,
      status: "error",
      error: "This response was interrupted. Try sending the message again.",
      work: work
        ? {
            ...work,
            completedAt: work.completedAt ?? interruptedAt,
            items: work.items.map((item) =>
              item.type === "tool" &&
              (item.status === "running" || item.status === "awaiting_approval")
                ? { ...item, status: "failed", completedAt: interruptedAt }
                : item,
            ),
          }
        : undefined,
    };
  }

  return { ...(message as ChatMessage), work };
}

function restoreChat(value: unknown): StoredChat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredChat>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;

  const messages = Array.isArray(candidate.messages)
    ? candidate.messages.map(restoreMessage).filter((item) => item !== null)
    : [];
  const firstUserMessage = messages.find((message) => message.role === "user");
  const now = Date.now();

  return {
    id: candidate.id,
    title:
      typeof candidate.title === "string" && candidate.title.trim()
        ? candidate.title.trim().slice(0, MAX_TITLE_LENGTH)
        : createChatTitle(firstUserMessage?.content ?? ""),
    titleStatus:
      candidate.titleStatus === "pending" ||
      candidate.titleStatus === "generated" ||
      candidate.titleStatus === "fallback" ||
      candidate.titleStatus === "manual"
        ? candidate.titleStatus
        : "fallback",
    messages,
    conversationId:
      typeof candidate.conversationId === "string" && candidate.conversationId
        ? candidate.conversationId
        : null,
    pinned: candidate.pinned === true,
    createdAt:
      typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : now,
    updatedAt:
      typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : now,
  };
}

function restoreStore(value: unknown): StoredChatStore | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredChatStore>;
  if (!Array.isArray(candidate.chats)) return null;

  const seenIds = new Set<string>();
  const chats = candidate.chats
    .map(restoreChat)
    .filter((chat): chat is StoredChat => {
      if (!chat || seenIds.has(chat.id)) return false;
      seenIds.add(chat.id);
      return true;
    });
  const activeChatId =
    typeof candidate.activeChatId === "string" &&
    chats.some((chat) => chat.id === candidate.activeChatId)
      ? candidate.activeChatId
      : null;

  return { activeChatId, chats };
}

function migrateLegacyChat(value: unknown): StoredChatStore | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as {
    messages?: unknown;
    conversationId?: unknown;
    previousResponseId?: unknown;
  };

  // Response chaining cannot be converted into a Conversations API chat.
  if (
    typeof candidate.previousResponseId === "string" &&
    typeof candidate.conversationId !== "string"
  ) {
    return null;
  }

  const messages = Array.isArray(candidate.messages)
    ? candidate.messages.map(restoreMessage).filter((item) => item !== null)
    : [];
  if (messages.length === 0) return null;

  const now = Date.now();
  const firstUserMessage = messages.find((message) => message.role === "user");
  const chat: StoredChat = {
    id: crypto.randomUUID(),
    title: createChatTitle(firstUserMessage?.content ?? ""),
    titleStatus: "fallback",
    messages,
    conversationId:
      typeof candidate.conversationId === "string" ? candidate.conversationId : null,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };

  return { activeChatId: chat.id, chats: [chat] };
}

export async function loadChatStore(environment: PmsEnvironment = "staging", owner?: Pick<PmsScope, "userId" | "organizationId">): Promise<StoredChatStore> {
  // Existing unscoped chats were all staging chats. Keep that key for staging
  // so upgrades preserve history without copying it into production.
  const legacyKey = environment === "staging" ? CHAT_STORE_KEY : `${CHAT_STORE_KEY}:production`;
  const key = owner ? `${legacyKey}:${encodeURIComponent(owner.organizationId)}:${encodeURIComponent(owner.userId)}` : legacyKey;
  if (owner) {
    const records = await chrome.storage.local.get([key, legacyKey, `${legacyKey}:owner`]);
    const current = restoreStore(records[key]);
    if (current) return current;
    // Claim existing environment history for its first signed-in owner once.
    const claimed = records[`${legacyKey}:owner`];
    const ownerKey = `${owner.organizationId}:${owner.userId}`;
    if (!claimed || claimed === ownerKey) {
      const legacy = restoreStore(records[legacyKey]) ?? await loadChatStore(environment);
      if (legacy.chats.length || records[legacyKey]) {
        await chrome.storage.local.set({ [key]: legacy, [`${legacyKey}:owner`]: ownerKey });
        return legacy;
      }
    }
    return { activeChatId: null, chats: [] };
  }
  const stored = await chrome.storage.local.get([
    key,
    LEGACY_CURRENT_CHAT_KEY,
  ]);
  const current = restoreStore(stored[key]);
  if (current) return current;

  if (environment !== "staging") return { activeChatId: null, chats: [] };

  const migrated = migrateLegacyChat(stored[LEGACY_CURRENT_CHAT_KEY]);
  if (migrated) {
    await chrome.storage.local.set({ [CHAT_STORE_KEY]: migrated });
    await chrome.storage.local.remove(LEGACY_CURRENT_CHAT_KEY);
    return migrated;
  }

  return { ...EMPTY_CHAT_STORE };
}

export async function saveChatStore(store: StoredChatStore, environment: PmsEnvironment = "staging", owner?: Pick<PmsScope, "userId" | "organizationId">) {
  const prefix = environment === "staging" ? CHAT_STORE_KEY : `${CHAT_STORE_KEY}:production`;
  const key = owner ? `${prefix}:${encodeURIComponent(owner.organizationId)}:${encodeURIComponent(owner.userId)}` : prefix;
  await chrome.storage.local.set({ [key]: store });
}
