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
import type { PmsUserProfile } from "../pms/user-profile";
import { memoryInstructions } from "../memory/prompt";
import { MEMORY_INSTRUCTIONS, manageMemory } from "../memory/tool";
import { SKILL_INSTRUCTIONS, skillInstructions } from "../skills/prompt";
import { manageProceduralMemory } from "../skills/tool";
import type { Skill, SkillSummary } from "../skills/store";

export interface ClientToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface DonnaRunContext {
  clientToolResults: Record<string, ClientToolResult>;
  scope?: PmsScope;
  userProfile?: PmsUserProfile;
  /** The chat this run belongs to; recorded as the source of saved memories. */
  conversationId?: string;
  skillCatalog?: SkillSummary[];
  loadedSkills?: Skill[];
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
    "Prepare one PMS action (leave application, worklog or issue status change) for the extension's approval card. Calling this pauses for approval; it does not create or change a PMS record until the user approves the card. Once valid fields are available, call this directly instead of asking for chat confirmation. An explicitly labeled estimated worklog end may be proposed on the card. After approval, execution uses the user's PMS session and creates a real change.",
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

// The fixed part of Donna's instructions. The per-user memory block is
// appended on every model call (see donnaAgent.instructions).
export const DONNA_BASE_INSTRUCTIONS = `You are Donna, a thoughtful personal AI assistant in a Chrome extension.

Help the user clearly and directly. Keep answers concise unless the task benefits from detail.
Remember and use relevant information from the current conversation.
For tool-heavy work, use brief commentary updates before and between tool calls so the user can follow meaningful progress. Put only the completed answer in the final answer phase, and do not repeat the entire work log there.
${PROMPT_CONTEXT_INSTRUCTIONS}
Use get_current_page_context only when the user's request depends on the active browser page. Explain why page access is needed before requesting it when that is not obvious.

PMS (the user's Quixy project-management system):
The server's donna_pms_environment tag identifies the environment for this entire run. All PMS results and actions belong to that environment. Never mix staging and production data or claim an action happened in another environment. Switching environments requires using the extension's environment selector.
${SKILL_INSTRUCTIONS}
Use pms_lookup directly for current PMS data; fetch supported missing information before asking the user. Use list_pms_capabilities for supported lookups, fields and business rules. Never invent policies, identifiers, required inputs or tool results. Missing attendance is unknown, and attendance is not proof of physical office presence. Use full summaries for totals, never truncated rows. Preserve explicit issue prefixes and resolve numeric IDs uniquely.
For submissions, the extension's approval card is the only confirmation step. Call submit_pms_action when fields and validations are ready; do not ask for typed confirmation first. Never bypass approvals, retry an uncertain write, or claim success without a successful tool result. Confirm meaningful details without internal IDs unless requested.

Never claim that you inspected a page or used a tool unless the tool returned successfully.
If the user declines page access, continue without it when possible and state the limitation.
Do not invent tool results, private data, or completed actions.
Do not use em dashes in your final answer. Use a colon or parentheses instead.

${MEMORY_INSTRUCTIONS}`;

export const donnaAgent = new Agent<DonnaRunContext>({
  name: "Donna",
  model: process.env.OPENAI_MODEL ?? "gpt-5.6",
  // Rebuilt per model call so memory changes (including ones made earlier in
  // the same run) are always reflected, and expired entries drop out.
  instructions: async (runContext) => {
    const [memory, skills] = await Promise.all([
      memoryInstructions(runContext.context?.scope),
      skillInstructions(runContext.context),
    ]);
    return DONNA_BASE_INSTRUCTIONS + memory + skills;
  },
  tools: [
    getCurrentPageContext,
    pmsLookup,
    submitPmsAction,
    listPmsCapabilities,
    manageMemory,
    manageProceduralMemory,
  ],
});
