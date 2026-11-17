import {
  REMINDER_CHECK_REPORT_TOOL,
  reminderCheckReportSchema,
  type ReminderCheckReport,
} from "../../../shared/reminders";
import type { PmsScope } from "../../../shared/pms-scope";
import type { ChatStreamEvent } from "../api/protocol";
import { checkNotificationId, showDueReminder } from "./deliver";
import { loadState, sameOwner, updateState, type ReminderState } from "./state";

// The page side of "check" reminders. The service worker records a due check
// in storage; an open Donna page runs it as a short chat turn and, when Donna
// says the user needs to act, raises the usual reminder toast.

export interface PendingCheck {
  id: number;
  title: string;
  instruction: string;
  firedAt: number;
}

const FALLBACK_ALERT = "Donna finished your scheduled check.";
const ALERT_TEXT_LIMIT = 300;

/** The oldest pending check, or null while Donna is busy or waiting on an approval. */
export function pickNextCheck(state: ReminderState, busy: boolean, anyApproval: boolean): PendingCheck | null {
  if (busy || anyApproval) return null;
  const [oldest] = Object.entries(state.pendingChecks)
    .map(([id, entry]) => ({ id: Number(id), ...entry }))
    .filter((entry) => Number.isInteger(entry.id) && entry.id > 0)
    .sort((a, b) => a.firedAt - b.firedAt || a.id - b.id);
  return oldest ?? null;
}

/** Reads Donna's report from a stream event; null for any other event or a malformed report. */
export function parseCheckReport(event: ChatStreamEvent): ReminderCheckReport | null {
  if (event.type !== "tool.started" || event.name !== REMINDER_CHECK_REPORT_TOOL) return null;
  const parsed = reminderCheckReportSchema.safeParse(event.arguments);
  return parsed.success ? parsed.data : null;
}

/** What to do after a successful run. No valid report means alert, so nothing is missed silently. */
export function checkOutcome(report: ReminderCheckReport | null, finalText: string): ReminderCheckReport {
  if (report) return report;
  const text = finalText.replace(/\s+/g, " ").trim();
  return { alert: true, message: text ? text.slice(0, ALERT_TEXT_LIMIT) : FALLBACK_ALERT };
}

/** The next check to run, with the chat it posted into last time (if any). */
export async function nextPendingCheck(
  scope: PmsScope,
  busy: boolean,
  anyApproval: boolean,
  skip: ReadonlySet<number> = new Set(),
): Promise<(PendingCheck & { chatId?: string }) | null> {
  const state = await loadState();
  // Pending checks of a previous user are dropped by the next sync; ignore them until then.
  if (!sameOwner(state.owner, scope)) return null;
  const pendingChecks = Object.fromEntries(Object.entries(state.pendingChecks).filter(([id]) => !skip.has(Number(id))));
  const next = pickNextCheck({ ...state, pendingChecks }, busy, anyApproval);
  return next ? { ...next, chatId: state.checkChats[next.id] } : null;
}

export async function rememberCheckChat(id: number, chatId: string): Promise<void> {
  await updateState((current) => ({ ...current, checkChats: { ...current.checkChats, [id]: chatId } }));
}

/** Settles a successful run: shows the reminder toast if needed, then forgets the pending check. */
export async function finishCheck(id: number, title: string, outcome: ReminderCheckReport): Promise<void> {
  if (outcome.alert) {
    try {
      await showDueReminder(id, title, outcome.message);
    } catch (error) {
      console.warn("Reminder check: could not show the alert", error);
    }
  }
  await updateState((current) => {
    const pendingChecks = { ...current.pendingChecks };
    delete pendingChecks[id];
    return { ...current, pendingChecks };
  });
  await chrome.notifications.clear(checkNotificationId(id)).catch(() => {});
}

/**
 * Answers the worker's "reminder-check-due" message. `canRun` says whether
 * this page can take the check now (mounted with a PMS scope and loaded
 * chats); only then does it reply true, so the worker knows not to show its
 * fallback toast. Returns a function that stops listening.
 */
export function listenForDueChecks(canRun: () => boolean, onDue: () => void): () => void {
  const handleMessage = (
    message: unknown,
    _sender: unknown,
    sendResponse: (response: boolean) => void,
  ) => {
    if ((message as { type?: unknown } | null)?.type !== "reminder-check-due") return;
    if (!canRun()) return;
    sendResponse(true);
    onDue();
  };
  chrome.runtime.onMessage.addListener(handleMessage);
  return () => chrome.runtime.onMessage.removeListener(handleMessage);
}
