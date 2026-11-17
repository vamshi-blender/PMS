import { tool } from "@openai/agents";
import { z } from "zod";
import type { DonnaRunContext } from "../agents/donna";
import {
  REMINDER_INSTRUCTION_LIMIT,
  REMINDER_KINDS,
  REMINDER_RECURRENCES,
  REMINDER_TITLE_LIMIT,
  indiaLocalToInstant,
  indiaWeekday,
  instantToIndiaLocal,
  type ReminderRecurrence,
} from "../../shared/reminders";
import { formatIndiaTime } from "./prompt";
import { hiddenDuringReminderCheck } from "./check";
import {
  addReminder,
  cancelReminder,
  getReminder,
  isRemindersConfigured,
  updateReminder,
  type ReminderPatch,
} from "./store";

export const REMINDER_INSTRUCTIONS = `Reminders:
The <donna_reminders> block at the end of these instructions lists this user's open reminders. It is rebuilt for every reply, so it is always current; answer "what reminders do I have" from it. Each line starts with its ID in square brackets.
Use manage_reminders to add, update or cancel them:
- kind "notify" is a plain nudge showing the text. Use kind "check" when you must look something up in PMS at that time and alert only if needed; the instruction then says what to check and when to alert.
- Resolve relative dates ("tomorrow", "next Monday") to an India date and time using the hidden donna_context timestamp. When the user gives no time, pick a sensible one (10:00 for a to-do nudge, 18:00 for an end-of-day check) and say which time you set.
- To change an existing reminder (time, text, pause, resume), update its ID instead of adding a duplicate. To drop one, cancel its ID.
- Reminders only fire while Chrome is running. Never say a reminder was set, changed or cancelled unless manage_reminders returned ok; state the nextFire time it returned.`;

export const manageReminderParameters = z
  .object({
    action: z.enum(["add", "update", "cancel"]),
    id: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("ID of the existing reminder, from the <donna_reminders> block. Required for update and cancel; null for add."),
    kind: z
      .enum(REMINDER_KINDS)
      .nullable()
      .describe('"notify" shows the instruction as a nudge; "check" has Donna look something up in PMS first. Required for add; null on update leaves it unchanged.'),
    title: z
      .string()
      .nullable()
      .describe(`Short label (max ${REMINDER_TITLE_LIMIT} characters). Required for add; null on update leaves it unchanged.`),
    instruction: z
      .string()
      .nullable()
      .describe(
        `notify: the reminder text. check: what to look up in PMS and when to alert (max ${REMINDER_INSTRUCTION_LIMIT} characters). Required for add; null on update leaves it unchanged.`,
      ),
    recurrence: z
      .enum(REMINDER_RECURRENCES)
      .nullable()
      .describe('"once", "daily", "weekdays" (Monday to Friday) or "weekly" (same weekday as fireAt). Required for add; null on update leaves it unchanged.'),
    fireAt: z
      .string()
      .nullable()
      .describe(
        'India wall-clock time "YYYY-MM-DDTHH:MM" of the next occurrence (for add, the first). Must be in the future. Required for add; null on update leaves the schedule unchanged.',
      ),
    paused: z
      .boolean()
      .nullable()
      .describe("Update only: true pauses the reminder, false resumes it, null leaves it unchanged."),
  })
  .strict();

export type ManageReminderInput = z.infer<typeof manageReminderParameters>;

function reply(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

const fail = (error: string) => reply({ ok: false, error });

function clean(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, " ").trim();
}

/** Parses fireAt, requiring a valid time in the future. */
function futureInstant(fireAt: string): { instant: string } | { error: string } {
  const instant = indiaLocalToInstant(fireAt.trim());
  if (!instant) return { error: 'fireAt must be a valid India time in the form "YYYY-MM-DDTHH:MM".' };
  if (Date.parse(instant) <= Date.now()) return { error: "fireAt must be in the future." };
  return { instant };
}

function weekdaysError(recurrence: ReminderRecurrence, instant: string): string | null {
  const day = indiaWeekday(instant);
  if (recurrence === "weekdays" && (day === 0 || day === 6)) {
    return 'A "weekdays" reminder runs Monday to Friday, so fireAt cannot fall on a Saturday or Sunday.';
  }
  return null;
}

/** Runs one manage_reminders call for the user the run context is bound to. */
export async function runReminderAction(
  context: DonnaRunContext | undefined,
  input: ManageReminderInput,
): Promise<string> {
  const scope = context?.scope;
  if (!scope || !isRemindersConfigured()) return fail("Reminders are not available in this chat.");
  // Identity comes from the PMS-verified scope, never from the model.
  const owner = { environment: scope.environment, userId: scope.userId };

  if (input.action !== "add" && input.id === null) return fail("id is required for update and cancel.");

  if (input.action === "cancel") {
    const result = await cancelReminder(owner, input.id as number);
    return reply(result.ok ? { ok: true, id: result.id, cancelled: true } : result);
  }

  const title = clean(input.title);
  const instruction = clean(input.instruction);
  if (title !== null && (!title || title.length > REMINDER_TITLE_LIMIT)) {
    return fail(`title must be 1 to ${REMINDER_TITLE_LIMIT} characters.`);
  }
  if (instruction !== null && (!instruction || instruction.length > REMINDER_INSTRUCTION_LIMIT)) {
    return fail(`instruction must be 1 to ${REMINDER_INSTRUCTION_LIMIT} characters.`);
  }

  if (input.action === "add") {
    const { kind, recurrence, fireAt } = input;
    if (kind === null || title === null || instruction === null || recurrence === null || fireAt === null) {
      return fail("kind, title, instruction, recurrence and fireAt are all required for add.");
    }
    const parsed = futureInstant(fireAt);
    if ("error" in parsed) return fail(parsed.error);
    const bad = weekdaysError(recurrence, parsed.instant);
    if (bad) return fail(bad);
    const result = await addReminder(owner, {
      kind,
      title,
      instruction,
      recurrence,
      localTime: instantToIndiaLocal(parsed.instant).slice(11),
      weekday: recurrence === "weekly" ? indiaWeekday(parsed.instant) : null,
      nextFireAt: parsed.instant,
      conversationId: context?.conversationId,
    });
    return reply(result.ok ? { ok: true, id: result.id, nextFire: formatIndiaTime(parsed.instant) } : result);
  }

  // update
  const id = input.id as number;
  let existing;
  try {
    existing = await getReminder(owner, id);
  } catch (error) {
    console.error("Donna reminders: reading a reminder failed", error);
    return fail("Reminders are not available right now.");
  }
  if (!existing) return fail(`No reminder with ID ${id} exists for this user.`);

  const recurrence = input.recurrence ?? existing.recurrence;
  const patch: ReminderPatch = {};
  if (input.kind !== null) patch.kind = input.kind;
  if (title !== null) patch.title = title;
  if (instruction !== null) patch.instruction = instruction;
  if (input.paused !== null) patch.status = input.paused ? "paused" : "active";

  let nextFireAt = existing.nextFireAt;
  const recurrenceChanged = input.recurrence !== null && input.recurrence !== existing.recurrence;
  if (input.fireAt !== null) {
    const parsed = futureInstant(input.fireAt);
    if ("error" in parsed) return fail(parsed.error);
    nextFireAt = parsed.instant;
    patch.nextFireAt = nextFireAt;
    patch.localTime = instantToIndiaLocal(nextFireAt).slice(11);
  }
  if (recurrenceChanged) patch.recurrence = recurrence;
  if (recurrenceChanged || input.fireAt !== null) {
    const bad = weekdaysError(recurrence, nextFireAt);
    if (bad) return fail(bad);
    // The table requires weekday to be set exactly when recurrence is weekly.
    if (recurrenceChanged || recurrence === "weekly") {
      patch.weekday = recurrence === "weekly" ? indiaWeekday(nextFireAt) : null;
    }
  }

  if (!Object.keys(patch).length) return fail("Nothing to change: supply at least one field to update.");
  const result = await updateReminder(owner, id, patch);
  return reply(result.ok ? { ok: true, id: result.id, nextFire: formatIndiaTime(nextFireAt) } : result);
}

export const manageReminders = tool<typeof manageReminderParameters, DonnaRunContext, string>({
  name: "manage_reminders",
  description:
    "Add, update (reschedule, edit, pause or resume) or cancel one of this user's reminders. Changes take effect immediately and only affect this user. Returns the next fire time in India.",
  parameters: manageReminderParameters,
  isEnabled: hiddenDuringReminderCheck,
  async execute(input, runContext) {
    return runReminderAction(runContext?.context, input);
  },
});
