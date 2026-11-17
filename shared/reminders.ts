import { z } from "zod";

// Donna's reminders (prospective memory): things to do or check at a future
// time. This file is the contract between the backend, which stores them, and
// the extension, which schedules and delivers them. The value lists below
// must match the check constraints in supabase/migrations/*_reminders.sql.

/** "notify" shows fixed text; "check" has Donna look something up first. */
export const REMINDER_KINDS = ["notify", "check"] as const;
/** "weekdays" is Monday to Friday; "weekly" repeats on `weekday`. */
export const REMINDER_RECURRENCES = ["once", "daily", "weekdays", "weekly"] as const;
export const REMINDER_STATUSES = ["active", "paused", "completed", "cancelled"] as const;

export type ReminderKind = (typeof REMINDER_KINDS)[number];
export type ReminderRecurrence = (typeof REMINDER_RECURRENCES)[number];
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const REMINDER_TITLE_LIMIT = 80;
export const REMINDER_INSTRUCTION_LIMIT = 1_000;
/** Most reminders one user may have that are not completed or cancelled. */
export const REMINDER_OPEN_LIMIT = 50;

export const reminderSchema = z
  .object({
    id: z.number().int().positive(),
    kind: z.enum(REMINDER_KINDS),
    /** Short label for the toast and the reminders list. */
    title: z.string().min(1).max(REMINDER_TITLE_LIMIT),
    /** notify: the reminder text. check: what to look up and when to alert. */
    instruction: z.string().min(1).max(REMINDER_INSTRUCTION_LIMIT),
    recurrence: z.enum(REMINDER_RECURRENCES),
    /** India wall-clock time of day every occurrence fires at, "HH:MM". */
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** 0 (Sunday) to 6 (Saturday) for "weekly"; null for other recurrences. */
    weekday: z.number().int().min(0).max(6).nullable(),
    /** ISO instant of the next occurrence. */
    nextFireAt: z.string().min(1),
    status: z.enum(REMINDER_STATUSES),
  })
  .strict();

export type Reminder = z.infer<typeof reminderSchema>;

export const remindersResponseSchema = z.object({ reminders: z.array(reminderSchema) }).strict();

// India has one timezone with no daylight saving, so a fixed offset is exact.
const INDIA_OFFSET_MS = 19_800_000;

/** The instant of an India wall-clock "YYYY-MM-DDTHH:MM", or null if invalid. */
export function indiaLocalToInstant(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(local)) return null;
  const asUtc = Date.parse(`${local}:00Z`);
  if (Number.isNaN(asUtc)) return null;
  // Reject dates like 2026-02-31 that Date.parse rolls over or refuses.
  if (new Date(asUtc).toISOString().slice(0, 16) !== local) return null;
  return new Date(asUtc - INDIA_OFFSET_MS).toISOString();
}

/** Inverse of indiaLocalToInstant: "YYYY-MM-DDTHH:MM" in India. */
export function instantToIndiaLocal(instant: string | Date): string {
  return new Date(new Date(instant).getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 16);
}

/** Day of the week in India for an instant: 0 (Sunday) to 6 (Saturday). */
export function indiaWeekday(instant: string | Date): number {
  return new Date(new Date(instant).getTime() + INDIA_OFFSET_MS).getUTCDay();
}

/**
 * The first occurrence strictly after `after`, computed from the schedule's
 * India anchor (time of day, and weekday for "weekly"). null for "once".
 */
export function nextOccurrence(
  schedule: Pick<Reminder, "recurrence" | "localTime" | "weekday">,
  after: Date,
): string | null {
  if (schedule.recurrence === "once") return null;
  let day = Date.parse(`${instantToIndiaLocal(after).slice(0, 10)}T00:00:00Z`);
  // Today plus the next seven days always contains the next occurrence.
  for (let offset = 0; offset < 8; offset++, day += 86_400_000) {
    const instant = indiaLocalToInstant(`${new Date(day).toISOString().slice(0, 10)}T${schedule.localTime}`);
    if (!instant || Date.parse(instant) <= after.getTime()) continue;
    const weekday = new Date(day).getUTCDay();
    if (schedule.recurrence === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (schedule.recurrence === "weekly" && weekday !== schedule.weekday) continue;
    return instant;
  }
  return null;
}

/**
 * Body of POST /api/reminders/settle (besides `scope`): reminders the
 * extension has delivered. A due one-off becomes "completed"; a due recurring
 * one moves to its next occurrence. Reminders that are not due are left
 * alone, so repeating a settle is harmless. The response is the same
 * `{ reminders }` list as POST /api/reminders.
 */
export const REMINDER_SETTLE_LIMIT = 50;
export const reminderSettleIdsSchema = z.array(z.number().int().positive()).min(1).max(REMINDER_SETTLE_LIMIT);

// --- Reminder checks (kind "check") ----------------------------------------
// When a check comes due, an open Donna page sends POST /api/chat with
// `reminderCheckId`. The server builds the run's input from the stored
// reminder, allows only read-only tools, and Donna ends the run by calling
// REMINDER_CHECK_REPORT_TOOL exactly once. The extension reads that call's
// arguments from the stream's tool.started event to decide whether to alert.

export const REMINDER_CHECK_REPORT_TOOL = "report_reminder_check";

export const reminderCheckReportSchema = z
  .object({
    /** true when the user needs to act, so the extension shows a toast. */
    alert: z.boolean(),
    /** Toast text: one or two short sentences addressed to the user. */
    message: z.string().min(1).max(300),
  })
  .strict();

export type ReminderCheckReport = z.infer<typeof reminderCheckReportSchema>;
