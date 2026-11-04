// Quixy's generic data-transport calls ("Layer A"). Every PMS data fetch and
// the final submit go through these thin wrappers; which GUIDs/columns they
// are called with comes from the server-hosted manifest bundle. Request
// shapes are verbatim from recorded form traffic.
import { pmsFetch } from "../api/pmsAuth";
import type {
  PmsDataTableRowSource,
  PmsDatasourceRowsSource,
  PmsReportGridSource,
} from "./types";

type NameValue = { Name?: unknown; Value?: unknown };

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
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
