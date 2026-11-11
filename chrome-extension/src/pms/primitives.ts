// Quixy's generic data-transport calls ("Layer A"). Every PMS data fetch and
// the final submit go through these thin wrappers; which GUIDs/columns they
// are called with comes from the server-hosted manifest bundle. Request
// shapes are verbatim from recorded form traffic.
import { pmsFetch } from "../api/pmsAuth";
import type {
  PmsDataTableRowSource,
  PmsDatasourceRowsSource,
  PmsReportGridSource,
  PmsDailyWorklogsSource,
} from "./types";

type NameValue = { Name?: unknown; Value?: unknown };

export async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await pmsFetch(path, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`PMS call ${path} failed (${response.status}).`);
  }
  return response.json();
}

function rowToObject(row: NameValue[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const cell of row) {
    if (typeof cell?.Name === "string") result[cell.Name] = cell.Value;
  }
  return result;
}

/** GetReferencedDataTableData — dependent columns for one key value. */
export async function fetchDataTableRow(
  source: PmsDataTableRowSource,
  keyValue: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const data = await postJson("/api/DataTable/GetReferencedDataTableData", {
    DataTableId: source.dataTableId,
    DataTableFunctionId: source.functionId,
    ReferencedElements: source.referencedElements.join(","),
    DataTableDataReferenceDataDTOs: [
      { ReferenceName: source.keyReference, IsFocused: true, Value: keyValue },
    ],
  }, signal);
  const rows = Array.isArray(data) ? (data as NameValue[][]) : [];
  if (!rows[0]) {
    throw new Error(
      `PMS returned no ${source.keyReference} record for "${keyValue}".`,
    );
  }
  return rowToObject(rows[0]);
}

/** GetReferencedDataSourceData — datasource rows for given conditions. */
export async function fetchDatasourceRows(
  source: PmsDatasourceRowsSource,
  keyValue: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const data = await postJson("/api/Datasource/GetReferencedDataSourceData", {
    DataSourceId: source.dataSourceId,
    DataSourceReferenceId: source.referenceId,
    OutputColumns: source.outputColumns.join(","),
    DataSourceReferenceConditions: [
      {
        DataSourceCollectionConditionLabelName: source.conditionLabel,
        IsFocused: true,
        Value: keyValue,
      },
    ],
  }, signal);
  const rows = Array.isArray(data) ? (data as NameValue[][]) : [];
  return rows.map(rowToObject);
}

/** One entry of GetGridReportData's `filters` array — verbatim shape from
 * a captured filtered report call (2026-07-20). Text fields use
 * Equal/Contains with MappingType "Static"; date ranges use Condition
 * "Custom" with Quixy-UTC DefaultValue/SecondValue and MappingType "Mapped". */
export interface QuixyReportFilter {
  ElementType: "TextBox" | "Date";
  LabelName: string;
  Condition: "Equal" | "Contains" | "Custom";
  Type: "textType";
  DefaultValue: string;
  SecondValue: string;
  MappingType: "Static" | "Mapped";
}

/** GetGridReportData — rows of a datasource report (read-side screens). */
export async function fetchReportGrid(
  source: PmsReportGridSource,
  options?: { filters?: QuixyReportFilter[]; top?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>[]> {
  const data = await postJson("/api/Report/GetGridReportData", {
    reportId: source.reportId,
    skip: 0,
    top: options?.top ?? source.top,
    orderByFields: source.orderByFields,
    filters: options?.filters ?? [],
    groupAggregate: null,
    isShowGrid: false,
    isChartBasedReportGridCall: false,
  }, options?.signal);
  // The grid endpoint wraps its rows as a JSON string in `results`.
  const results = (data as { results?: unknown })?.results;
  if (typeof results !== "string") return [];
  const rows: unknown = JSON.parse(results);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** GetNextSerialNumber — server-side counter (plain-text response). */
export async function fetchNextSerialNumber(
  appElementId: string,
  appId: string,
  organizationId: string,
  signal?: AbortSignal,
): Promise<string> {
  const query = new URLSearchParams({ appElementId, appId, organizationId });
  const response = await pmsFetch(`/api/App/GetNextSerialNumber?${query}`, { signal });
  if (!response.ok) {
    throw new Error(`PMS serial number fetch failed (${response.status}).`);
  }
  const serial = (await response.text()).trim();
  if (!serial) throw new Error("PMS returned an empty serial number.");
  return serial;
}

export interface SaveAppDataResult {
  appDataId: string;
}

/** SaveAppData — the one write call; submits a fully built form payload. */
export async function saveAppData(
  submitPath: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SaveAppDataResult> {
  const data = (await postJson(submitPath, payload, signal)) as {
    Success?: unknown;
    Data?: unknown;
    ErrorMessage?: unknown;
  };
  if (data?.Success !== true) {
    const message =
      typeof data?.ErrorMessage === "string" && data.ErrorMessage
        ? data.ErrorMessage
        : "PMS rejected the submission.";
    throw new Error(message);
  }
  return { appDataId: typeof data.Data === "string" ? data.Data : "" };
}

export async function getPmsJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await pmsFetch(path, { signal });
  if (!response.ok) throw new Error(`PMS call ${path} failed (${response.status}).`);
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

export interface ReportPage {
  rows: Record<string, unknown>[];
  total?: number;
}

function reportPage(value: unknown, allowFalseStatus = false): ReportPage {
  const data = value as { Status?: unknown; results?: unknown; __count?: unknown; errorMessage?: unknown; ErrorMessage?: unknown };
  if ((data?.Status !== true && !(allowFalseStatus && data?.Status === false)) ||
      data.errorMessage || data.ErrorMessage || typeof data.results !== "string") {
    throw new Error("PMS returned an invalid report response.");
  }
  const rows: unknown = JSON.parse(data.results);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("PMS returned invalid report rows.");
  }
  return {
    rows,
    total: typeof data.__count === "number" ? data.__count : undefined,
  };
}

export async function fetchIssueCandidates(
  viewId: string, issueId: string, skip: number, signal?: AbortSignal,
): Promise<ReportPage> {
  const query = new URLSearchParams({ skip: String(skip), take: "100", viewId });
  return reportPage(await postJson(`/api/Report/GetViewResult?${query}`, {
    orderByFields: "",
    filters: {
      searchString: "", columns: "Issue Id,Summary,Issue Type,Assignee,Project Name,Status",
      groupedColumns: "", columnsOrder: "", resizedColumns: [], pageSize: 100,
      filters: [], sorting: [],
      CustomUserViewFilters: [{
        Order: 0, ColumnName: "Issue Id", ElementType: "TextBox",
        ConditionType: "Contains", Value: issueId, IsEditable: true,
        IsVisible: false, SecondValue: "", SelectedValues: [""],
      }],
    },
  }, signal));
}

export async function fetchIssueWorklogs(
  reportId: string, userId: string, issueId: string, signal?: AbortSignal,
): Promise<ReportPage> {
  return reportPage(await postJson("/api/Report/GetListReportData", {
    ReportId: reportId, UserId: userId,
    ListScreenReportFilters: [{ DataSourceCollectionConditionLabelName: "Issue Id", Value: issueId }],
    skip: 0, take: 100, IsFromReportMappingDrillDown: false, IsChartBasedReportGridCall: false,
  // Production returns Status=false with valid rows, as attendance does.
  // Keep issue searches strict; only this verified report accepts the flag.
  }, signal), true);
}

/** Attendance dates are literal business dates, not shifted Quixy datetimes.
 * Verified: shifting April 2 to April 1 18:30 returns both days. */
export async function fetchAttendanceReport(
  reportId: string, date: string, signal?: AbortSignal, toDate = date,
): Promise<ReportPage> {
  return fetchDateRangeReport(reportId, "Date", date, toDate, "Date desc", signal);
}

/** Worklog report dates use Quixy's shifted UTC representation. This differs
 * from the date-only attendance filter. Empty ordering is the verified report
 * default; unescaped column names containing spaces silently return no rows. */
export async function fetchWorklogRange(reportId: string, fromUtc: string, toUtc: string, signal?: AbortSignal): Promise<ReportPage> {
  return fetchDateRangeReport(reportId, "Worklog Date", fromUtc, toUtc, "", signal);
}

async function fetchDateRangeReport(reportId: string, label: string, fromDate: string, toDate: string, orderByFields: string, signal?: AbortSignal): Promise<ReportPage> {
  const rows: Record<string, unknown>[] = [];
  let expectedTotal: number | undefined;
  const pageSize = 500;
  for (let skip = 0; skip < 5000; skip += pageSize) {
    const data = await postJson("/api/Report/GetGridReportData", {
      reportId, skip, top: pageSize, orderByFields,
      filters: [{ ElementType: "Date", LabelName: label, Condition: "Custom", Type: "textType",
        DefaultValue: fromDate, SecondValue: toDate, MappingType: "Mapped" }],
      groupAggregate: null, isShowGrid: false, isChartBasedReportGridCall: false,
    }, signal) as { results?: unknown; errorMessage?: unknown; ErrorMessage?: unknown; __count?: unknown };
    // Both verified reports set Status=false even when their rows are valid.
    if (data?.errorMessage || data?.ErrorMessage || typeof data?.results !== "string") throw new Error("PMS could not retrieve the date-range report.");
    let page: unknown;
    try { page = JSON.parse(data.results); } catch { throw new Error("PMS returned invalid report data."); }
    if (!Array.isArray(page) || page.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("PMS returned invalid report rows.");
    const total = data.__count;
    if (total !== undefined && (typeof total !== "number" || !Number.isInteger(total) || total < 0)) throw new Error("PMS returned an invalid report count.");
    if (typeof total === "number") {
      if (expectedTotal !== undefined && total !== expectedTotal) throw new Error("PMS report changed during retrieval. Try again.");
      expectedTotal = total;
    }
    rows.push(...page as Record<string, unknown>[]);
    if (expectedTotal !== undefined && rows.length > expectedTotal) throw new Error("PMS returned inconsistent report rows.");
    if (expectedTotal === rows.length || (expectedTotal === undefined && page.length < pageSize)) return { rows, total: rows.length };
    if (page.length !== pageSize) throw new Error("PMS returned incomplete report data; no totals can be reported.");
  }
  throw new Error("Too many report entries. Use a shorter date range.");
}

/** All rows for one employee/date; unlike fetchDataTableRow, do not take only row 0. */
export async function fetchDailyWorklogs(
  source: PmsDailyWorklogsSource, email: string, date: string, signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  if (!email) throw new Error("The logged-in user's email is unavailable.");
  const data = await postJson("/api/DataTable/GetReferencedDataTableData", {
    DataTableId: source.dataTableId, DataTableFunctionId: source.functionId,
    ReferencedElements: source.referencedElements.join(","),
    DataTableDataReferenceDataDTOs: [
      { IsFocused: false, ReferenceName: "Worklog Date", Value: date, SelectedValue: date },
      { IsFocused: true, ReferenceName: "Worklog Email Id", Value: email, SelectedValue: "" },
    ],
  }, signal);
  if (!Array.isArray(data) || data.some(row => !Array.isArray(row) ||
      row.some(cell => !cell || typeof cell.Name !== "string" || !("Value" in cell)))) {
    throw new Error("PMS returned invalid daily worklogs; the total could not be calculated.");
  }
  return data.map(rowToObject);
}
