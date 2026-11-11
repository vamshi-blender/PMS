import type { PmsIssueTransitionsSource, PmsTransitionDetail } from "./types";
import { postJson } from "./primitives";
import { fetchCategoryLabels, normalizeIssueId, resolveIssue } from "./worklog";
import { nowUtcMinute } from "./derive";
import { empty, evaluateStatusForm, type StatusElement, type StatusForm } from "./status-rules";

export function parseTransitionDetails(value: unknown): PmsTransitionDetail[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error("Invalid transition details.");
  const seen = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || typeof entry.field !== "string" || seen.has(entry.field) ||
        Object.keys(entry).some(key => !["field", "value", "values"].includes(key)) ||
        !((typeof entry.value === "string" && entry.values === null) ||
          (entry.value === null && Array.isArray(entry.values) && entry.values.every((v: unknown) => typeof v === "string")))) {
      throw new Error("Each transition detail needs a unique field and either text value or selected values.");
    }
    seen.add(entry.field);
    return { field: entry.field, value: entry.value, values: entry.values };
  });
}

async function referenceRows(form: StatusForm, field: string, keys: Record<string, string>, signal?: AbortSignal) {
  const reference = form.AppSections.flatMap(section => section.AppElements).find(element => element.FieldName === field)?.DataTableReference;
  if (!reference) throw new Error(`PMS form is missing reference ${field}.`);
  const data = await postJson("/api/DataTable/GetReferencedDataTableData", {
    DataTableId: reference.DataTableId, DataTableFunctionId: reference.DataTableFunctionId,
    ReferencedElements: reference.ReferencedElements,
    DataTableDataReferenceDataDTOs: Object.entries(keys).map(([ReferenceName, Value]) => ({ ReferenceName, IsFocused: true, Value })),
  }, signal);
  if (!Array.isArray(data) || data.some(row => !Array.isArray(row) || row.some(cell => !cell || typeof cell.Name !== "string"))) throw new Error("Invalid PMS reference data.");
  return data.map(row => Object.fromEntries(row.map((cell: { Name: string; Value: unknown }) => [cell.Name, cell.Value])));
}

export async function readStatusContext(source: PmsIssueTransitionsSource, issueId: unknown, user: Record<string, string>, signal?: AbortSignal) {
  const issue = await resolveIssue(source.viewId, issueId, signal, ["Detection Phase", "Sprint Name"]);
  if (!issue.Status) throw new Error("PMS did not return a current issue status.");
  const form = await postJson("/api/App/GetAppWithPermissions", {
    appId: source.appId, currentStep: 0, emailId: user.emailId, initiatorEmailId: "", ignoreAccess: false,
    groupNumber: 0, roleName: "", managerType: "", isView: false, nextGroupName: "", isReportView: "",
  }, signal) as StatusForm;
  if (form?.AppId !== source.appId || !Array.isArray(form.AppSections) || !Array.isArray(form.Rules) ||
      form.AppSections.some(section => !Array.isArray(section.AppElements))) throw new Error("Invalid status form definition.");
  const reference = form.AppSections.flatMap(section => section.AppElements).find(element => element.FieldName === "Project Id")?.DataTableReference;
  if (!reference) throw new Error("The status-flow reference is unavailable.");
  const data = await postJson("/api/DataTable/GetDataTableDataByReference", {
    DataTableId: reference.DataTableId, DataTableFunctionId: reference.DataTableFunctionId, ReferencedElements: reference.ReferencedElements,
    DataTableDataReferenceDataDTOs: [
      { IsFocused: false, ReferenceName: "Project Id", Value: issue["Project Id"], SelectedValue: "" },
      { IsFocused: false, ReferenceName: "Issue Type", Value: issue["Issue Type"], SelectedValue: "" },
      { IsFocused: false, ReferenceName: "Current Status", Value: issue.Status, SelectedValue: "" },
      { IsFocused: true, ReferenceName: "Next Status", Value: "", SelectedValue: "" },
    ],
  }, signal);
  if (!Array.isArray(data) || data.some(item => typeof item?.AppData !== "string")) throw new Error("Invalid allowed-status response.");
  return { issue, form, allowedStatuses: [...new Set(data.map(item => item.AppData as string))] };
}

function seedValues(form: StatusForm, issue: Record<string, string>, user: Record<string, string>, newStatus: string) {
  const values: Record<string, unknown> = {};
  for (const element of form.AppSections.flatMap(section => section.AppElements)) {
    values[element.FieldName] = ["Grid", "FileUpload", "MultiSelectDropDown"].includes(element.ElementType) ? [] : "";
  }
  Object.assign(values, {
    "var Project Id": issue["Project Id"], "var Issue Record Id": issue["Record Id"], "var Issue Id": issue["Issue Id"],
    "var Issue Type": issue["Issue Type"], "var Current Assignee": issue.Assignee, "var Issue Current Status": issue.Status,
    "var Summary": issue.Summary, "Project Id": issue["Project Id"], "Issue Type": issue["Issue Type"], "Current Status": issue.Status,
    "New Status": newStatus, "Detection Phase": issue["Detection Phase"], "Sprint Name": issue["Sprint Name"],
    "Status": null, "Issue Id": null, "Issue Id for watch": null, "Assignee Story Points": null,
    "Story points Issue Id": issue["Issue Id"], "Get Assignee Story Points": "", "Story Sub Task Id": null,
    "Get ready for QA Issue id": null, "Var Sub Task Id": issue["Issue Type"] === "Bug" ? issue["Record Id"] : "",
    "Release Datetime": nowUtcMinute(), "Updated Date Time": nowUtcMinute(),
    "Logged In User Name": user.fullName, "Status Changed User": user.emailId,
    "status Indicator Project Id": issue["Project Id"], "status Indicator Issue Type": issue["Issue Type"],
    "status Indicator Status": newStatus, "Status Indicator": newStatus,
  });
  return values;
}

async function detailOptions(element: StatusElement, signal?: AbortSignal): Promise<string[] | undefined> {
  if (!["Radio", "DropDown", "MultiSelectDropDown"].includes(element.ElementType)) return undefined;
  if (!element.LookUpType) throw new Error(`No options are available for ${element.LabelName}.`);
  return /^\d{8}-/.test(element.LookUpType)
    ? (await fetchCategoryLabels(element.LookUpType, signal)).values
    : element.LookUpType.split(",");
}

export async function prepareStatusChange(
  source: PmsIssueTransitionsSource, inputs: Record<string, unknown>, user: Record<string, string>, signal?: AbortSignal,
  forExecution = false,
) {
  if (forExecution) normalizeIssueId(inputs.issueId, true);
  const context = await readStatusContext(source, inputs.issueId, user, signal);
  const { issue, form, allowedStatuses } = context;
  const target = typeof inputs.newStatus === "string" ? inputs.newStatus : "";
  if (forExecution && (issue.Status !== inputs.currentStatus || issue.Summary !== inputs.issueSummary)) throw new Error("Issue status or summary changed. Look up the transition again and request a fresh approval.");
  if (target && !allowedStatuses.includes(target)) throw new Error(`Cannot move ${issue["Issue Id"]} from ${issue.Status} to ${target}. Allowed: ${allowedStatuses.join(", ") || "none"}.`);
  if (!target) return { context, publicResult: { issueId: issue["Issue Id"], summary: issue.Summary, currentStatus: issue.Status, allowedStatuses }, values: {} };
  const values = seedValues(form, issue, user, target);
  const elements = form.AppSections.flatMap(section => section.AppElements);
  for (const detail of parseTransitionDetails(inputs.details)) {
    if (!source.detailFields.includes(detail.field)) throw new Error(`Unsupported transition detail: ${detail.field}.`);
    const element = elements.find(element => element.FieldName === detail.field);
    if (!element) throw new Error(`PMS no longer supports ${detail.field}.`);
    const value = detail.values ?? detail.value;
    if ((element.ElementType === "MultiSelectDropDown") !== Array.isArray(value)) throw new Error(`Invalid value type for ${detail.field}.`);
    const options = await detailOptions(element, signal);
    if (options && (Array.isArray(value) ? value : [value]).some(item => !options.includes(String(item)))) throw new Error(`Invalid choice for ${detail.field}. Read the current options first.`);
    if (detail.field === "Estimated Hours" && !/^\d+(\.\d+)?$/.test(String(value))) throw new Error("Estimated Hours must be nonnegative decimal hours.");
    if (element.ElementType === "DateTime") {
      if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${detail.field} requires an ISO datetime including timezone.`);
      values[detail.field] = nowUtcMinute(new Date(value));
    } else values[detail.field] = value;
  }
  // Resolve server-owned dependencies rather than asking Donna to invent them.
  const stories = await referenceRows(form, "Story points Issue Id", { "Issue Id": issue["Issue Id"] }, signal);
  values["Get Assignee Story Points"] = stories[0]?.["Assignee Story Points"] ?? "";
  if (issue["Issue Type"] === "Bug") {
    const rca = await referenceRows(form, "Issue Id", { "Issue Id": issue["Issue Id"] }, signal);
    values.Status = rca[0]?.Status ?? null;
    values["Issue Id"] = rca.length ? issue["Issue Id"] : null;
    values["Story Sub Task Id"] = issue["Record Id"];
    const subtask = await referenceRows(form, "Story Sub Task Id", { "Sub Task Id": issue["Record Id"] }, signal);
    values["Sub task Story Points"] = subtask[0]?.["Story Points"] ?? "";
  }
  const evaluated = evaluateStatusForm(form, values);
  const fields = await Promise.all(elements.filter(element => source.detailFields.includes(element.FieldName) && evaluated.visible.get(element.FieldName)).map(async element => ({
    field: element.FieldName, label: element.LabelName, type: element.ElementType,
    required: evaluated.required.has(element.FieldName), options: await detailOptions(element, signal),
  })));
  const unsupported = elements.filter(element =>
    (evaluated.required.has(element.FieldName) && !source.detailFields.includes(element.FieldName) && empty(evaluated.values[element.FieldName])) ||
    (evaluated.visible.get(element.FieldName) && element.ElementType === "UserReference"));
  const publicResult = {
    issueId: issue["Issue Id"], summary: issue.Summary, currentStatus: issue.Status, allowedStatuses, newStatus: target,
    fields, validationErrors: evaluated.errors,
    requiresPmsForm: unsupported.map(element => element.LabelName),
  };
  if (forExecution) {
    if (unsupported.length) throw new Error(`Complete this transition in PMS: ${unsupported.map(element => element.LabelName).join(", ")}.`);
    if (evaluated.errors.length) throw new Error(evaluated.errors.map(error => `${error.field}: ${error.message}`).join("; "));
    const indicator = await referenceRows(form, "status Indicator Project Id", { "Issue Type": issue["Issue Type"], Status: target, "Project Id": issue["Project Id"] }, signal);
    if (indicator.length !== 1 || typeof indicator[0]["Status Indicator"] !== "string" || !indicator[0]["Status Indicator"]) throw new Error("PMS did not resolve a status indicator.");
    evaluated.values["Status Indicator"] = indicator[0]["Status Indicator"];
    const watchers = await referenceRows(form, "Issue Id for watch", { "Issue Id": issue["Issue Id"] }, signal);
    evaluated.values["Watch List Details"] = watchers;
    evaluated.values["Issue Id for watch"] = watchers.length ? issue["Issue Id"] : null;
    if (target === "Ready for QA" && issue["Issue Type"] === "Improvement") {
      const rows = await referenceRows(form, "Get ready for QA Issue id", { "Issue id": issue["Issue Id"] }, signal);
      evaluated.values["Get ready for QA Issue id Grid"] = rows;
      evaluated.values["Get ready for QA Issue id"] = rows.length ? issue["Issue Id"] : null;
    }
  }
  return { context, publicResult, values: evaluated.values };
}
