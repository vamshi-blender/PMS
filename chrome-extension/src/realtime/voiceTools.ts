import { tool } from "@openai/agents/realtime";
import { z } from "zod";
import { executeClientTool } from "../api/clientTools";
import type { PmsScope } from "../../../shared/pms-scope";

// Hardcoded to match the manifest bundle (same convention as the lookup
// names below): an enum stops the model from guessing near-miss names.
const FILTERABLE_FIELDS = [
  "Application Status",
  "Leave Type",
  "Application Id",
  "Reason",
  "Application date",
  "Leave Start Date",
  "Leave End Date",
] as const;

const LOOKUP_COLUMNS = [
  // getLeaveApplicationStatus report columns
  "Application Id",
  "Application date",
  "Application Status",
  "Leave Type",
  "Leave Start Date",
  "Leave End Date",
  "Number of Days",
  "Date Range",
  "Reason",
  "Employee Name",
  "Employee Code",
  "Manager Name",
  "Manager Email Id",
  "Issue Id", "Project Id", "Record Id", "Issue Type", "Assignee", "Summary",
  "In Time", "Out Time", "Total Hours", "Status",
  "Worklog Id", "Worklog Date", "Worklog Hours", "Worklog Description", "Worklog Category", "Department",
  // getLeaveBalance columns
  "Balance Leaves",
  "Entitled Leaves",
  "Optional Balance",
  "Optional Leaves Track",
  "Used Leaves",
  "Used Optional",
  // getLeaveCalendar columns
  "Boolean",
  "Color",
  "Date",
  "Name",
] as const;

const pmsLookupFilterParameters = z
  .object({
    field: z
      .enum(FILTERABLE_FIELDS)
      .describe(
        "Filterable field name (getLeaveApplicationStatus only).",
      ),
    operator: z
      .enum(["equals", "contains", "between"])
      .describe(
        "equals/contains for text fields; between (inclusive) for date fields.",
      ),
    value: z
      .string()
      .describe("Filter value; for date fields the range start, YYYY-MM-DD."),
    secondValue: z
      .string()
      .nullable()
      .describe("Range end (YYYY-MM-DD) for between; null otherwise."),
  })
  .strict();

const pmsLookupParameters = z
  .object({
    lookup: z.enum([
      "getLeaveBalance",
      "getLeaveCalendar",
      "getLeaveApplicationStatus",
      "getIssueContext",
      "getWorklogCategories",
      "getIssueWorklogs",
      "getMyWorklogs",
      "getMyAttendance",
      "getAllowedIssueStatuses",
    ]),
    newStatus: z.string().nullable().describe("Desired status for getAllowedIssueStatuses, null to list transitions or for other lookups."),
    details: z.array(z.object({ field: z.string(), value: z.string().nullable(), values: z.array(z.string()).nullable() }).strict()).nullable(),
    fromDate: z.string().nullable().describe("For getMyAttendance/getMyWorklogs: inclusive India date-range start YYYY-MM-DD. Set date/logDate null and supply toDate. Use one lookup for the whole range."),
    toDate: z.string().nullable().describe("Inclusive India date-range end YYYY-MM-DD, at most 366 days; null for a single day or other lookups."),
    excludeWeekends: z.boolean().nullable().describe("For attendance/worklogs: true excludes Saturdays/Sundays from summaries when weekends are off; null otherwise."),
    date: z.string().nullable().describe("Required for getMyAttendance: India YYYY-MM-DD from hidden context. null otherwise."),
    logDate: z.string().nullable().describe("Required for getMyWorklogs: India YYYY-MM-DD; resolve relative dates using the hidden donna_context timestamp. null otherwise."),
    issueId: z.string().nullable().describe("Required for getIssueContext, getIssueWorklogs and getAllowedIssueStatuses; preserve the exact user-supplied prefix. null for other lookups."),
    filters: z
      .array(pmsLookupFilterParameters)
      .nullable()
      .describe(
        "Server-side filters (getLeaveApplicationStatus only) — filter by status, leave type, dates, or application id instead of fetching everything. null for none.",
      ),
    columns: z
      .array(z.enum(LOOKUP_COLUMNS))
      .nullable()
      .describe(
        "Return only these columns (e.g. Application Id, Application Status). null for all columns.",
      ),
    top: z
      .number()
      .int()
      .min(1)
      .max(50)
      .nullable()
      .describe("Max rows to return (default 50). null for the default."),
  })
  .strict();

interface VoiceToolOptions {
  scope: PmsScope;
  requestEnd: () => void;
  signal: AbortSignal;
}

export function createVoiceTools({ requestEnd, signal, scope }: VoiceToolOptions) {
  return [
    tool({
      name: "pms_lookup",
      description:
        "Read live PMS leave data, issue context, worklog categories, existing issue worklogs, or attendance using the user's signed-in extension session. Never invent PMS data instead of calling this tool.",
      parameters: pmsLookupParameters,
      async execute(input, _runContext, details) {
        signal.throwIfAborted();
        const callId = details?.toolCall?.callId ?? crypto.randomUUID();
        const result = await executeClientTool({
          runId: "realtime",
          scope,
          toolCallId: callId,
          name: "pms_lookup",
          executor: "client",
          arguments: input,
          title: "Read PMS data",
          description: "Read the requested PMS data using your signed-in session.",
          confirmLabel: "Continue",
          requiresApproval: true,
        }, signal);
        return JSON.stringify(result);
      },
    }),
    tool({
      name: "end_voice_session",
      description:
        "End the current Realtime voice conversation. Use only when the user clearly asks to end, stop, leave, or says goodbye. Say one brief goodbye before calling this tool.",
      parameters: z.object({}).strict(),
      async execute() {
        signal.throwIfAborted();
        requestEnd();
        return JSON.stringify({ ending: true });
      },
    }),
  ];
}
