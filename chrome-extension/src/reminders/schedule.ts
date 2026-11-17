import type { ReminderState } from "./state";

export const REMINDER_ALARM_PREFIX = "donna-reminder:";
export const SNOOZE_ALARM_PREFIX = "donna-reminder-snooze:";

export const reminderAlarmName = (id: number) => `${REMINDER_ALARM_PREFIX}${id}`;
export const snoozeAlarmName = (id: number) => `${SNOOZE_ALARM_PREFIX}${id}`;

export function idFromName(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const id = Number(name.slice(prefix.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Sync and alarm handlers can both reschedule; queue them so one's clears
// never land between the other's creates.
let queue: Promise<unknown> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function clearAlarms(prefixes: string[]): Promise<void> {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((alarm) => prefixes.some((prefix) => alarm.name.startsWith(prefix)))
      .map((alarm) => chrome.alarms.clear(alarm.name)),
  );
}

/** Drops every reminder alarm, snoozes included (used when the user changes). */
export function clearAllReminderAlarms(): Promise<void> {
  return enqueue(() => clearAlarms([REMINDER_ALARM_PREFIX, SNOOZE_ALARM_PREFIX]));
}

/** Makes the alarms match the stored reminders. Snooze alarms are left alone. */
export function rescheduleAlarms(state: ReminderState): Promise<void> {
  return enqueue(async () => {
    await clearAlarms([REMINDER_ALARM_PREFIX]);
    const now = Date.now();
    for (const reminder of state.reminders) {
      if (reminder.status !== "active") continue;
      const fireAt = Date.parse(reminder.nextFireAt);
      if (Number.isNaN(fireAt)) continue;
      // An occurrence that was already delivered stays quiet until the server
      // (or a local advance) moves the reminder on to its next one.
      // A check's delivered occurrence is its pendingChecks entry.
      const due = reminder.kind === "check" ? state.pendingChecks[reminder.id] : state.due[reminder.id];
      if ((due || state.pendingSettles.includes(reminder.id)) && fireAt <= (due?.firedAt ?? now)) continue;
      await chrome.alarms.create(reminderAlarmName(reminder.id), { when: Math.max(fireAt, now + 1000) });
    }
  });
}
