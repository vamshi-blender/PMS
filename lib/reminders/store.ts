import type { PmsEnvironment } from "../../shared/pms-scope";
import {
  REMINDER_OPEN_LIMIT,
  nextOccurrence,
  type Reminder,
  type ReminderKind,
  type ReminderRecurrence,
  type ReminderStatus,
} from "../../shared/reminders";
import { isMemoryConfigured, supabase } from "../memory/store";

// Donna's reminders in Supabase (see supabase/migrations/*_reminders.sql).
// The service role key bypasses row level security, so every query here must
// filter by environment and user_id itself.

export interface ReminderOwner {
  environment: PmsEnvironment;
  userId: string;
}

export type ReminderWriteResult =
  | { ok: true; id: number }
  | { ok: false; error: string };

export interface NewReminder {
  kind: ReminderKind;
  title: string;
  instruction: string;
  recurrence: ReminderRecurrence;
  localTime: string;
  weekday: number | null;
  /** ISO instant of the first occurrence. */
  nextFireAt: string;
  conversationId?: string;
}

/** Columns to change on an open reminder; only the keys present are written. */
export interface ReminderPatch {
  kind?: ReminderKind;
  title?: string;
  instruction?: string;
  recurrence?: ReminderRecurrence;
  localTime?: string;
  weekday?: number | null;
  nextFireAt?: string;
  status?: Extract<ReminderStatus, "active" | "paused">;
}

const OPEN_STATUSES = ["active", "paused"];
const COLUMNS = "id, kind, title, instruction, recurrence, local_time, weekday, next_fire_at, status";
const UNAVAILABLE = "Reminders are not available right now.";

export function isRemindersConfigured(): boolean {
  return isMemoryConfigured();
}

function failure(action: string, error: unknown): ReminderWriteResult {
  console.error(`Donna reminders: ${action} failed`, error);
  return { ok: false, error: UNAVAILABLE };
}

function notFound(id: number): ReminderWriteResult {
  return { ok: false, error: `No reminder with ID ${id} exists for this user.` };
}

function toReminder(row: Record<string, unknown>): Reminder {
  return {
    id: row.id as number,
    kind: row.kind as ReminderKind,
    title: row.title as string,
    instruction: row.instruction as string,
    recurrence: row.recurrence as ReminderRecurrence,
    localTime: row.local_time as string,
    weekday: (row.weekday as number | null) ?? null,
    nextFireAt: new Date(row.next_fire_at as string).toISOString(),
    status: row.status as ReminderStatus,
  };
}

/** The owner's open (active or paused) reminders, soonest first. Throws on a database error. */
export async function listReminders(owner: ReminderOwner): Promise<Reminder[]> {
  const { data, error } = await supabase()
    .from("reminders")
    .select(COLUMNS)
    .eq("environment", owner.environment)
    .eq("user_id", owner.userId)
    .in("status", OPEN_STATUSES)
    .order("next_fire_at")
    .limit(REMINDER_OPEN_LIMIT);
  if (error) throw error;
  return (data as Record<string, unknown>[]).map(toReminder);
}

/** One open reminder of the owner, or null. Throws on a database error. */
export async function getReminder(owner: ReminderOwner, id: number): Promise<Reminder | null> {
  const { data, error } = await supabase()
    .from("reminders")
    .select(COLUMNS)
    .eq("id", id)
    .eq("environment", owner.environment)
    .eq("user_id", owner.userId)
    .in("status", OPEN_STATUSES);
  if (error) throw error;
  const rows = data as Record<string, unknown>[];
  return rows.length ? toReminder(rows[0]) : null;
}

/** One reminder of the owner in any status (a one-off check may already be completed), or null. Throws on a database error. */
export async function getOwnedReminder(owner: ReminderOwner, id: number): Promise<Reminder | null> {
  const { data, error } = await supabase()
    .from("reminders")
    .select(COLUMNS)
    .eq("id", id)
    .eq("environment", owner.environment)
    .eq("user_id", owner.userId);
  if (error) throw error;
  const rows = data as Record<string, unknown>[];
  return rows.length ? toReminder(rows[0]) : null;
}

export async function addReminder(owner: ReminderOwner, input: NewReminder): Promise<ReminderWriteResult> {
  try {
    const client = supabase();
    const open = await client
      .from("reminders")
      .select("id")
      .eq("environment", owner.environment)
      .eq("user_id", owner.userId)
      .in("status", OPEN_STATUSES)
      .limit(REMINDER_OPEN_LIMIT);
    if (open.error) return failure("counting open reminders", open.error);
    if (open.data.length >= REMINDER_OPEN_LIMIT) {
      return {
        ok: false,
        error: `You already have ${REMINDER_OPEN_LIMIT} open reminders, the most allowed. Cancel one first.`,
      };
    }
    const { data, error } = await client
      .from("reminders")
      .insert({
        environment: owner.environment,
        user_id: owner.userId,
        kind: input.kind,
        title: input.title,
        instruction: input.instruction,
        recurrence: input.recurrence,
        local_time: input.localTime,
        weekday: input.weekday,
        next_fire_at: input.nextFireAt,
        source_conversation_id: input.conversationId ?? null,
      })
      .select("id")
      .single();
    if (error) return failure("adding a reminder", error);
    return { ok: true, id: data.id as number };
  } catch (error) {
    return failure("adding a reminder", error);
  }
}

const COLUMN_OF: Record<keyof ReminderPatch, string> = {
  kind: "kind",
  title: "title",
  instruction: "instruction",
  recurrence: "recurrence",
  localTime: "local_time",
  weekday: "weekday",
  nextFireAt: "next_fire_at",
  status: "status",
};

/** Changes only the patched columns of one of the owner's open reminders. */
export async function updateReminder(
  owner: ReminderOwner,
  id: number,
  patch: ReminderPatch,
): Promise<ReminderWriteResult> {
  try {
    const columns: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as (keyof ReminderPatch)[]) {
      if (patch[key] !== undefined) columns[COLUMN_OF[key]] = patch[key];
    }
    const { data, error } = await supabase()
      .from("reminders")
      .update(columns)
      .eq("id", id)
      .eq("environment", owner.environment)
      .eq("user_id", owner.userId)
      .in("status", OPEN_STATUSES)
      .select("id");
    if (error) return failure("updating a reminder", error);
    if (!data.length) return notFound(id);
    return { ok: true, id };
  } catch (error) {
    return failure("updating a reminder", error);
  }
}

/** Marks one open reminder cancelled; the row is kept. */
export async function cancelReminder(owner: ReminderOwner, id: number): Promise<ReminderWriteResult> {
  try {
    const { data, error } = await supabase()
      .from("reminders")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("environment", owner.environment)
      .eq("user_id", owner.userId)
      .in("status", OPEN_STATUSES)
      .select("id");
    if (error) return failure("cancelling a reminder", error);
    if (!data.length) return notFound(id);
    return { ok: true, id };
  } catch (error) {
    return failure("cancelling a reminder", error);
  }
}

/**
 * Records that the extension delivered reminders. Each due, active reminder of
 * the owner either completes (one-off) or moves to its next occurrence. Others
 * (not due, paused, not owned, unknown) are left alone, so repeating is
 * harmless. Each write is conditional on the fire time that was read, so two
 * concurrent settles of one occurrence cannot advance it twice. Throws on a
 * database error.
 */
export async function settleReminders(owner: ReminderOwner, ids: number[], now = new Date()): Promise<void> {
  const client = supabase();
  const { data, error } = await client
    .from("reminders")
    .select(COLUMNS)
    .in("id", [...new Set(ids)])
    .eq("environment", owner.environment)
    .eq("user_id", owner.userId)
    .eq("status", "active");
  if (error) throw error;
  for (const row of data as Record<string, unknown>[]) {
    const fireAt = row.next_fire_at as string;
    if (Date.parse(fireAt) > now.getTime()) continue;
    const reminder = toReminder(row);
    const next = nextOccurrence(reminder, now);
    const change = reminder.recurrence === "once" ? { status: "completed" } : next ? { next_fire_at: next } : null;
    if (!change) continue;
    const result = await client
      .from("reminders")
      .update(change)
      .eq("id", reminder.id)
      .eq("environment", owner.environment)
      .eq("user_id", owner.userId)
      .eq("status", "active")
      .eq("next_fire_at", fireAt);
    if (result.error) throw result.error;
  }
}
