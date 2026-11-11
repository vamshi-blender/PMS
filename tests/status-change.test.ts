import { beforeEach, expect, it, vi } from "vitest";
import capturedForm from "./fixtures/status-form.json";
import { getPmsBundle } from "../lib/pms/bundle";
import { pmsFetch } from "../chrome-extension/src/api/pmsAuth";
import { executePmsAction, runPmsLookup } from "../chrome-extension/src/pms/executor";
import type { StatusForm } from "../chrome-extension/src/pms/status-rules";

vi.mock("../chrome-extension/src/pms/bundle", () => ({ getPmsBundle: async () => getPmsBundle() }));
vi.mock("../chrome-extension/src/api/pmsAuth", () => ({
  getPmsUserDetails: async () => ({ employeeCode: "E1", userId: "user-1", email: "person@example.com", fullName: "Test Person", organizationId: "org-1" }),
  pmsFetch: vi.fn(),
}));
const mockFetch = vi.mocked(pmsFetch);
const inputs = { issueId: "QKA-49715", issueSummary: "Team Cordination", currentStatus: "In Progress", newStatus: "Resolved", details: null };
let issue: Record<string, unknown>;
let form: StatusForm;
let allowed: string[];
let writes: Record<string, unknown>[];
let rca: boolean;
const detail = (field: string, value: string | string[]) => ({ field, value: typeof value === "string" ? value : null, values: Array.isArray(value) ? value : null });

beforeEach(() => {
  issue = { "Issue Id": "QKA-49715", "Record Id": "63798", "Project Id": "70", "Issue Type": "Task", Status: "In Progress", Summary: "Team Cordination", Assignee: "owner@example.com" };
  form = structuredClone(capturedForm) as StatusForm;
  allowed = ["Resolved"]; writes = []; rca = false;
  mockFetch.mockReset().mockImplementation(async (path, init) => {
    init?.signal?.throwIfAborted();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(path).includes("GetViewResult")) return Response.json({ Status: true, results: JSON.stringify([issue]), __count: 1 });
    if (String(path).includes("GetAppWithPermissions")) return Response.json(form);
    if (String(path).includes("GetDataTableDataByReference")) return Response.json(allowed.map(AppData => ({ AppData })));
    if (String(path).includes("GetReferencedDataTableData")) {
      if (body.ReferencedElements === "Status Indicator") return Response.json([[{ Name: "Status Indicator", Value: body.DataTableDataReferenceDataDTOs.find((key: { ReferenceName: string }) => key.ReferenceName === "Status").Value }]]);
      if (body.ReferencedElements === "Status") return Response.json(rca ? [[{ Name: "Status", Value: "Updated" }]] : []);
      return Response.json([]);
    }
    if (String(path).includes("GetLookupType")) return Response.json({ LookupValues: ["development", "API"].map(LookupValue => ({ LookupValue, IsDeleted: false })) });
    if (String(path).includes("SaveAppData")) { writes.push(body); return Response.json({ Success: true, Data: "saved-transition" }); }
    throw new Error("Unexpected API call " + path);
  });
});

it("reads allowed next statuses with project, type and current status", async () => {
  expect(await runPmsLookup("getAllowedIssueStatuses", { issueId: "49715" })).toMatchObject({ currentStatus: "In Progress", allowedStatuses: ["Resolved"] });
  const call = mockFetch.mock.calls.find(([path]) => String(path).includes("GetDataTableDataByReference"))!;
  expect(JSON.parse(String(call[1]?.body)).DataTableDataReferenceDataDTOs).toEqual([
    { IsFocused: false, ReferenceName: "Project Id", Value: "70", SelectedValue: "" },
    { IsFocused: false, ReferenceName: "Issue Type", Value: "Task", SelectedValue: "" },
    { IsFocused: false, ReferenceName: "Current Status", Value: "In Progress", SelectedValue: "" },
    { IsFocused: true, ReferenceName: "Next Status", Value: "", SelectedValue: "" },
  ]);
  expect(writes).toHaveLength(0);
});

it("submits the captured status payload once without leave/worklog calculations", async () => {
  const result = await executePmsAction("change_issue_status", inputs);
  expect(result).toMatchObject({ recordId: "saved-transition", summary: { issueId: "QKA-49715", previousStatus: "In Progress", status: "Resolved" } });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    "var Issue Record Id": "63798", "var Project Id": "70", "var Issue Id": "QKA-49715", "var Summary": "Team Cordination",
    "Project Id": "70", "Issue Type": "Task", "Current Status": "In Progress", "New Status": "Resolved",
    "status Indicator Status": "Resolved", "Status Indicator": "Resolved", "Status Changed User": "person@example.com",
    "Issue Id": null, "Watch List Details": [], "Select Branch": [], "Configurations Files": [],
    _AppName: "Change Issue Status", _IsCompleted: true, _NextGroupName: "Done", _CreatedLocation: "", _WorkFlowAction: "Start - Submit",
  });
  expect(mockFetch.mock.calls.some(([path]) => String(path).includes("GetNextSerialNumber"))).toBe(false);
});

it("rejects unavailable transitions, stale approvals and bare-number submissions", async () => {
  await expect(executePmsAction("change_issue_status", { ...inputs, newStatus: "Closed" })).rejects.toThrow("Allowed: Resolved");
  await expect(executePmsAction("change_issue_status", { ...inputs, currentStatus: "New" })).rejects.toThrow("fresh approval");
  await expect(executePmsAction("change_issue_status", { ...inputs, issueId: "49715" })).rejects.toThrow("full issue ID");
  expect(writes).toHaveLength(0);
});

it("requires remarks for Design Completed to Design Review, then accepts them", async () => {
  issue.Status = "Design Completed"; allowed = ["Design Review"];
  const fields = { ...inputs, currentStatus: "Design Completed", newStatus: "Design Review" };
  await expect(executePmsAction("change_issue_status", fields)).rejects.toThrow("Add comments");
  await executePmsAction("change_issue_status", { ...fields, details: [detail("Change Remarks", "Review requested")] });
  expect(writes[0]["Change Remarks"]).toBe("Review requested");
});

it("does not make estimated hours mandatory merely because the UI shows it", async () => {
  issue["Issue Type"] = "Bug"; issue.Status = "New"; allowed = ["In Progress"];
  const lookup = await runPmsLookup("getAllowedIssueStatuses", { issueId: "QKA-49715", newStatus: "In Progress" }) as { fields: { field: string; required: boolean }[] };
  expect(lookup.fields.find(field => field.field === "Estimated Hours")?.required).toBe(false);
});

const fixedDetails = () => [detail("Select Branch", ["development"]), detail("Select Required Components", ["API"]), detail("Any configuration changes made", "No"), detail("Any DB Scripts Exists", "No"), detail("Specify Impact Feature Related To Bug", "API validation")];
it("validates bug-fix fields and RCA instead of accepting model assertions", async () => {
  issue["Issue Type"] = "Bug"; allowed = ["Fixed"];
  const fields = { ...inputs, newStatus: "Fixed" };
  await expect(executePmsAction("change_issue_status", fields)).rejects.toThrow("Select Branch");
  await expect(executePmsAction("change_issue_status", { ...fields, details: fixedDetails() })).rejects.toThrow("update RCA");
  rca = true;
  await executePmsAction("change_issue_status", { ...fields, details: fixedDetails() });
  expect(writes[0]).toMatchObject({ Status: "Updated", "New Status": "Fixed", "Select Branch": ["development"] });
});

it("requires configuration and DB descriptions only when their answers are Yes", async () => {
  issue["Issue Type"] = "Bug"; allowed = ["Fixed"]; rca = true;
  const details = fixedDetails().map(item => ["Any configuration changes made", "Any DB Scripts Exists"].includes(item.field) ? detail(item.field, "Yes") : item);
  await expect(executePmsAction("change_issue_status", { ...inputs, newStatus: "Fixed", details })).rejects.toThrow("configuration change");
  await executePmsAction("change_issue_status", { ...inputs, newStatus: "Fixed", details: [...details, detail("Specify the configuration change", "Updated timeout"), detail("Mention the DB script", "Migration 42")] });
  expect(writes).toHaveLength(1);
});

it("blocks transitions requiring uploads rather than fabricating file metadata", async () => {
  issue["Issue Type"] = "Improvement"; allowed = ["Coding review"];
  await expect(executePmsAction("change_issue_status", { ...inputs, newStatus: "Coding review", details: [detail("Configurations", "No"), detail("Scripts", ["Migration"]), detail("Environment level", "Static"), detail("Migration scripts", "Migration 42")] })).rejects.toThrow("Migration files");
  expect(writes).toHaveLength(0);
});

it("supports coding review when no configuration or database files are needed", async () => {
  issue["Issue Type"] = "Improvement"; allowed = ["Coding review"];
  await executePmsAction("change_issue_status", { ...inputs, newStatus: "Coding review", details: [
    detail("Configurations", "No"), detail("Scripts", ["No DB Scripts"]), detail("Environment level", "Static"),
  ] });
  expect(writes[0]).toMatchObject({ Configurations: "No", Scripts: ["No DB Scripts"], "Environment level": "Static" });
});

it("rejects unknown choices and unsupported future validation rules", async () => {
  issue["Issue Type"] = "Bug"; allowed = ["Fixed"]; rca = true;
  await expect(executePmsAction("change_issue_status", { ...inputs, newStatus: "Fixed", details: [detail("Select Branch", ["guessed"])] })).rejects.toThrow("Invalid choice");
  form.Rules.find(rule => rule.Type === "Validation")!.RuleBlocks[0].Conditions[0].Operator = "New unsupported operator";
  await expect(executePmsAction("change_issue_status", { ...inputs, newStatus: "Fixed", details: fixedDetails() })).rejects.toThrow("Unsupported PMS condition");
  expect(writes).toHaveLength(0);
});

it("rechecks issue state immediately before saving", async () => {
  const implementation = mockFetch.getMockImplementation()!; let reads = 0;
  mockFetch.mockImplementation(async (path, init) => {
    if (String(path).includes("GetViewResult") && ++reads === 2) issue.Status = "Closed";
    return implementation(path, init);
  });
  await expect(executePmsAction("change_issue_status", inputs)).rejects.toThrow("changed while preparing");
  expect(writes).toHaveLength(0);
});

it("supports cancellation and never retries an uncertain save", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(executePmsAction("change_issue_status", inputs, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(writes).toHaveLength(0);
  const implementation = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (path, init) => { if (String(path).includes("SaveAppData")) throw new Error("Lost response"); return implementation(path, init); });
  await expect(executePmsAction("change_issue_status", inputs)).rejects.toThrow("Lost response");
  expect(mockFetch.mock.calls.filter(([path]) => String(path).includes("SaveAppData"))).toHaveLength(1);
});
