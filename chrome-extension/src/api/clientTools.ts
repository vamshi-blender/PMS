import { parseTransitionDetails } from "../pms/status-change";
import { executePmsAction, runPmsLookup } from "../pms/executor";
import type { PmsLookupFilter, PmsLookupQuery } from "../pms/types";
import type { ToolApprovalRequest } from "./protocol";

interface PageContextArguments {
  includeSelection: boolean;
  maxCharacters: number;
}

function parsePageContextArguments(
  value: Record<string, unknown>,
): PageContextArguments {
  if (
    typeof value.includeSelection !== "boolean" ||
    typeof value.maxCharacters !== "number" ||
    !Number.isInteger(value.maxCharacters) ||
    value.maxCharacters < 500 ||
    value.maxCharacters > 12_000
  ) {
    throw new Error("Donna requested invalid page-reading options.");
  }

  return {
    includeSelection: value.includeSelection,
    maxCharacters: value.maxCharacters,
  };
}

function readPageContext(options: PageContextArguments) {
  const selectedText = options.includeSelection
    ? window.getSelection()?.toString().trim() ?? ""
    : "";
  const visibleText = (document.body?.innerText ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, options.maxCharacters);

  return {
    url: window.location.href,
    title: document.title,
    selectedText,
    visibleText,
    truncated: visibleText.length >= options.maxCharacters,
  };
}

async function executePageContext(request: ToolApprovalRequest, signal?: AbortSignal) {
  const args = parsePageContextArguments(request.arguments);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active browser tab is available.");

  signal?.throwIfAborted();
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readPageContext,
    args: [args],
  });

  if (!execution || execution.result === undefined) {
    throw new Error("The active page did not return any readable content.");
  }

  return execution.result;
}

const LOOKUP_OPERATORS = ["equals", "contains", "between"] as const;

/** Shape-check the optional filters/columns/top args. Donna's tool schema
 * sends null for omitted fields; the executor re-validates field/column
 * names against the manifest, so this only guards the value shapes. */
function parseLookupQuery(args: Record<string, unknown>): PmsLookupQuery {
  const query: PmsLookupQuery = {};
  if (args.newStatus !== undefined && args.newStatus !== null) {
    if (typeof args.newStatus !== "string") throw new Error("Invalid target status.");
    query.newStatus = args.newStatus;
  }
  if (args.details !== undefined && args.details !== null) query.details = parseTransitionDetails(args.details);
  if (args.date !== undefined && args.date !== null) {
    if (typeof args.date !== "string") throw new Error("Invalid attendance date.");
    query.date = args.date;
  }
  if (args.logDate !== undefined && args.logDate !== null) {
    if (typeof args.logDate !== "string") throw new Error("Invalid worklog date.");
    query.logDate = args.logDate;
  }
  if (args.issueId !== undefined && args.issueId !== null) {
    if (typeof args.issueId !== "string" || !args.issueId.trim()) throw new Error("Invalid issueId.");
    query.issueId = args.issueId;
  }

  if (args.filters !== undefined && args.filters !== null) {
    if (!Array.isArray(args.filters)) {
      throw new Error("Donna sent PMS lookup filters in an invalid format.");
    }
    query.filters = args.filters.map((entry): PmsLookupFilter => {
      const filter = entry as Record<string, unknown>;
      const operator = filter.operator as PmsLookupFilter["operator"];
      if (
        typeof filter.field !== "string" ||
        !filter.field ||
        typeof filter.value !== "string" ||
        !LOOKUP_OPERATORS.includes(operator) ||
        (filter.secondValue !== undefined &&
          filter.secondValue !== null &&
          typeof filter.secondValue !== "string")
      ) {
        throw new Error("Donna sent an invalid PMS lookup filter.");
      }
      return {
        field: filter.field,
        operator,
        value: filter.value,
        secondValue:
          typeof filter.secondValue === "string" && filter.secondValue
            ? filter.secondValue
            : undefined,
      };
    });
  }

  if (args.columns !== undefined && args.columns !== null) {
    if (
      !Array.isArray(args.columns) ||
      args.columns.some((column) => typeof column !== "string" || !column)
    ) {
      throw new Error("Donna sent PMS lookup columns in an invalid format.");
    }
    query.columns = args.columns as string[];
  }

  if (args.top !== undefined && args.top !== null) {
    if (
      typeof args.top !== "number" ||
      !Number.isInteger(args.top) ||
      args.top < 1
    ) {
      throw new Error("Donna sent an invalid PMS lookup row limit.");
    }
    query.top = args.top;
  }

  return query;
}

async function executePmsLookupTool(request: ToolApprovalRequest, signal?: AbortSignal) {
  const lookup = request.arguments.lookup;
  if (typeof lookup !== "string" || !lookup) {
    throw new Error("Donna requested a PMS lookup without naming it.");
  }
  return runPmsLookup(lookup, parseLookupQuery(request.arguments), signal);
}

async function executeSubmitPmsAction(request: ToolApprovalRequest, signal?: AbortSignal) {
  const { actionName, fields } = request.arguments;
  if (typeof actionName !== "string" || !actionName) {
    throw new Error("Donna requested a PMS action without naming it.");
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("Donna requested a PMS action without its fields.");
  }
  return executePmsAction(actionName, fields as Record<string, unknown>, signal);
}

const CLIENT_TOOL_HANDLERS: Record<
  string,
  (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<unknown>
> = {
  get_current_page_context: executePageContext,
  pms_lookup: executePmsLookupTool,
  submit_pms_action: executeSubmitPmsAction,
};

export async function executeClientTool(request: ToolApprovalRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handler =
    request.executor === "client" ? CLIENT_TOOL_HANDLERS[request.name] : undefined;
  if (!handler) {
    throw new Error("Donna requested a browser tool that is not allowed.");
  }
  const result = await handler(request, signal);
  signal?.throwIfAborted();
  return result;
}
