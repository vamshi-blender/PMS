import { remindersResponseSchema, REMINDER_SETTLE_LIMIT } from "../../../shared/reminders";
import type { PmsScope } from "../../../shared/pms-scope";
import { getBackendUrl } from "../api/backend";
import { backendAuthHeaders } from "../api/backendAuth";
import { assertPmsScope } from "../api/pmsAuth";
import { applyNotificationBadge } from "../notifications/badge";
import { clearAllReminderAlarms, rescheduleAlarms } from "./schedule";
import { EMPTY_REMINDER_STATE, loadState, sameOwner, updateState, type ReminderOwner } from "./state";

async function post(path: string, scope: PmsScope, extra: Record<string, unknown>) {
  const token = await assertPmsScope(scope);
  const response = await fetch(`${await getBackendUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...backendAuthHeaders(token, scope.environment) },
    body: JSON.stringify({ scope, ...extra }),
  });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
  return remindersResponseSchema.parse(await response.json()).reminders;
}

/**
 * Brings the stored reminders and their alarms in line with the server. Needs
 * the PMS scope, so it runs from an extension page (or the worker, right after
 * a reminder fires). Delivered reminders are reported first, because the
 * settle response is already the fresh list. Never throws.
 */
export async function syncReminders(scope: PmsScope): Promise<void> {
  try {
    const owner: ReminderOwner = {
      environment: scope.environment,
      userId: scope.userId,
      organizationId: scope.organizationId,
    };
    let state = await loadState();
    if (!sameOwner(state.owner, owner)) {
      await clearAllReminderAlarms();
      state = await updateState(() => ({ ...EMPTY_REMINDER_STATE, owner }));
      await applyNotificationBadge(0);
    }

    const settling = state.pendingSettles.slice(0, REMINDER_SETTLE_LIMIT);
    const fresh = settling.length > 0
      ? await post("/api/reminders/settle", scope, { ids: settling })
      : await post("/api/reminders", scope, {});

    const saved = await updateState((current) => {
      if (!sameOwner(current.owner, owner)) return current;
      const pendingSettles = current.pendingSettles.filter((id) => !settling.includes(id));
      // Reminders that fired while the request was in flight are newer here
      // than on the server, so the local copy wins for them.
      const reminders = fresh.flatMap((reminder) =>
        pendingSettles.includes(reminder.id)
          ? current.reminders.filter((local) => local.id === reminder.id)
          : [reminder],
      );
      return { ...current, reminders, pendingSettles };
    });
    await rescheduleAlarms(saved);
  } catch (error) {
    console.warn("Reminder sync failed", error);
  }
}
