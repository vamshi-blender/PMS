import { nextOccurrence } from "../../../shared/reminders";
import { capturePmsScope } from "../api/pmsAuth";
import { applyNotificationBadge } from "../notifications/badge";
import {
  idFromName,
  reminderAlarmName,
  REMINDER_ALARM_PREFIX,
  rescheduleAlarms,
  snoozeAlarmName,
  SNOOZE_ALARM_PREFIX,
} from "./schedule";
import { loadState, updateState, type ReminderState } from "./state";
import { syncReminders } from "./sync";

const CHECK_NOTIFICATION_PREFIX = "donna-reminder-check:";
const SNOOZE_MS = 60 * 60 * 1000;
const SNOOZE_BUTTON = 0;

export const checkNotificationId = (id: number) => `${CHECK_NOTIFICATION_PREFIX}${id}`;

/** True for the toast that says a check is waiting for Donna to be opened. */
export const isCheckNotification = (notificationId: string) =>
  idFromName(notificationId, CHECK_NOTIFICATION_PREFIX) !== null;

export function reminderIdFromNotification(notificationId: string): number | null {
  return idFromName(notificationId, REMINDER_ALARM_PREFIX);
}

const showBadge = (state: ReminderState) => applyNotificationBadge(Object.keys(state.due).length);

async function showToast(id: number, title: string, message: string): Promise<void> {
  await chrome.notifications.create(reminderAlarmName(id), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
    requireInteraction: true,
    buttons: [{ title: "Snooze 1 hour" }, { title: "Mark done" }],
  });
}

/** Re-applies the badge and alarms from storage when the worker starts. No network. */
export async function restoreReminders(): Promise<void> {
  const state = await loadState();
  await showBadge(state);
  await rescheduleAlarms(state);
}

/**
 * Records a delivered reminder as due (it drives the badge and re-shows after
 * a snooze) and shows its toast with the Snooze / Mark done buttons. Used for
 * notify reminders and for check reminders whose check found something.
 */
export async function showDueReminder(id: number, title: string, message: string): Promise<ReminderState> {
  const state = await updateState((current) => ({
    ...current,
    due: { ...current.due, [id]: { title, instruction: message, firedAt: Date.now() } },
  }));
  await showToast(id, title, message);
  await showBadge(state);
  return state;
}

async function showCheckPendingToast(id: number, title: string): Promise<void> {
  await chrome.notifications.create(checkNotificationId(id), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message: "Donna will run this check when you open her.",
    requireInteraction: true,
  });
}

async function fireReminder(id: number): Promise<void> {
  const now = new Date();
  let delivered: { kind: "notify" | "check"; title: string; instruction: string } | null = null;
  let state = await updateState((current) => {
    const reminder = current.reminders.find((r) => r.id === id);
    if (!reminder || reminder.status !== "active") return current;
    delivered = { kind: reminder.kind, title: reminder.title, instruction: reminder.instruction };
    // Move on locally so the next occurrence is scheduled even with no session.
    const next = nextOccurrence(reminder, now);
    return {
      ...current,
      reminders: next === null
        ? current.reminders.filter((r) => r.id !== id)
        : current.reminders.map((r) => (r.id === id ? { ...r, nextFireAt: next } : r)),
      pendingChecks: reminder.kind === "check"
        ? {
            ...current.pendingChecks,
            [id]: { title: reminder.title, instruction: reminder.instruction, firedAt: now.getTime() },
          }
        : current.pendingChecks,
      pendingSettles: current.pendingSettles.includes(id) ? current.pendingSettles : [...current.pendingSettles, id],
    };
  });
  if (!delivered) return;
  const { kind, title, instruction } = delivered as { kind: "notify" | "check"; title: string; instruction: string };

  if (kind === "notify") state = await showDueReminder(id, title, instruction);
  await rescheduleAlarms(state);
  // Tell the server now if a PMS session is available; otherwise the next
  // sync from an extension page does it.
  try {
    await syncReminders(await capturePmsScope());
  } catch (error) {
    console.warn("Reminder settle deferred", error);
  }

  if (kind === "check") {
    // An open Donna page that answers true runs the check itself; otherwise
    // leave a toast, and the check runs the next time Donna opens.
    const answered = await chrome.runtime.sendMessage({ type: "reminder-check-due", id }).catch(() => undefined);
    if (answered !== true) await showCheckPendingToast(id, title);
    return;
  }
  // An open Donna page blinks its window; no listener is fine.
  await chrome.runtime.sendMessage({ type: "reminder-fired", id }).catch(() => {});
}

async function reshowDue(id: number): Promise<void> {
  const entry = (await loadState()).due[id];
  if (entry) await showToast(id, entry.title, entry.instruction);
}

export async function handleReminderAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  const reminderId = idFromName(alarm.name, REMINDER_ALARM_PREFIX);
  if (reminderId !== null) return fireReminder(reminderId);
  const snoozedId = idFromName(alarm.name, SNOOZE_ALARM_PREFIX);
  if (snoozedId !== null) return reshowDue(snoozedId);
}

export async function handleReminderButton(id: number, buttonIndex: number): Promise<void> {
  await chrome.notifications.clear(reminderAlarmName(id));
  if (buttonIndex === SNOOZE_BUTTON) {
    await chrome.alarms.create(snoozeAlarmName(id), { when: Date.now() + SNOOZE_MS });
    return;
  }
  await chrome.alarms.clear(snoozeAlarmName(id));
  const state = await updateState((current) => {
    const due = { ...current.due };
    delete due[id];
    return { ...current, due };
  });
  await showBadge(state);
}
