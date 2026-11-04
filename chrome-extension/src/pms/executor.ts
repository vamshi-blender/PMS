// The generic PMS engine. It has zero knowledge of any specific form —
// everything action-specific (fields, rules, GUIDs, payload) comes from the
// server-hosted manifest bundle. It validates inputs, runs the declared
// resolvers, computes derived fields, renders the payload template, and
// fires the submit. Errors are phrased so Donna can relay them to the user.
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
  return source.referencedElements;
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

  const keyValue = contextValue(context, source.keyRef);
  if (typeof keyValue !== "string" || !keyValue) {
    throw new Error(`PMS lookup key "${source.keyRef}" is unavailable.`);
  }

  if (source.kind === "dataTableRow") {
    const record = await fetchDataTableRow(source, keyValue, signal);
    return columns?.length ? projectColumns(record, columns) : record;
  }

  const rows = await fetchDatasourceRows(source, keyValue, signal);
  return {
    rows: rows
      .slice(0, rowCap)
      .map((row) => (columns?.length ? projectColumns(row, columns) : row)),
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
  const context: ExecutionContext = { user: await buildUserContext(signal) };
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

  validateInputs(manifest, inputs);
  applyInputRules(manifest.rules, inputs);

  const user = await buildUserContext(signal);
  const context: ExecutionContext = { input: inputs, user };

  // Execution resolvers, namespaced as the manifest declares.
  for (const [namespace, lookupName] of Object.entries(manifest.resolvers)) {
    const lookup = bundle.lookups[lookupName];
    if (!lookup) {
      throw new Error(`PMS manifest references unknown lookup "${lookupName}".`);
    }
    context[namespace] = await runLookupSource(lookup.source, context, undefined, signal);
  }

  const derive = buildDeriveNamespace(inputs, user);
  context.derive = derive;

  applyDataRules(manifest.rules, inputs, derive.effectiveDays as number, context);

  context.serial = await fetchNextSerialNumber(
    manifest.serialAppElementId,
    manifest.appId,
    user.organizationId,
    signal,
  );

  const payload: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.payload)) {
    payload[key] = renderValue(spec, context);
  }

  const { appDataId } = await saveAppData(manifest.submitPath, payload, signal);

  return {
    recordId: context.serial,
    appDataId,
    summary: {
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
