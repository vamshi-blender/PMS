import { tool } from "@openai/agents/realtime";
import { z } from "zod";
import { executeClientTool } from "../api/clientTools";
import { executeRealtimeServerTool } from "../api/realtime";

const serverTimeParameters = z
  .object({ timeZone: z.string().nullable() })
  .strict();

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
    ]),
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
  requestEnd: () => void;
  signal: AbortSignal;
}

export function createVoiceTools({ requestEnd, signal }: VoiceToolOptions) {
  return [
    tool({
      name: "get_server_time",
      description:
        "Return the current server date and time. Use this to resolve current or relative dates before date-sensitive PMS lookups.",
      parameters: serverTimeParameters,
      async execute(input) {
        signal.throwIfAborted();
        const result = await executeRealtimeServerTool("get_server_time", input, signal);
        return JSON.stringify(result);
      },
    }),
    tool({
      name: "pms_lookup",
      description:
        "Read live PMS leave balances, existing leave days, or leave application statuses using the user's signed-in extension session. Never invent PMS data instead of calling this tool.",
      parameters: pmsLookupParameters,
      async execute(input, _runContext, details) {
        signal.throwIfAborted();
        const callId = details?.toolCall?.callId ?? crypto.randomUUID();
        const result = await executeClientTool({
          runId: "realtime",
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
