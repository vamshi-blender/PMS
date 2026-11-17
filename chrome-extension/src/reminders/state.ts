import { z } from "zod";
import { reminderSchema } from "../../../shared/reminders";

// Everything the extension knows about the signed-in user's reminders. The
// service worker may be suspended at any time, so this lives in storage and
// each step reloads it instead of holding it in memory.
const STATE_KEY = "donnaReminders";

const ownerSchema = z.object({
  environment: z.enum(["staging", "production"]),
  userId: z.string(),
  organizationId: z.string(),
});

const stateSchema = z.object({
  owner: ownerSchema.nullable(),
  reminders: z.array(reminderSchema),
  /** Delivered reminders the user has not marked done (they drive the badge). */
  due: z.record(
    z.string(),
    z.object({ title: z.string(), instruction: z.string(), firedAt: z.number() }),
  ),
  /** Delivered reminders the server has not been told about yet. */
  pendingSettles: z.array(z.number().int().positive()),
  /** Check reminders that came due and have not been run by Donna yet. */
  pendingChecks: z
    .record(z.string(), z.object({ title: z.string(), instruction: z.string(), firedAt: z.number() }))
    .default({}),
  /** Check reminder id -> the chat its runs post into (reused on every fire). */
  checkChats: z.record(z.string(), z.string()).default({}),
});

export type ReminderOwner = z.infer<typeof ownerSchema>;
export type ReminderState = z.infer<typeof stateSchema>;

export const EMPTY_REMINDER_STATE: ReminderState = {
  owner: null,
  reminders: [],
  due: {},
  pendingSettles: [],
  pendingChecks: {},
  checkChats: {},
};

export async function loadState(): Promise<ReminderState> {
  const stored = await chrome.storage.local.get(STATE_KEY);
  const parsed = stateSchema.safeParse(stored[STATE_KEY]);
  return parsed.success ? parsed.data : EMPTY_REMINDER_STATE;
}

// The sync (extension page) and the alarm handlers (service worker) both
// change this state. Within one context their read-modify-write steps are
// queued so they cannot overwrite each other.
let queue: Promise<unknown> = Promise.resolve();

export function updateState(change: (state: ReminderState) => ReminderState): Promise<ReminderState> {
  const run = queue.then(async () => {
    const next = change(await loadState());
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

export function sameOwner(a: ReminderOwner | null, b: ReminderOwner): boolean {
  return a !== null && a.environment === b.environment && a.userId === b.userId && a.organizationId === b.organizationId;
}
