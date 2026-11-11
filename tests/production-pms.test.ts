import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getPmsBundle } from "../lib/pms/bundle";
import { pmsFormHash } from "../shared/pms-form-contract";
import { pmsFetch } from "../chrome-extension/src/api/pmsAuth";
import { executePmsAction, runPmsLookup } from "../chrome-extension/src/pms/executor";
import capturedStatusForm from "./fixtures/status-form.json";

let bundle: ReturnType<typeof getPmsBundle>;
let form: Record<string, unknown>;
let writes: Record<string, unknown>[];
let rows: Record<string, unknown>[];
const cells = (row: Record<string, unknown>) => Object.entries(row).map(([Name, Value]) => ({ Name, Value }));

vi.mock("../chrome-extension/src/pms/bundle", () => ({ getPmsBundle: async () => bundle }));
vi.mock("../chrome-extension/src/api/pmsAuth", () => ({
  getPmsUserDetails: async () => ({ employeeCode: "E1", userId: "user", email: "person@example.com", fullName: "Person", organizationId: "org" }),
  pmsFetch: vi.fn(),
}));
const mockFetch = vi.mocked(pmsFetch);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  bundle = structuredClone(getPmsBundle("production"));
  writes = []; rows = [{ Date: "2026-11-11T00:00:00", Autogenerate: "" }];
  form = { AppId: bundle.actions.create_leave_application.appId, OrganizationId: "org", WorkSpaceId: "workspace", Rules: [],
    AppSections: [{ AppElements: [{ FieldName: "EmployeeId unblock", ElementType: "DataSourceReference", DataSourceReference: {
      DataSourceId: "verified-table", DataSourceReferenceId: "verified-function", ReferencedElements: "Date,Autogenerate,Unblocked Datetime,EmployeeId Grid",
    } }] }],
  };
  mockFetch.mockReset().mockImplementation(async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.includes("GetAppWithPermissions")) return Response.json(form);
    if (path.includes("GetNextSerialNumber")) return new Response("VM/LAP/TEST");
    if (path.includes("SaveAppData")) { writes.push(body); return Response.json({ Success: true, Data: "saved" }); }
    if (path.includes("GetReferencedDataTableData")) {
      if (body.ReferencedElements === "Status Indicator") return Response.json([cells({ "Status Indicator": "Resolved" })]);
      if (body.ReferencedElements.includes("Date of Joining")) return Response.json([cells({ "Date of Joining": "2020-01-01", Department: "Engineering", Designation: "Developer", DOB: "1990-01-01", "Full Name": "Person" })]);
      if (body.ReferencedElements.includes("Balance Leaves")) return Response.json([cells({ "Balance Leaves": "10", "Entitled Leaves": "12", "Used Leaves": "2", "Optional Balance": "2", "Used Optional": "0", "Optional Leaves Track": "0" })]);
      return Response.json([]);
    }
    if (path.includes("GetReferencedDataSourceData")) return Response.json(body.DataSourceId === "verified-table" ? rows.map(cells) : [cells({ Department: "Engineering" })]);
    if (path.includes("GetViewResult")) return Response.json({ Status: true, __count: 1, results: JSON.stringify([{ "Issue Id": "QKA-49715", "Record Id": "1", "Project Id": "70", "Issue Type": "Task", Assignee: "person@example.com", Summary: "Task", Status: "In Progress" }]) });
    if (path.includes("GetDataTableDataByReference")) return Response.json([{ AppData: "Resolved" }]);
    if (path.includes("GetListReportData")) return Response.json({ Status: false, __count: 1, results: JSON.stringify([{ "Issue Id": "QKA-49715", "Worklog Hours": "2" }]) });
    if (path.includes("GetLookupType")) return Response.json({ LookupValues: [{ LookupValue: "Development", IsDeleted: false }] });
    if (path.includes("GetCurrentUTC")) return Response.json("2026-11-11T10:00:00Z");
    if (path.includes("GetCalendarHolidays")) return Response.json([]);
    if (path.includes("GetCalendar")) return Response.json({ CalendarWorkingHours: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map(Day => ({ Day })) });
    throw new Error("Unexpected API " + path);
  });
});
afterEach(() => vi.useRealTimers());

const leave = { leaveType: "PL", fromDate: "2026-11-11", toDate: "2026-11-11", halfDay: "No", halfDayType: null, reason: "Personal work", contactNumber: "9999999999", acknowledgment: true };
async function verify(action: string) { bundle.actions[action].formHash = await pmsFormHash(form); }

it("submits production leave with server-owned backdate validation and a serial number", async () => {
  await verify("create_leave_application");
  await executePmsAction("create_leave_application", leave);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ "EmployeeId unblock": "E1", Validation: [{ Date: "2026-11-11T00:00:00", Autogenerate: "", "Day Diff": 0, Status: "Enabled" }] });
});

it("rejects old blocked leave before allocating a serial, and accepts HR-unblocked dates", async () => {
  await verify("create_leave_application");
  rows = [{ Date: "2026-11-01T00:00:00", Autogenerate: "" }];
  const inputs = { ...leave, fromDate: "2026-11-01", toDate: "2026-11-01" };
  await expect(executePmsAction("create_leave_application", inputs)).rejects.toThrow("seven days");
  expect(mockFetch.mock.calls.some(([path]) => path.includes("GetNextSerialNumber"))).toBe(false);
  rows[0].Autogenerate = "server-unblock-record";
  await executePmsAction("create_leave_application", inputs);
  expect(writes[0].Validation).toMatchObject([{ Status: "Unblocked", "Day Diff": 10 }]);
});

it("refuses changed production forms and incomplete date validation before writing", async () => {
  await verify("create_leave_application"); form.Rules = [{ Name: "New policy" }];
  await expect(executePmsAction("create_leave_application", leave)).rejects.toThrow("form changed");
  form.Rules = []; rows = [];
  await expect(executePmsAction("create_leave_application", leave)).rejects.toThrow("incomplete");
  expect(writes).toHaveLength(0);
});

it("submits a verified production issue transition once and rechecks the issue", async () => {
  form = { ...structuredClone(capturedStatusForm), OrganizationId: "org" };
  await verify("change_issue_status");
  await executePmsAction("change_issue_status", { issueId: "QKA-49715", issueSummary: "Task", currentStatus: "In Progress", newStatus: "Resolved", details: null });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ "New Status": "Resolved", _AppName: "Change Issue Status" });
  expect(mockFetch.mock.calls.filter(([path]) => path.includes("GetViewResult"))).toHaveLength(2);
});

it("submits a verified production worklog with billable hours defaulted and no serial call", async () => {
  form.AppId = bundle.actions.add_worklog.appId;
  await verify("add_worklog");
  await executePmsAction("add_worklog", { issueId: "QKA-49715", issueSummary: "Task", logDate: "2026-11-11", category: "Development", logHours: "2", billableHours: null, description: "Development work" });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ "Billable Hours": "2", "Log Hours": "2", _AppName: "Worklog" });
  expect(mockFetch.mock.calls.some(([path]) => path.includes("GetNextSerialNumber"))).toBe(false);
});

it("reads production issue worklogs with Status=false and valid report rows", async () => {
  const result = await runPmsLookup("getIssueWorklogs", { issueId: "QKA-49715" });
  expect(result).toMatchObject({ rows: [{ "Issue Id": "QKA-49715", "Worklog Hours": "2" }] });
});
