import { parseTransitionDetails, prepareStatusChange } from "./status-change";
// The PMS engine runs server-hosted manifests with supported calculation
// strategies for leave and worklogs. Fields, source IDs, and payload templates
// come from the bundle. It validates inputs, runs the declared
// resolvers, computes derived fields, renders the payload template, and
// fires the submit. Errors are phrased so Donna can relay them to the user.
import {
  deriveWorklog, fetchCategoryLabels, fetchWorklogCalendar, normalizeIssueId,
  resolveIssue, validateWorklogInputs, type WorklogCalendar,
} from "./worklog";
import { getPmsUserDetails } from "../api/pmsAuth";
import { getPmsBundle } from "./bundle";
import {
  datesTriple,
  displayDate,
  nowUtcMinute,
  parseInputDate,
  quixyDateTimeFormat,
  quixyUtcDate,
  rawDayCount,
  todayLocal,
} from "./derive";
import {
  fetchDataTableRow,
  fetchIssueWorklogs,
  fetchDailyWorklogs,
  fetchAttendanceReport,
  fetchDatasourceRows,
  fetchNextSerialNumber,
  fetchReportGrid,
  saveAppData,
  type QuixyReportFilter,
} from "./primitives";
import type {
  PmsActionManifest,
  PmsBundle,
  PmsLookupFilter,
  PmsLookupQuery,
  PmsLookupSource,
  PmsReportGridSource,
  PmsRule,
  PmsValueSpec,
} from "./types";

// Keep list outputs well under the 60KB cap on tool results (and out of
// respect for the model's context window).
const MAX_LOOKUP_ROWS = 50;

type ExecutionContext = Record<string, unknown> & {
  serial?: string;
};

function contextValue(context: ExecutionContext, path: string): unknown {
  if (path === "serial") return context.serial;
  const dot = path.indexOf(".");
  if (dot === -1) return context[path];
  const namespace = context[path.slice(0, dot)];
  const key = path.slice(dot + 1);
  if (!namespace || typeof namespace !== "object") return undefined;
  return (namespace as Record<string, unknown>)[key];
}

function renderValue(spec: PmsValueSpec, context: ExecutionContext): unknown {
  if ("const" in spec) return spec.const;
  const value = contextValue(context, spec.ref);
  if (value === undefined) {
    throw new Error(`PMS manifest referenced missing value "${spec.ref}".`);
  }
  return spec.format === "quixyDateTime" ? quixyDateTimeFormat(value) : value;
}

async function buildUserContext(signal?: AbortSignal): Promise<Record<string, string>> {
  const user = await getPmsUserDetails(signal);
  if (!user.employeeCode) {
    throw new Error(
      "PMS did not report an employee code for the logged-in user.",
    );
  }
  return {
    employeeCode: user.employeeCode,
    userId: user.userId,
    emailId: user.email,
    fullName: user.fullName,
    contactNumber: user.contactNumber,
    organizationId: user.organizationId,
  };
}

const TEXT_CONDITIONS: Record<string, "Equal" | "Contains"> = {
  equals: "Equal",
  contains: "Contains",
};

/** Validate pms_lookup filters against the manifest's filterableFields and
 * translate them into the report API's wire shape. Errors are phrased so
 * Donna can correct the call (or the user) rather than retry blindly. */
function buildReportFilters(
  source: PmsReportGridSource,
  filters: PmsLookupFilter[],
): QuixyReportFilter[] {
  const fields = source.filterableFields ?? [];
  if (fields.length === 0) {
    throw new Error("This lookup does not support filters.");
  }
  const fieldNames = fields.map((field) => field.name).join(", ");

  return filters.map((filter) => {
    const field = fields.find((candidate) => candidate.name === filter.field);
    if (!field) {
      throw new Error(
        `"${filter.field}" is not a filterable field. Available: ${fieldNames}.`,
      );
    }

    if (field.type === "date") {
      if (filter.operator !== "between") {
        throw new Error(
          `"${field.name}" is a date field — use operator "between" with YYYY-MM-DD value (and optional secondValue).`,
        );
      }
      const from = parseInputDate(filter.value);
      const to = parseInputDate(filter.secondValue ?? filter.value);
      if (rawDayCount(from, to) < 1) {
        throw new Error(
          `The "${field.name}" range ends before it starts.`,
        );
      }
      return {
        ElementType: "Date",
        LabelName: field.name,
        Condition: "Custom",
        Type: "textType",
        DefaultValue: quixyUtcDate(from),
        SecondValue: quixyUtcDate(to),
        MappingType: "Mapped",
      } satisfies QuixyReportFilter;
    }

    const condition = TEXT_CONDITIONS[filter.operator];
    if (!condition) {
      throw new Error(
        `"${field.name}" is a text field — use operator "equals" or "contains".`,
      );
    }
    if (
      filter.operator === "equals" &&
      field.values &&
      !field.values.includes(filter.value)
    ) {
      throw new Error(
        `"${filter.value}" is not a valid ${field.name}. Valid values: ${field.values.join(", ")}.`,
      );
    }
    return {
      ElementType: "TextBox",
      LabelName: field.name,
      Condition: condition,
      Type: "textType",
      DefaultValue: filter.value,
      SecondValue: "",
      MappingType: "Static",
    } satisfies QuixyReportFilter;
  });
}

/** Keep only the requested columns, validating names against the columns
 * this source is known to return. */
function projectColumns<T extends Record<string, unknown>>(
  row: T,
  columns: string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const column of columns) projected[column] = row[column];
  return projected;
}

function validateColumns(columns: string[], available: string[]): void {
  if (available.length === 0) {
    throw new Error("This lookup does not support column selection.");
  }
  const unknown = columns.filter((column) => !available.includes(column));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown column(s): ${unknown.join(", ")}. Available: ${available.join(", ")}.`,
    );
  }
}

function availableColumnsOf(source: PmsLookupSource): string[] {
  if (source.kind === "reportGrid") return source.availableColumns ?? [];
  if (source.kind === "datasourceRows") return source.outputColumns;
  if (source.kind === "dataTableRow") return source.referencedElements;
  if (source.kind === "issueContext" || source.kind === "worklogReport" || source.kind === "dailyWorklogs" || source.kind === "attendanceReport") return source.availableColumns;
  return [];
}

async function runLookupSource(
  source: PmsLookupSource,
  context: ExecutionContext,
  query?: PmsLookupQuery,
  signal?: AbortSignal,
): Promise<unknown> {
  const columns = query?.columns;
  if (columns && columns.length > 0) {
    validateColumns(columns, availableColumnsOf(source));
  }
  if (query?.filters?.length && source.kind !== "reportGrid") {
    throw new Error("This lookup does not support filters.");
  }
  const rowCap = Math.min(query?.top ?? MAX_LOOKUP_ROWS, MAX_LOOKUP_ROWS);

  if (source.kind === "issueTransitions") {
    const user = context.user as Record<string, string>;
    return (await prepareStatusChange(source, { issueId: query?.issueId, newStatus: query?.newStatus, details: query?.details }, user, signal)).publicResult;
  }

  if (source.kind === "attendanceReport") {
    if (!query?.date) throw new Error("getMyAttendance requires date as YYYY-MM-DD (India).");
    parseInputDate(query.date);
    const date = query.date.trim();
    const user = context.user as Record<string, string>;
    const page = await fetchAttendanceReport(source.reportId, date, signal);
    for (const row of page.rows) {
      if (row.Date !== date || row["Employee Code"] !== user.employeeCode) {
        throw new Error("PMS returned attendance for a different date or employee; no record can be reported.");
      }
      for (const field of ["In Time", "Out Time", "Total Hours", "Status"]) {
        if (row[field] !== null && row[field] !== undefined && typeof row[field] !== "string") {
          throw new Error("PMS returned invalid attendance values.");
        }
      }
    }
    return {
      date, timeZone: "Asia/Kolkata", recordFound: page.rows.length > 0,
      entryCount: page.total ?? page.rows.length,
      rows: page.rows.slice(0, rowCap).map(row => projectColumns(row, columns?.length ? columns : source.availableColumns)),
      truncated: (page.total ?? page.rows.length) > Math.min(rowCap, page.rows.length) || page.rows.length >= 100,
    };
  }

  if (source.kind === "dailyWorklogs") {
    if (!query?.logDate) throw new Error("getMyWorklogs requires logDate in YYYY-MM-DD (India).");
    const date = quixyUtcDate(parseInputDate(query.logDate));
    const user = context.user as Record<string, string>;
    const rows = await fetchDailyWorklogs(source, user.emailId, date, signal);
    let totalHours = 0;
    for (const row of rows) {
      const hours = row["Worklog Hours"];
      const rowDate = String(row["Worklog Date"] ?? "");
      if (rowDate.slice(0, 19) !== date.slice(0, 19) ||
          (typeof hours !== "number" && (typeof hours !== "string" || !/^\d+(\.\d+)?$/.test(hours))) ||
          !Number.isFinite(Number(hours)) || Number(hours) < 0) {
        throw new Error("PMS returned an invalid date or hours; the daily total is unavailable.");
      }
      totalHours += Number(hours);
    }
    if (!Number.isFinite(totalHours)) throw new Error("PMS returned invalid daily hours.");
    return {
      logDate: query.logDate, timeZone: "Asia/Kolkata",
      totalHours: Math.round(totalHours * 1e8) / 1e8, entryCount: rows.length,
      rows: rows.slice(0, rowCap).map(row => projectColumns(row, columns?.length ? columns : source.availableColumns)),
      truncated: rows.length > rowCap,
    };
  }

  if (source.kind === "reportGrid") {
    const filters = query?.filters?.length
      ? buildReportFilters(source, query.filters)
      : undefined;
    const rows = await fetchReportGrid(source, { filters, signal });
    return {
      rows: rows
        .slice(0, rowCap)
        .map((row) => (columns?.length ? projectColumns(row, columns) : row)),
      truncated: rows.length > rowCap,
    };
  }

  if (source.kind === "lookupOptions") return fetchCategoryLabels(source.lookupTypeId, signal);
  if (source.kind === "calendar") return fetchWorklogCalendar(source.calendarId, signal);

  const keyValue = contextValue(context, source.keyRef);
  if (typeof keyValue !== "string" || !keyValue) {
    throw new Error(`PMS lookup key "${source.keyRef}" is unavailable.`);
  }

  if (source.kind === "issueContext" || source.kind === "worklogReport") {
    const issue = await resolveIssue(source.viewId, keyValue, signal);
    if (source.kind === "issueContext") return columns?.length ? projectColumns(issue, columns) : issue;
    const user = context.user as Record<string, string>;
    const page = await fetchIssueWorklogs(source.reportId, user.userId, issue["Issue Id"], signal);
    const selected = columns?.length ? columns : source.availableColumns;
    return { rows: page.rows.slice(0, rowCap).map(row => projectColumns(row, selected)),
      truncated: (page.total ?? page.rows.length) > rowCap || page.rows.length >= 100 };
  }

  if (source.kind === "dataTableRow") {
    const record = await fetchDataTableRow(source, keyValue, signal);
    return columns?.length ? projectColumns(record, columns) : record;
  }

  const rows = await fetchDatasourceRows(source, keyValue, signal);
  // Datasource APIs may ignore OutputColumns and return employee master data.
  // Always project locally; never expose unrelated employee data to the model.
  if (source.single) {
    if (rows.length !== 1) throw new Error("PMS expected exactly one employee department record.");
    const row = projectColumns(rows[0], source.outputColumns);
    if (source.outputColumns.some(column => row[column] === undefined || row[column] === null)) {
      throw new Error("PMS employee record is missing a required field.");
    }
    return row;
  }
  return {
    rows: rows
      .slice(0, rowCap)
      .map((row) => projectColumns(row, columns?.length ? columns : source.outputColumns)),
    truncated: rows.length > rowCap,
  };
}

/** Standalone lookup — the pms_lookup tool's implementation. */
export async function runPmsLookup(
  lookupName: string,
  query?: PmsLookupQuery,
  signal?: AbortSignal,
): Promise<unknown> {
  const bundle = await getPmsBundle(signal);
  const lookup = bundle.lookups[lookupName];
  if (!lookup || !lookup.queryable) {
    throw new Error(`"${lookupName}" is not an available PMS lookup.`);
  }
  if (query?.issueId !== undefined && lookup.source.kind !== "issueContext" && lookup.source.kind !== "worklogReport" && lookup.source.kind !== "issueTransitions") {
    throw new Error("This lookup does not accept issueId.");
  }
  if ((query?.newStatus !== undefined || query?.details !== undefined) && lookup.source.kind !== "issueTransitions") {
    throw new Error("This lookup does not accept transition parameters.");
  }
  if (query?.date !== undefined && lookup.source.kind !== "attendanceReport") {
    throw new Error("This lookup does not accept date.");
  }
  if (query?.logDate !== undefined && lookup.source.kind !== "dailyWorklogs") {
    throw new Error("This lookup does not accept logDate.");
  }
  const context: ExecutionContext = { user: await buildUserContext(signal), input: { issueId: query?.issueId } };
  return runLookupSource(lookup.source, context, query, signal);
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

function validateInputs(
  manifest: PmsActionManifest,
  inputs: Record<string, unknown>,
): void {
  const known = new Set(manifest.inputs.map((slot) => slot.name));
  for (const key of Object.keys(inputs)) {
    if (!known.has(key)) throw new Error(`Unexpected input "${key}".`);
  }

  for (const slot of manifest.inputs) {
    const value = inputs[slot.name];
    const empty = value === undefined || value === null || value === "";
    if (empty) {
      if (slot.required) throw new Error(`Missing required input "${slot.name}".`);
      continue;
    }
    if (slot.type === "details") {
      const details = parseTransitionDetails(value);
      if (details.some(detail => !slot.options?.includes(detail.field))) throw new Error("Unknown transition detail field.");
      continue;
    }
    if (slot.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`Input "${slot.name}" must be true or false.`);
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Input "${slot.name}" must be a string.`);
    }
    if (slot.type === "enum" && slot.options && !slot.options.includes(value)) {
      throw new Error(
        `Input "${slot.name}" must be one of: ${slot.options.join(", ")}.`,
      );
    }
    if (slot.type === "date") parseInputDate(value);
    if (slot.maxLength && value.length > slot.maxLength) {
      throw new Error(
        `Input "${slot.name}" exceeds ${slot.maxLength} characters.`,
      );
    }
  }
}

function ruleApplies(
  rule: { when?: { field: string; equals: string } },
  inputs: Record<string, unknown>,
): boolean {
  return !rule.when || inputs[rule.when.field] === rule.when.equals;
}

/** Rules that only need the inputs (run before any network call). */
function applyInputRules(
  rules: PmsRule[],
  inputs: Record<string, unknown>,
): void {
  for (const rule of rules) {
    if (rule.kind === "forceValue" && ruleApplies(rule, inputs)) {
      if (inputs[rule.field] !== rule.value) throw new Error(rule.message);
    }
    if (rule.kind === "requiredIf" && ruleApplies(rule, inputs)) {
      const value = inputs[rule.field];
      if (value === undefined || value === null || value === "") {
        throw new Error(rule.message);
      }
    }
    if (rule.kind === "mustBeTrue" && inputs[rule.field] !== true) {
      throw new Error(rule.message);
    }
    if (rule.kind === "sameMonthRange") {
      const from = parseInputDate(String(inputs[rule.fromField]));
      const to = parseInputDate(String(inputs[rule.toField]));
      if (rawDayCount(from, to) < 1) {
        throw new Error("The leave end date is before the start date.");
      }
      if (
        from.year !== to.year ||
        from.month !== to.month ||
        to.day > rule.maxEndDay
      ) {
        throw new Error(rule.message);
      }
    }
  }
}

/** Rules that compare against resolver data (run after resolvers). */
function applyDataRules(
  rules: PmsRule[],
  inputs: Record<string, unknown>,
  effectiveDays: number,
  context: ExecutionContext,
): void {
  for (const rule of rules) {
    if (rule.kind !== "maxEffectiveDays" || !ruleApplies(rule, inputs)) continue;
    const limit = Number(contextValue(context, rule.limitRef));
    if (Number.isFinite(limit) && effectiveDays > limit) {
      throw new Error(`${rule.message} (Remaining: ${limit}.)`);
    }
  }
}

/** Leave-style derived fields. Manifests may only reference derives this
 * engine computes; a fundamentally new derive needs an extension update. */
function buildDeriveNamespace(
  inputs: Record<string, unknown>,
  user: Record<string, string>,
): Record<string, unknown> {
  const from = parseInputDate(String(inputs.fromDate));
  const to = parseInputDate(String(inputs.toDate));
  const halfDay = inputs.halfDay === "Yes";
  const rawDays = rawDayCount(from, to);

  return {
    applicationDateUtc: quixyUtcDate(todayLocal()),
    fromUtc: quixyUtcDate(from),
    toUtc: quixyUtcDate(to),
    datesTriple: datesTriple(from, to),
    fromDisplay: displayDate(from),
    toDisplay: displayDate(to),
    rawDays,
    // The hidden "…Calculate" fields: month number and day-of-month of the
    // range ends, which downstream workflow validations key on.
    fromMonth: from.month,
    toMonth: to.month,
    fromDay: from.day,
    toDay: to.day,
    effectiveDays: halfDay ? 0.5 : rawDays,
    halfDayNumber: halfDay ? 0.5 : "",
    halfDayType: halfDay ? inputs.halfDayType ?? "" : "",
    contactNumber:
      typeof inputs.contactNumber === "string" && inputs.contactNumber
        ? inputs.contactNumber
        : user.contactNumber,
    nowUtcMinute: nowUtcMinute(),
  };
}

export interface PmsActionResult {
  recordId: string;
  appDataId: string;
  summary: Record<string, unknown>;
}

/** Full pipeline — the submit_pms_action tool's implementation. */
export async function executePmsAction(
  actionName: string,
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PmsActionResult> {
  const bundle: PmsBundle = await getPmsBundle(signal);
  const manifest = bundle.actions[actionName];
  if (!manifest) throw new Error(`"${actionName}" is not a known PMS action.`);

  inputs = { ...inputs };
  if (manifest.derive === "worklog" && (inputs.billableHours === undefined || inputs.billableHours === null)) {
    inputs.billableHours = inputs.logHours;
  }
  validateInputs(manifest, inputs);
  if (manifest.derive === "worklog") {
    validateWorklogInputs(inputs);
    inputs.issueId = normalizeIssueId(inputs.issueId, true);
  }
  applyInputRules(manifest.rules, inputs);

  const user = await buildUserContext(signal);
  const context: ExecutionContext = { input: inputs, user };
  const isStatusChange = manifest.derive === "statusChange";
  let statusValues: Record<string, unknown> | undefined;
  if (isStatusChange) {
    const source = bundle.lookups[manifest.resolvers.transition]?.source;
    if (source?.kind !== "issueTransitions") throw new Error("Status transition resolver is unavailable.");
    const prepared = await prepareStatusChange(source, inputs, user, signal, true);
    context.issue = prepared.context.issue;
    statusValues = prepared.values;
  }

  // Execution resolvers, namespaced as the manifest declares.
  for (const [namespace, lookupName] of Object.entries(isStatusChange ? {} : manifest.resolvers)) {
    const lookup = bundle.lookups[lookupName];
    if (!lookup) {
      throw new Error(`PMS manifest references unknown lookup "${lookupName}".`);
    }
    context[namespace] = await runLookupSource(lookup.source, context, undefined, signal);
  }

  const isWorklog = manifest.derive === "worklog";
  if (isWorklog) {
    const issue = context.issue as Record<string, string>;
    if (issue["Issue Id"].toUpperCase() !== inputs.issueId || issue.Summary !== inputs.issueSummary) {
      throw new Error("The issue details changed. Look up the issue again and request a new approval.");
    }
    const categories = context.categories as { values: string[] };
    if (!categories.values.includes(String(inputs.category))) {
      throw new Error("The category is not active. Look up worklog categories and request a new approval.");
    }
  }
  const derive = statusValues ?? (isWorklog
    ? deriveWorklog(inputs, context.calendar as WorklogCalendar)
    : buildDeriveNamespace(inputs, user));
  context.derive = derive;

  applyDataRules(manifest.rules, inputs, derive.effectiveDays as number, context);

  if (manifest.serialAppElementId) context.serial = await fetchNextSerialNumber(
    manifest.serialAppElementId,
    manifest.appId,
    user.organizationId,
    signal,
  );

  const payload: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.payload)) {
    payload[key] = renderValue(spec, context);
  }

  if (isStatusChange) {
    const source = bundle.lookups[manifest.resolvers.transition]?.source;
    if (source?.kind !== "issueTransitions") throw new Error("Missing status resolver.");
    const latest = await resolveIssue(source.viewId, inputs.issueId, signal);
    const approved = context.issue as Record<string, string>;
    if (latest.Status !== inputs.currentStatus || latest.Summary !== inputs.issueSummary || latest["Record Id"] !== approved["Record Id"]) {
      throw new Error("Issue changed while preparing the transition. Request a fresh approval.");
    }
  }
  signal?.throwIfAborted();
  const { appDataId } = await saveAppData(manifest.submitPath, payload, signal);

  return {
    recordId: context.serial ?? appDataId,
    appDataId,
    summary: isStatusChange ? {
      action: actionName, issueId: (context.issue as Record<string, string>)["Issue Id"],
      issueSummary: inputs.issueSummary, previousStatus: inputs.currentStatus, status: inputs.newStatus,
    } : isWorklog ? {
      action: actionName, issueId: (context.issue as Record<string, string>)["Issue Id"],
      issueSummary: inputs.issueSummary, category: inputs.category, logDate: inputs.logDate,
      logHours: inputs.logHours, billableHours: inputs.billableHours, status: "Completed",
    } : {
      action: actionName,
      applicationId: context.serial,
      leaveType: inputs.leaveType,
      from: derive.fromDisplay,
      to: derive.toDisplay,
      days: derive.effectiveDays,
      status: "Submitted — pending Manager Approval",
    },
  };
}
