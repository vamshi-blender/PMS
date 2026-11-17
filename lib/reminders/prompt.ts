import { instantToIndiaLocal, indiaWeekday, type Reminder } from "../../shared/reminders";
import { isRemindersConfigured, listReminders, type ReminderOwner } from "./store";

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "YYYY-MM-DD HH:MM" in India for an instant. */
export function formatIndiaTime(instant: string | Date): string {
  return instantToIndiaLocal(instant).replace("T", " ");
}

function line(reminder: Reminder, now: Date): string {
  const text = (value: string) => value.replace(/\s+/g, " ").trim();
  let head = `[${reminder.id}] ${reminder.kind}, ${reminder.recurrence}, next ${formatIndiaTime(reminder.nextFireAt)} (India)`;
  if (reminder.recurrence === "weekly") {
    head += ` weekly on ${WEEKDAY_NAMES[reminder.weekday ?? indiaWeekday(reminder.nextFireAt)]}`;
  }
  if (reminder.status === "paused") head += " (paused)";
  if (new Date(reminder.nextFireAt) < now) head += " (overdue)";
  return `${head}: ${text(reminder.title)} — ${text(reminder.instruction)}`;
}

export function formatReminderBlock(reminders: Reminder[], now: Date): string {
  const body = reminders.length ? reminders.map((reminder) => line(reminder, now)).join("\n") : "(none)";
  return `<donna_reminders>\nThis user's open reminders:\n${body}\n</donna_reminders>`;
}

/**
 * The reminders section appended to Donna's instructions on every model call.
 * Reminder problems never block a chat: the section is simply left out.
 */
export async function reminderInstructions(owner: ReminderOwner | undefined): Promise<string> {
  if (!owner || !isRemindersConfigured()) return "";
  try {
    return `\n\n${formatReminderBlock(await listReminders(owner), new Date())}`;
  } catch (error) {
    console.error("Donna reminders: loading reminders failed", error);
    return "";
  }
}
