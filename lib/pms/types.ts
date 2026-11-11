// Shared shape of the PMS manifest bundle. The bundle is DATA: it describes
// PMS actions (forms) and lookups declaratively, and is served to the Chrome
// extension at runtime via GET /api/pms/manifests. The extension contains
// only a generic interpreter, so changing/adding actions here needs a server
// deploy, never an extension re-zip.
//
// NOTE: this file is duplicated (kept in sync by hand) at
// chrome-extension/src/pms/types.ts — same convention as protocol.ts.

/** A value in the final payload: a constant, or a dotted-path reference into
 * the execution context (namespaces: input.*, user.*, plus one namespace per
 * entry in the manifest's `resolvers` map, and derive.* / serial).
 * format "quixyDateTime" re-emits a date string with Quixy's two-decimal
 * seconds suffix ("2024-06-16T18:30:00.00") — data-table rows return it
 * without the suffix but SaveAppData expects it. */
export type PmsValueSpec =
  | { const: unknown }
  | { ref: string; format?: "quixyDateTime" };

/** Quixy "Layer A" data primitives, parameterised by GUIDs. */
export interface PmsDataTableRowSource {
  kind: "dataTableRow"; // POST /api/DataTable/GetReferencedDataTableData
  dataTableId: string;
  functionId: string;
  referencedElements: string[];
  /** Column name the lookup is keyed on, e.g. "Employee Code". */
  keyReference: string;
  /** Context path providing the key value, e.g. "user.employeeCode". */
  keyRef: string;
}

export interface PmsDatasourceRowsSource {
  kind: "datasourceRows"; // POST /api/Datasource/GetReferencedDataSourceData
  dataSourceId: string;
  referenceId: string;
  outputColumns: string[];
  conditionLabel: string;
  keyRef: string;
  /** Return one projected row for an execution resolver. */
  single?: boolean;
}

/** A report column pms_lookup filters may target. `name` is the exact
 * LabelName the report's filter API expects (captured from live traffic). */
export interface PmsReportGridFilterField {
  name: string;
  /** text → equals/contains; date → between (YYYY-MM-DD, inclusive). */
  type: "text" | "date";
  /** Closed value set, when known (text fields only) — validated on equals. */
  values?: string[];
}

export interface PmsReportGridSource {
  kind: "reportGrid"; // POST /api/Report/GetGridReportData
  reportId: string;
  orderByFields: string;
  top: number;
  /** Columns filters may target; omit → the lookup accepts no filters. */
  filterableFields?: PmsReportGridFilterField[];
  /** Exact keys of the rows the report returns; enables `columns`
   * projection and documents the output shape in the capability catalog. */
  availableColumns?: string[];
}

export interface PmsIssueContextSource {
  kind: "issueContext";
  viewId: string;
  keyRef: string;
  availableColumns: string[];
}

export interface PmsLookupOptionsSource {
  kind: "lookupOptions";
  lookupTypeId: string;
}

export interface PmsWorklogReportSource {
  kind: "worklogReport";
  reportId: string;
  viewId: string;
  keyRef: string;
  availableColumns: string[];
}

export interface PmsCalendarSource {
  kind: "calendar";
  calendarId: string;
}

export interface PmsDailyWorklogsSource {
  kind: "dailyWorklogs";
  dataTableId: string;
  functionId: string;
  referencedElements: string[];
  availableColumns: string[];
}

export interface PmsAttendanceSource {
  kind: "attendanceReport";
  reportId: string;
  availableColumns: string[];
}

export interface PmsIssueTransitionsSource {
  kind: "issueTransitions";
  detailFields: string[];
  viewId: string;
  appId: string;
}

export interface PmsTransitionDetail {
  field: string;
  value: string | null;
  values: string[] | null;
}

export type PmsLookupSource =
  | PmsDataTableRowSource
  | PmsDatasourceRowsSource
  | PmsReportGridSource
  | PmsIssueContextSource
  | PmsLookupOptionsSource
  | PmsWorklogReportSource
  | PmsCalendarSource
  | PmsDailyWorklogsSource
  | PmsAttendanceSource
  | PmsIssueTransitionsSource;

export interface PmsLookupDefinition {
  description: string;
  /** true → Donna may call it standalone via the pms_lookup tool. */
  queryable: boolean;
  source: PmsLookupSource;
}

/** One pms_lookup filter. Filters run server-side (reportGrid lookups only);
 * `field` must name one of the source's filterableFields. */
export interface PmsLookupFilter {
  field: string;
  /** equals/contains for text fields; between for date fields. */
  operator: "equals" | "contains" | "between";
  /** Text value, or range start (YYYY-MM-DD) for between. */
  value: string;
  /** Range end (YYYY-MM-DD) for between; omit to filter a single day. */
  secondValue?: string;
}

/** Optional per-call query options on pms_lookup. Column projection is
 * applied in the extension before rows reach the model, so it saves context
 * tokens on every lookup kind; filters additionally save the fetch itself. */
export interface PmsLookupQuery {
  newStatus?: string;
  details?: PmsTransitionDetail[];
  /** Attendance business date, YYYY-MM-DD in India. */
  date?: string;
  /** Full issue ID or unique numeric suffix; used only by issue lookups. */
  issueId?: string;
  /** India calendar date for daily worklog totals. */
  logDate?: string;
  filters?: PmsLookupFilter[];
  columns?: string[];
  /** Max rows to return (default and hard cap: the executor's row cap). */
  top?: number;
}

export interface PmsInputSlot {
  name: string;
  label: string;
  type: "enum" | "date" | "string" | "boolean" | "details";
  options?: string[];
  required: boolean;
  maxLength?: number;
  description: string;
}

/** Declarative business rules, evaluated by the extension's executor before
 * submit. `field`/`when.field` name input slots; `limitRef` is a context
 * path resolved after execution resolvers ran. */
export type PmsRule =
  | {
      kind: "requiredIf";
      field: string;
      when: { field: string; equals: string };
      message: string;
    }
  | {
      kind: "forceValue";
      field: string;
      when: { field: string; equals: string };
      value: string;
      message: string;
    }
  | {
      kind: "sameMonthRange";
      fromField: string;
      toField: string;
      maxEndDay: number;
      message: string;
    }
  | {
      kind: "maxEffectiveDays";
      when: { field: string; equals: string };
      limitRef: string;
      message: string;
    }
  | { kind: "mustBeTrue"; field: string; message: string };

export interface PmsActionManifest {
  title: string;
  description: string;
  appId: string;
  appName: string;
  /** GET /api/App/GetNextSerialNumber parameter. */
  serialAppElementId?: string;
  /** Selects the supported computed-field strategy. */
  derive?: "leave" | "worklog" | "statusChange";
  /** Execution resolvers: context namespace → lookup name in the bundle. */
  resolvers: Record<string, string>;
  inputs: PmsInputSlot[];
  rules: PmsRule[];
  /** The full submit body; key order and misspellings are load-bearing. */
  payload: Record<string, PmsValueSpec>;
  /** Path+query for the final POST. */
  submitPath: string;
}

export interface PmsBundle {
  version: number;
  lookups: Record<string, PmsLookupDefinition>;
  actions: Record<string, PmsActionManifest>;
}
