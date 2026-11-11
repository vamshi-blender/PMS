import { beforeEach, expect, it, vi } from "vitest";
import { getPmsBundle } from "../lib/pms/bundle";
import { pmsFetch } from "../chrome-extension/src/api/pmsAuth";
import { runPmsLookup } from "../chrome-extension/src/pms/executor";

vi.mock("../chrome-extension/src/pms/bundle", () => ({ getPmsBundle: async () => getPmsBundle() }));
vi.mock("../chrome-extension/src/api/pmsAuth", () => ({
  getPmsUserDetails: async () => ({ employeeCode: "E1", userId: "user", email: "person@example.com", fullName: "Person", organizationId: "org" }),
  pmsFetch: vi.fn(),
}));
let attendance: Record<string, unknown>[];
let worklogs: Record<string, unknown>[];
let countOverride: number | undefined;
const range = { fromDate: "2026-09-25", toDate: "2026-10-27", excludeWeekends: true };
const attendanceRow = (Date: string, hours: string | null = "09:30") => ({ Date, "Employee Code": "E1", "Total Hours": hours, Status: "-" });
const worklogRow = (date = "2026-09-24T18:30:00", hours: string | number = "1.5") => ({ "Worklog Date": date, "Worklog Hours": hours, "Email Id": "person@example.com", "Worklog Description": "Work" });

beforeEach(() => {
  attendance = [attendanceRow("2026-09-25")]; worklogs = [worklogRow()]; countOverride = undefined;
  vi.mocked(pmsFetch).mockReset().mockImplementation(async (path, init) => {
    const body = JSON.parse(String(init?.body));
    const source = getPmsBundle().lookups.getMyAttendance.source;
    const rows = source.kind === "attendanceReport" && body.reportId === source.reportId ? attendance : worklogs;
    if (path.includes("GetGridReportData")) return Response.json({ Status: false, results: JSON.stringify(rows.slice(body.skip, body.skip + body.top)), __count: countOverride ?? rows.length });
    if (path.includes("GetReferencedDataTableData")) return Response.json(worklogs.map(row => Object.entries(row).map(([Name, Value]) => ({ Name, Value }))));
    throw new Error("Unexpected call " + path);
  });
});

it("fetches the whole attendance range once and sends literal dates", async () => {
  const result = await runPmsLookup("getMyAttendance", range);
  expect(result).toMatchObject({ fromDate: range.fromDate, toDate: range.toDate, entryCount: 1, knownHours: 9.5, summariesComplete: true });
  expect(pmsFetch).toHaveBeenCalledOnce();
  const request = JSON.parse(String(vi.mocked(pmsFetch).mock.calls[0][1]?.body));
  expect(request.filters[0]).toMatchObject({ DefaultValue: "2026-09-25", SecondValue: "2026-10-27" });
});

it("returns full weekly/daily summaries, excludes weekends, and preserves unknown attendance", async () => {
  attendance = [attendanceRow("2026-09-25"), attendanceRow("2026-09-26", "04:00"), attendanceRow("2026-09-28", "08:15"), attendanceRow("2026-09-29", null)];
  const result = await runPmsLookup("getMyAttendance", { ...range, toDate: "2026-09-30", top: 1 });
  expect(result).toMatchObject({ entryCount: 3, excludedEntryCount: 1, knownHours: 17.75, totalHours: null, truncated: true, summariesComplete: true,
    datesWithoutEntries: ["2026-09-30"],
    weekly: [
      { weekStart: "2026-09-21", knownHours: 9.5, datesWithoutEntries: [] },
      { weekStart: "2026-09-28", knownHours: 8.25, datesWithoutEntries: ["2026-09-30"], datesWithUnknownHours: ["2026-09-29"] },
    ],
  });
  expect((result as { daily: unknown[] }).daily).toContainEqual({ date: "2026-09-30", entryCount: 0, totalHours: null, knownHours: 0 });
});

it("uses shifted Quixy bounds for worklogs and the verified report default ordering", async () => {
  const result = await runPmsLookup("getMyWorklogs", range);
  expect(result).toMatchObject({ totalHours: 1.5, entryCount: 1 });
  expect((result as { daily: unknown[] }).daily).toEqual(expect.arrayContaining([expect.objectContaining({ date: "2026-09-25", totalHours: 1.5 })]));
  const request = JSON.parse(String(vi.mocked(pmsFetch).mock.calls[0][1]?.body));
  expect(request.orderByFields).toBe("");
  expect(request.filters[0]).toMatchObject({ DefaultValue: "2026-09-24T18:30:00.00", SecondValue: "2026-10-27T18:29:59.999" });
});

it("includes worklogs recorded late on the final India calendar date", async () => {
  worklogs = [worklogRow("2026-10-27T18:29:59.999", "2"), worklogRow("2026-10-27T18:30:00", "3")];
  const result = await runPmsLookup("getMyWorklogs", range);
  expect(result).toMatchObject({ totalHours: 2, entryCount: 1 });
  expect((result as { daily: unknown[] }).daily).toEqual(expect.arrayContaining([expect.objectContaining({ date: "2026-10-27", totalHours: 2 })]));
});

it("paginates before computing totals rather than summing the capped detail list", async () => {
  worklogs = Array.from({ length: 501 }, () => worklogRow(undefined, "0.01"));
  const result = await runPmsLookup("getMyWorklogs", { ...range, top: 1 });
  expect(result).toMatchObject({ entryCount: 501, totalHours: 5.01, truncated: true, summariesComplete: true });
  expect((result as { rows: unknown[] }).rows).toHaveLength(1);
  expect(pmsFetch).toHaveBeenCalledTimes(2);
});

it("preserves single-day calls for both existing lookups", async () => {
  expect(await runPmsLookup("getMyAttendance", { date: "2026-09-25" })).toMatchObject({ date: "2026-09-25", knownHours: 9.5 });
  expect(await runPmsLookup("getMyWorklogs", { logDate: "2026-09-25" })).toMatchObject({ logDate: "2026-09-25", totalHours: 1.5 });
  expect(vi.mocked(pmsFetch).mock.calls[1][0]).toContain("GetReferencedDataTableData");
});

it("reports dates with no worklog entries without inventing attendance", async () => {
  worklogs = [];
  expect(await runPmsLookup("getMyWorklogs", { ...range, toDate: "2026-09-28" })).toMatchObject({ totalHours: 0, datesWithoutEntries: ["2026-09-25", "2026-09-28"] });
  attendance = [];
  expect(await runPmsLookup("getMyAttendance", { ...range, toDate: "2026-09-28" })).toMatchObject({ recordFound: false, daily: [
    { date: "2026-09-25", totalHours: null }, { date: "2026-09-28", totalHours: null },
  ] });
});

it("rejects reversed, excessive, incomplete and ambiguous ranges", async () => {
  for (const query of [
    { fromDate: "2026-10-27", toDate: "2026-09-25" }, { fromDate: "2025-01-01", toDate: "2026-11-11" },
    { fromDate: "2026-09-25" }, { date: "2026-09-25", ...range },
    { fromDate: "2026-02-30", toDate: "2026-03-01" },
  ]) await expect(runPmsLookup("getMyAttendance", query)).rejects.toThrow();
  await expect(runPmsLookup("getIssueContext", { issueId: "QKA-1", ...range })).rejects.toThrow("date-range");
  expect(pmsFetch).not.toHaveBeenCalled();
});

it("fails closed on partial reports, wrong employees, duplicate dates, and bad hours", async () => {
  countOverride = 2;
  await expect(runPmsLookup("getMyAttendance", range)).rejects.toThrow("incomplete");
  countOverride = undefined;
  attendance = [{ ...attendanceRow("2026-09-25"), "Employee Code": "another-employee" }];
  await expect(runPmsLookup("getMyAttendance", range)).rejects.toThrow("different date or employee");
  attendance = [attendanceRow("2026-09-25"), attendanceRow("2026-09-25")];
  await expect(runPmsLookup("getMyAttendance", range)).rejects.toThrow("duplicate");
  attendance = [attendanceRow("2026-09-25", "09:99")];
  await expect(runPmsLookup("getMyAttendance", range)).rejects.toThrow("invalid attendance hours");
});

it("rejects worklogs outside the range or belonging to another user", async () => {
  worklogs = [{ ...worklogRow(), "Email Id": "other@example.com" }];
  await expect(runPmsLookup("getMyWorklogs", range)).rejects.toThrow("invalid date or hours");
  worklogs = [worklogRow("2026-09-21T18:30:00")];
  await expect(runPmsLookup("getMyWorklogs", range)).rejects.toThrow("invalid date or hours");
});
