import { tool } from "@openai/agents";
import type { DonnaRunContext } from "../agents/donna";
import { REMINDER_CHECK_REPORT_TOOL, reminderCheckReportSchema } from "../../shared/reminders";

export const REMINDER_CHECK_INSTRUCTIONS = `Reminder checks:
An automatic reminder check is identified by the input text saying it is an automatic scheduled reminder check, not a message typed by the user. During one, do what the reminder's instruction asks using read-only pms_lookup calls only (resolve "today" and similar from donna_context). Never submit or prepare PMS actions, and do not use memory, reminder or page tools. Then call ${REMINDER_CHECK_REPORT_TOOL} exactly once: alert=true with a short message addressed to the user when they need to act (for example "You haven't logged any work today."), or alert=false with a short note when nothing is needed. Afterwards give a brief answer in the chat; for alert=true, offer to help do it (for example log the worklog) when the user replies.`;

type CheckRunContext = { context?: DonnaRunContext } | undefined;

/** True when this run is an automatic reminder check. */
export function isReminderCheckRun(runContext: CheckRunContext): boolean {
  return Boolean(runContext?.context?.reminderCheck);
}

/** isEnabled predicate: the tool is hidden from the model during a reminder check. */
export const hiddenDuringReminderCheck = ({ runContext }: { runContext: CheckRunContext }) =>
  !isReminderCheckRun(runContext);

export const reportReminderCheck = tool<typeof reminderCheckReportSchema, DonnaRunContext, string>({
  name: REMINDER_CHECK_REPORT_TOOL,
  description:
    "Report the outcome of an automatic reminder check. Call exactly once per check: alert=true with a short message for the user when they need to act, alert=false when nothing is needed. Only available during a reminder check.",
  parameters: reminderCheckReportSchema,
  isEnabled: ({ runContext }) => isReminderCheckRun(runContext),
  async execute() {
    return JSON.stringify({ ok: true });
  },
});
