import { STATUS_DETAIL_FIELDS } from "../pms/manifests/change-issue-status";
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { actionNames, getPmsBundle, queryableLookupNames } from "../pms/bundle";
import {
  actionFieldsShape,
  transitionDetailsSchema,
  capabilitiesCatalog,
  lookupQuerySummary,
  queryableColumnNames,
  queryableFilterFieldNames,
} from "../pms/schema";
import { CONFIRM_LABELS } from "./protocol";
import { PROMPT_CONTEXT_INSTRUCTIONS } from "../../shared/prompt-context";
import type { PmsScope } from "../../shared/pms-scope";

export interface ClientToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface DonnaRunContext {
  clientToolResults: Record<string, ClientToolResult>;
  scope?: PmsScope;
}

// Every tool that needsApproval must include these fields in its parameters.
// The model fills them when it makes the tool call, so the approval card the
// user sees is specific to what the tool is about to do.
const approvalPresentationFields = {
  approvalTitle: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "Short question asking the user to approve this exact action, specific to the current request — never a generic permission prompt.",
    ),
  approvalDescription: z
    .string()
    .min(1)
    .max(240)
    .describe(
      "One or two sentences telling the user precisely what will happen and what data is involved, phrased for this specific request.",
    ),
  confirmLabel: z
    .enum(CONFIRM_LABELS)
    .describe("The approve-button verb that best matches the action."),
};

const pageContextParameters = z
  .object({
    includeSelection: z.boolean(),
    maxCharacters: z.number().int().min(500).max(12_000),
    ...approvalPresentationFields,
  })
  .strict();

const getCurrentPageContext = tool<
  typeof pageContextParameters,
  DonnaRunContext,
  string
>({
  name: "get_current_page_context",
  description:
    "Ask the browser extension for the active page URL, title, selected text, and visible page text. Use only when the user's request depends on the page they are viewing.",
  parameters: pageContextParameters,
  needsApproval: async () => true,
  async execute(_input, runContext, details) {
    const callId = details?.toolCall?.callId;
    if (!callId) {
      throw new Error("The browser tool call did not include a call ID.");
    }

    const result = runContext?.context.clientToolResults[callId];
    if (!result) {
      throw new Error("The browser did not return a result for this tool call.");
    }

    if (!result.ok) {
      return `The browser tool could not read the page: ${result.error ?? "unknown error"}`;
    }

    return JSON.stringify(result.data);
  },
});

// ---------------------------------------------------------------------------
// PMS tools — three generic tools regardless of how many manifests exist.
// Both pms_lookup and submit_pms_action execute in the Chrome extension with
// the user's live PMS session (the pause/resume roundtrip IS the handoff);
// their execute() here only relays the extension's result, same pattern as
// getCurrentPageContext.
// ---------------------------------------------------------------------------

function relayClientResult(
  runContext: { context: DonnaRunContext } | undefined,
  callId: string | undefined,
  failurePrefix: string,
): string {
  if (!callId) throw new Error("The tool call did not include a call ID.");
  const result = runContext?.context.clientToolResults[callId];
  if (!result) {
    throw new Error("The extension did not return a result for this tool call.");
  }
  if (!result.ok) {
    return `${failurePrefix}: ${result.error ?? "unknown error"}`;
  }
  return JSON.stringify(result.data);
}

// Field/column names are enums generated from the manifest bundle, so the
// model cannot invent a name that exists nowhere; which names belong to
// which lookup is documented in the descriptions and re-validated by the
// extension executor. Fall back to plain strings if a future bundle has no
// queryable names (z.enum requires a non-empty list).
function nameEnum(names: string[]): z.ZodTypeAny {
  return names.length ? z.enum(names as [string, ...string[]]) : z.string();
}

const pmsLookupFilterParameters = z
  .object({
    field: nameEnum(queryableFilterFieldNames()).describe(
      "Filterable field name (exact). Which fields belong to which lookup is listed in the filters parameter description.",
    ),
    operator: z
      .enum(["equals", "contains", "between"])
      .describe(
        "equals/contains for text fields; between (inclusive) for date fields.",
      ),
    value: z
      .string()
      .describe(
        "Filter value. For date fields: the range start as YYYY-MM-DD.",
      ),
    secondValue: z
      .string()
      .nullable()
      .describe(
        "Range end (YYYY-MM-DD) for between; null otherwise (a single-day between may pass null).",
      ),
  })
  .strict();

const pmsLookupParameters = z
  .object({
    lookup: z
      .enum(queryableLookupNames() as [string, ...string[]])
      .describe("Which PMS lookup to run."),
    newStatus: z.string().nullable().describe("For getAllowedIssueStatuses: desired next status to inspect its requirements, or null to list transitions."),
    details: transitionDetailsSchema(STATUS_DETAIL_FIELDS).nullable().describe("For getAllowedIssueStatuses: supplied transition details for conditional requirements, null otherwise."),
    fromDate: z.string().nullable().describe("For getMyAttendance/getMyWorklogs: inclusive range start YYYY-MM-DD in India. Supply toDate too; set date/logDate to null. Use one range lookup per data source, not one per day. null for other lookups."),
    toDate: z.string().nullable().describe("Inclusive range end YYYY-MM-DD for getMyAttendance/getMyWorklogs; at most 366 days. null for single-day or other lookups."),
    excludeWeekends: z.boolean().nullable().describe("For attendance/worklog dates only: true to exclude Saturdays/Sundays from details and daily/weekly summaries when the user says weekends are off; false/null otherwise."),
    date: z.string().nullable().describe("Required for getMyAttendance: YYYY-MM-DD in India; use the hidden donna_context timestamp for today/yesterday. null for other lookups."),
    logDate: z.string().nullable().describe("Required for getMyWorklogs: YYYY-MM-DD in India. Resolve today/yesterday using the hidden donna_context timestamp. null for other lookups."),
    issueId: z.string().nullable().describe("Required for getIssueContext and getIssueWorklogs: the issue ID exactly as supplied by the user, including any prefix. A number alone is allowed for unique resolution. null for other lookups."),
    filters: z
      .array(pmsLookupFilterParameters)
      .nullable()
      .describe(
        `Server-side filters (AND-combined). Strongly prefer filtering over fetching everything when the user asks about specific statuses, leave types, dates, or one application id. null when no filtering is needed. Per lookup: ${lookupQuerySummary()}`,
      ),
    columns: z
      .array(nameEnum(queryableColumnNames()))
      .nullable()
      .describe(
        "Return only these columns (exact names; each lookup's columns are listed in the filters parameter description). Prefer the few columns that answer the question; null returns all columns.",
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

const pmsLookup = tool<typeof pmsLookupParameters, DonnaRunContext, string>({
  name: "pms_lookup",
  description:
    "Read live data from the PMS with the user's session: leave balances, existing leave days, leave application statuses, issue context, worklog categories, existing issue worklogs, and attendance. Runs silently in the extension; use it freely to answer PMS data questions. Never invent PMS data instead of calling this. Supports filters, column selection, and a row limit — narrow the result to what the question needs instead of fetching whole datasets.",
  parameters: pmsLookupParameters,
  // Client tools always "need approval" — the pause/resume roundtrip is how
  // execution reaches the extension. The extension auto-approves this one
  // silently (read-only), so the user never sees a card for it.
  needsApproval: async () => true,
  async execute(_input, runContext, details) {
    return relayClientResult(
      runContext,
      details?.toolCall?.callId,
      "The PMS lookup failed",
    );
  },
});

// Root remains an object for strict tool schemas. The nested fields union uses
// each manifest's exact shape; execution revalidates it against actionName.
export const submitPmsActionParameters = z.object({
  actionName: z.enum(actionNames() as [string, ...string[]]),
  fields: z.union(Object.values(getPmsBundle().actions).map(manifest =>
    z.object(actionFieldsShape(manifest.inputs)).strict())),
  ...approvalPresentationFields,
}).strict();

const submitPmsAction = tool<
  typeof submitPmsActionParameters,
  DonnaRunContext,
  string
>({
  name: "submit_pms_action",
  description:
    "Submit one PMS action (e.g. a leave application or worklog) for real, using the user's PMS session in the extension. This creates an actual record and routes it into the PMS workflow. The extension shows the user an approval card before executing — call this directly once the fields are collected; never ask for verbal confirmation in chat first.",
  parameters: submitPmsActionParameters,
  needsApproval: async () => true,
  async execute(_input, runContext, details) {
    return relayClientResult(
      runContext,
      details?.toolCall?.callId,
      "The PMS action failed",
    );
  },
});

const listPmsCapabilities = tool({
  name: "list_pms_capabilities",
  description:
    "List the PMS actions and data lookups Donna currently supports, with their fields and business rules. Use when the user asks what you can do in PMS, or before collecting fields for an action.",
  parameters: z.object({}).strict(),
  async execute(_input, context) {
    return JSON.stringify(capabilitiesCatalog((context?.context as DonnaRunContext | undefined)?.scope?.environment));
  },
});

export const donnaAgent = new Agent<DonnaRunContext>({
  name: "Donna",
  model: process.env.OPENAI_MODEL ?? "gpt-5.6",
  instructions: `You are Donna, a thoughtful personal AI assistant in a Chrome extension.

Help the user clearly and directly. Keep answers concise unless the task benefits from detail.
Remember and use relevant information from the current conversation.
For tool-heavy work, use brief commentary updates before and between tool calls so the user can follow meaningful progress. Put only the completed answer in the final answer phase, and do not repeat the entire work log there.
${PROMPT_CONTEXT_INSTRUCTIONS}
Use get_current_page_context only when the user's request depends on the active browser page. Explain why page access is needed before requesting it when that is not obvious.

PMS (the user's Quixy project-management system):
For date-range, weekly, or daily-completeness questions, use fromDate/toDate with getMyAttendance and/or getMyWorklogs once each for the whole range. Set date/logDate to null and excludeWeekends=true when Saturdays/Sundays are off. The tool paginates internally and computes full daily/weekly summaries before capping detail rows. Use weekly.knownHours with datesWithoutEntries/datesWithUnknownHours; never calculate full-range totals from a truncated detail list. Missing attendance records are unknown, not zero hours or proof of absence. No worklog entry means nothing was logged for that date, not proof no work happened. Attendance hours do not prove physical office presence when WFH is possible. Preserve the requested range and do not silently restrict it to a year or month.
The server's donna_pms_environment tag identifies the environment for this entire run. All PMS results and actions belong to that environment. Never mix staging and production data or claim an action happened in another environment. Switching environments requires using the extension's environment selector.
Use pms_lookup for read-only PMS questions (leave balance, existing leave days, application statuses). It runs silently with the user's session; call it directly instead of asking the user for data it can fetch. Resolve relative dates using the hidden donna_context timestamp.
When a lookup can return many rows, pass filters (by status, leave type, dates, or application id) and columns so only the data the question needs is fetched — check list_pms_capabilities for each lookup's filterable fields, valid values, and column names.
For changing issue status: use pms_lookup with getAllowedIssueStatuses and the user's exact issueId. Call it with newStatus and supplied details to discover visible fields, required fields, options and validationErrors. Collect only necessary or explicitly requested details; never invent lead confirmation, branches, RCA or file uploads. If requiresPmsForm is nonempty, direct the user to PMS. Do not call submit_pms_action until validationErrors are empty. Use canonical issueId, exact summary, currentStatus and newStatus from this lookup; preserve the user's explicit prefix. The extension rechecks fresh form rules and transitions after approval. Never bypass intermediate statuses or automatically retry uncertain writes. Confirm success with issue ID and new status, without internal IDs.
For attendance and login/logout-time questions, use pms_lookup with lookup=getMyAttendance and date. Use the hidden context for relative dates. In Time is attendance login and Out Time is logout, already in local India display format. If no record is returned, say no attendance record was found for that date; do not claim the user was absent or did not log in. Never invent missing Out Time or Total Hours, and distinguish attendance hours from logged worklog hours.
For questions about hours already logged today or on a specific day across all issues, use pms_lookup with lookup=getMyWorklogs and logDate. Resolve relative dates using the hidden donna_context timestamp. Report the returned totalHours and entryCount; do not treat a truncated detail list as the total, and do not sum issue-specific worklogs as if they were all of the user's worklogs.
For worklogs: first use pms_lookup with lookup=getIssueContext and the user's exact issueId (never replace an explicit prefix), and lookup=getWorklogCategories. If the ID is missing, mismatched or ambiguous, stop and ask the user; never switch to a suggested ID without their correction. A numeric ID must resolve uniquely. Put the returned full Issue Id and exact Summary into issueId and issueSummary. Do not invent category labels or issue details. Billable hours default to log hours: do not ask for them separately. Pass billableHours as null unless the user explicitly gives billable hours, in which case preserve that value, including zero. Include full issue ID, summary, category, log date, log hours, billable hours and description in the approval. Only request a new approval after a changed issue/category is resolved. Never retry a submission automatically after an uncertain result.
Use list_pms_capabilities when the user asks what PMS actions you support, or to check an action's fields and rules before collecting them.
For PMS actions (submit_pms_action): collect the user-facing fields conversationally. Check the business rules from list_pms_capabilities early and tell the user immediately if their request violates one (for example leave ranges crossing a calendar month or ending after the 25th) instead of collecting the rest of the fields first.
Submitting: once all required fields are collected, call submit_pms_action directly — do NOT ask for verbal or typed confirmation first. The extension shows the user an approval card with the action details before anything executes; that card is the one and only confirmation step, and declining it cancels the submission. Put the key details (leave type, dates, days, reason) in the approvalDescription so the card is self-explanatory. For leave applications, set acknowledgment to true; the user's approval on the card is the acknowledgment. Dates are YYYY-MM-DD.
The submission executes locally in the user's extension. Confirm success briefly using meaningful details from the successful tool result: for worklogs, include the hours, issue ID and category (for example "Added 1.5 hours to QKA-49715 under Code Review."). For leave, confirm the leave type and dates and include a human-readable application number when available. Do not display internal record IDs or app-data UUIDs unless the user explicitly asks for them; they remain available in the tool result. Never claim a submission happened unless the tool returned success.

Never claim that you inspected a page or used a tool unless the tool returned successfully.
If the user declines page access, continue without it when possible and state the limitation.
Do not invent tool results, private data, or completed actions.
Do not use em dashes in your final answer. Use a colon or parentheses instead.`,
  tools: [
    getCurrentPageContext,
    pmsLookup,
    submitPmsAction,
    listPmsCapabilities,
  ],
});
