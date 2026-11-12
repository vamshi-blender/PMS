import { isMemoryConfigured, loadMemories, type LoadedMemories, type MemoryOwner } from "./store";

const INDIA_OFFSET_MS = 19_800_000;

/**
 * The instant a memory stops being shown, given the last India date on which
 * it is still relevant: the start of the following day in India.
 */
export function expiryInstant(lastRelevantDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastRelevantDate)) return null;
  const startOfDayUtc = Date.parse(`${lastRelevantDate}T00:00:00Z`);
  if (Number.isNaN(startOfDayUtc)) return null;
  // Reject dates like 2026-02-31 that Date.parse rolls over or refuses.
  if (new Date(startOfDayUtc).toISOString().slice(0, 10) !== lastRelevantDate) return null;
  return new Date(startOfDayUtc + 86_400_000 - INDIA_OFFSET_MS).toISOString();
}

/** Inverse of expiryInstant: the last India date a memory is still shown. */
function lastRelevantDate(expiresAt: string): string {
  return new Date(Date.parse(expiresAt) - 1 + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

function line(id: number, content: string, expiresAt: string | null): string {
  const text = content.replace(/\s+/g, " ").trim();
  return `[${id}] ${text}${expiresAt ? ` (until ${lastRelevantDate(expiresAt)})` : ""}`;
}

export function formatMemoryBlock(memories: LoadedMemories): string {
  const organization = memories.organization.length
    ? memories.organization.map((item) => line(item.id, item.content, null)).join("\n")
    : "(none)";
  const user = memories.user.length
    ? memories.user.map((item) => line(item.id, item.content, item.expiresAt)).join("\n")
    : "(none)";
  return `<donna_memory>
Organization rules (approved, apply to everyone):
${organization}
About this user (remembered from earlier chats):
${user}
</donna_memory>`;
}

/**
 * The memory section appended to Donna's instructions on every model call, so
 * she always sees the current state. Memory problems never block a chat: the
 * section is simply left out.
 */
export async function memoryInstructions(owner: MemoryOwner | undefined): Promise<string> {
  if (!owner || !isMemoryConfigured()) return "";
  try {
    return `\n\n${formatMemoryBlock(await loadMemories(owner))}`;
  } catch (error) {
    console.error("Donna memory: loading memories failed", error);
    return "";
  }
}
