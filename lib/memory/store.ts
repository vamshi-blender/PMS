import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PmsEnvironment } from "../../shared/pms-scope";

// Donna's long-term memory in Supabase (see supabase/migrations). Two tables:
//  - user_memories: private to one PMS user in one environment.
//  - organization_memories: rules for everyone; only 'approved' rows are in
//    force. The tool can only propose rows as 'pending' for an admin to review.
// The service role key bypasses row level security, so every query here must
// filter by environment (and by user for user memories) itself.

export const MEMORY_CONTENT_LIMIT = 1_000;
// Everything loaded is injected into the prompt, so keep the lists bounded.
const MEMORY_ROW_LIMIT = 100;

export interface MemoryOwner {
  environment: PmsEnvironment;
  userId: string;
}

export interface MemoryItem {
  id: number;
  content: string;
  /** ISO instant after which the memory is no longer shown; null = never. */
  expiresAt: string | null;
}

export interface LoadedMemories {
  organization: MemoryItem[];
  user: MemoryItem[];
}

export type MemoryWriteResult =
  | { ok: true; id: number }
  | { ok: false; error: string };

declare global {
  var __donnaSupabase: SupabaseClient | undefined;
}

export function isMemoryConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const RETRY_DELAYS_MS = [250, 750];
// Failures where the connection was never established, so the request cannot
// have reached Supabase and repeating it cannot apply a write twice.
const NEVER_CONNECTED_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
]);

function neverConnected(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  if (!cause) return false;
  return NEVER_CONNECTED_CODES.has(cause.code ?? "") ||
    (cause.code === "ECONNRESET" && /before secure TLS connection was established/.test(cause.message ?? ""));
}

/**
 * fetch with short retries for dropped connections. Reads retry on any
 * network error; writes only when the request provably never left.
 */
export const retryingFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (error) {
      const retryable = error instanceof TypeError && !init?.signal?.aborted &&
        (method === "GET" || method === "HEAD" || neverConnected(error));
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
};

function supabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  globalThis.__donnaSupabase ??= createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: retryingFetch },
  });
  return globalThis.__donnaSupabase;
}

const UNAVAILABLE = "Memory is not available right now.";

function failure(action: string, error: unknown): MemoryWriteResult {
  console.error(`Donna memory: ${action} failed`, error);
  return { ok: false, error: UNAVAILABLE };
}

/** Approved organization rules and the user's unexpired memories. */
export async function loadMemories(owner: MemoryOwner, now = new Date()): Promise<LoadedMemories> {
  const client = supabase();
  const [organization, user] = await Promise.all([
    client
      .from("organization_memories")
      .select("id, content")
      .eq("environment", owner.environment)
      .eq("status", "approved")
      .order("id")
      .limit(MEMORY_ROW_LIMIT),
    client
      .from("user_memories")
      .select("id, content, expires_at")
      .eq("environment", owner.environment)
      .eq("user_id", owner.userId)
      .order("id")
      .limit(MEMORY_ROW_LIMIT),
  ]);
  if (organization.error) throw organization.error;
  if (user.error) throw user.error;

  return {
    organization: organization.data.map((row) => ({
      id: row.id as number,
      content: row.content as string,
      expiresAt: null,
    })),
    user: user.data
      .map((row) => ({
        id: row.id as number,
        content: row.content as string,
        expiresAt: (row.expires_at as string | null) ?? null,
      }))
      .filter((item) => !item.expiresAt || new Date(item.expiresAt) > now),
  };
}

export async function addUserMemory(
  owner: MemoryOwner,
  input: { content: string; expiresAt: string | null; conversationId?: string },
): Promise<MemoryWriteResult> {
  try {
    const { data, error } = await supabase()
      .from("user_memories")
      .insert({
        environment: owner.environment,
        user_id: owner.userId,
        content: input.content,
        expires_at: input.expiresAt,
        source_conversation_id: input.conversationId ?? null,
      })
      .select("id")
      .single();
    if (error) return failure("adding a user memory", error);
    return { ok: true, id: data.id as number };
  } catch (error) {
    return failure("adding a user memory", error);
  }
}

/** Replaces the content and expiry of one of the owner's own memories. */
export async function updateUserMemory(
  owner: MemoryOwner,
  id: number,
  input: { content: string; expiresAt: string | null },
): Promise<MemoryWriteResult> {
  try {
    const { data, error } = await supabase()
      .from("user_memories")
      .update({ content: input.content, expires_at: input.expiresAt })
      .eq("id", id)
      .eq("environment", owner.environment)
      .eq("user_id", owner.userId)
      .select("id");
    if (error) return failure("updating a user memory", error);
    if (!data.length) return { ok: false, error: `No memory with ID ${id} exists for this user.` };
    return { ok: true, id };
  } catch (error) {
    return failure("updating a user memory", error);
  }
}

export async function deleteUserMemory(owner: MemoryOwner, id: number): Promise<MemoryWriteResult> {
  try {
    const { data, error } = await supabase()
      .from("user_memories")
      .delete()
      .eq("id", id)
      .eq("environment", owner.environment)
      .eq("user_id", owner.userId)
      .select("id");
    if (error) return failure("deleting a user memory", error);
    if (!data.length) return { ok: false, error: `No memory with ID ${id} exists for this user.` };
    return { ok: true, id };
  } catch (error) {
    return failure("deleting a user memory", error);
  }
}

/**
 * Records a proposed organization rule as 'pending'. With replacesId it is a
 * proposed edit: the existing approved rule is left untouched and stays in
 * force until an admin approves the new row.
 */
export async function proposeOrganizationMemory(
  owner: MemoryOwner,
  input: { content: string; replacesId: number | null; conversationId?: string },
): Promise<MemoryWriteResult> {
  try {
    const client = supabase();
    if (input.replacesId !== null) {
      const { data, error } = await client
        .from("organization_memories")
        .select("id")
        .eq("id", input.replacesId)
        .eq("environment", owner.environment)
        .eq("status", "approved");
      if (error) return failure("checking an organization rule", error);
      if (!data.length) {
        return { ok: false, error: `No approved organization rule with ID ${input.replacesId} exists.` };
      }
    }
    const { data, error } = await client
      .from("organization_memories")
      .insert({
        environment: owner.environment,
        content: input.content,
        status: "pending",
        replaces_id: input.replacesId,
        proposed_by_user_id: owner.userId,
        source_conversation_id: input.conversationId ?? null,
      })
      .select("id")
      .single();
    if (error) return failure("proposing an organization rule", error);
    return { ok: true, id: data.id as number };
  } catch (error) {
    return failure("proposing an organization rule", error);
  }
}
