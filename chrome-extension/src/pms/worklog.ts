import { parseInputDate, quixyUtcDate, nowUtcMinute } from "./derive";
import { fetchIssueCandidates, getPmsJson } from "./primitives";

const ISSUE_FIELDS = ["Issue Id", "Project Id", "Record Id", "Issue Type", "Assignee", "Summary"];
const ISSUE_ID = /^[A-Z][A-Z0-9]*[-/]\d+$/i;

export function normalizeIssueId(value: unknown, requireFull = false): string {
  if (typeof value !== "string") throw new Error("An issue ID is required.");
  const id = value.trim().toUpperCase();
  if (!ISSUE_ID.test(id) && (requireFull || !/^\d+$/.test(id))) {
    throw new Error("Provide a full issue ID (for example QKA-35174) or resolve a numeric ID first.");
  }
  return id;
}

/** Contains discovers candidates; only exact IDs or exact numeric suffixes may match.
 * Read all candidate pages before accepting a number, so ambiguity fails closed. */
export async function resolveIssue(viewId: string, value: unknown, signal?: AbortSignal, extraFields: string[] = []) {
  const id = normalizeIssueId(value);
  const numeric = /^\d+$/.test(id);
  const candidates: Record<string, unknown>[] = [];
  for (let skip = 0; ; skip += 100) {
    if (skip >= 1000) throw new Error("Too many matching issues. Provide the full issue ID.");
    const page = await fetchIssueCandidates(viewId, id, skip, signal);
    candidates.push(...page.rows);
    if ((page.total !== undefined && skip + page.rows.length >= page.total) ||
        (page.rows.length < 100 && (page.total === undefined || skip + page.rows.length >= page.total))) break;
    if (!page.rows.length) throw new Error("PMS issue search was incomplete. Provide the full issue ID.");
  }
  const matches = candidates.filter(row => {
    const full = String(row["Issue Id"] ?? "").toUpperCase();
    return numeric ? full.split(/[-/]/).at(-1) === id : full === id;
  });
  const unique = [...new Map(matches.map(row => [String(row["Issue Id"]), row])).values()];
  if (unique.length !== 1) {
    const suggestions = candidates.slice(0, 8).map(row => String(row["Issue Id"])).join(", ");
    throw new Error(unique.length > 1
      ? `Issue number ${id} is ambiguous: ${unique.map(r => r["Issue Id"]).join(", ")}. Ask the user for the full ID.`
      : `Issue ${id} was not found. Do not change its prefix without asking the user.${suggestions ? " Candidates: " + suggestions : ""}`);
  }
  const row = unique[0];
  for (const field of ISSUE_FIELDS) {
    if ((typeof row[field] !== "string" && typeof row[field] !== "number") ||
        (field !== "Assignee" && String(row[field]).trim() === "")) {
      throw new Error(`PMS issue is missing "${field}". No worklog was submitted.`);
    }
  }
  const resolved: Record<string, string> = Object.fromEntries(ISSUE_FIELDS.map(field => [field, String(row[field])]));
  // Status enriches the lookup but is not a prerequisite for adding a worklog.
  resolved.Status = typeof row.Status === "string" ? row.Status : "";
  for (const field of extraFields) resolved[field] = row[field] === undefined || row[field] === null ? "" : String(row[field]);
  return resolved;
}

export async function fetchCategoryLabels(lookupTypeId: string, signal?: AbortSignal) {
  const data = await getPmsJson(`/api/Lookup/GetLookupType?${new URLSearchParams({ lookupTypeId })}`, signal) as {
    LookupValues?: { LookupValue?: unknown; IsDeleted?: boolean }[];
  };
  if (!Array.isArray(data?.LookupValues)) throw new Error("PMS returned invalid worklog categories.");
  const values = data.LookupValues.filter(item => !item.IsDeleted && typeof item.LookupValue === "string")
    .map(item => item.LookupValue as string);
  if (!values.length) throw new Error("No active worklog categories are available.");
  return { values };
}

export interface WorklogCalendar {
  now: string;
  workingDays: string[];
  holidays: string[];
}

function indiaDate(now: Date): string {
  return new Date(now.getTime() + 19_800_000).toISOString().slice(0, 10);
}

export async function fetchWorklogCalendar(calendarId: string, signal?: AbortSignal): Promise<WorklogCalendar> {
  const query = new URLSearchParams({ calendarId });
  const [now, calendar, holidays] = await Promise.all([
    getPmsJson("/api/Organization/GetCurrentUTC", signal),
    getPmsJson(`/api/Organization/GetCalendar?${query}`, signal),
    getPmsJson(`/api/Organization/GetCalendarHolidays?${query}`, signal),
  ]);
  const days = (calendar as { CalendarWorkingHours?: { Day: string }[] })?.CalendarWorkingHours;
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) ||
      !Array.isArray(days) || !days.length || !Array.isArray(holidays)) {
    throw new Error("PMS returned invalid worklog calendar data.");
  }
  const holidayDates = holidays.map((holiday: { Date?: unknown }) => {
    const date = typeof holiday.Date === "string" ? new Date(holiday.Date.endsWith("Z") ? holiday.Date : holiday.Date + "Z") : new Date(NaN);
    if (!Number.isFinite(date.getTime())) throw new Error("PMS returned an invalid holiday date.");
    return indiaDate(date);
  });
  return { now, workingDays: days.map(day => day.Day), holidays: holidayDates };
}

export function validateWorklogInputs(inputs: Record<string, unknown>): void {
  normalizeIssueId(inputs.issueId, true);
  for (const field of ["logHours", "billableHours"]) {
    const value = inputs[field];
    if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) ||
        !Number.isFinite(Number(value) * 60)) {
      throw new Error(`${field} must be nonnegative finite decimal hours (for example 1.5).`);
    }
  }
}

export function deriveWorklog(
  inputs: Record<string, unknown>, calendar: WorklogCalendar,
): Record<string, unknown> {
  validateWorklogInputs(inputs);
  const logDate = parseInputDate(String(inputs.logDate));
  const dateKey = String(inputs.logDate).trim();
  const now = new Date(calendar.now);
  const today = indiaDate(now);
  const currentDate = parseInputDate(today);
  const logMillis = Date.UTC(logDate.year, logDate.month - 1, logDate.day);
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let next: Date | undefined;
  for (let offset = 1; offset <= 370; offset++) {
    const day = new Date(logMillis + offset * 86_400_000);
    if (calendar.workingDays.includes(names[day.getUTCDay()]) &&
        !calendar.holidays.includes(day.toISOString().slice(0, 10))) { next = day; break; }
  }
  if (!next) throw new Error("No next working date could be determined.");
  const hours = Math.floor(Number(inputs.logHours));
  // Preserve decimal hours. Avoid binary floating point noise in derived minutes.
  const minutes = Math.round((Number(inputs.logHours) * 60 - hours * 60) * 1e8) / 1e8;
  // Matches the captured rules: same-day => Yes; otherwise compare time to the
  // recorded 05:30 UTC cutoff. Historical-day semantics need further live coverage.
  const utcSeconds = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60;
  const isOnTime = dateKey === today || (logMillis < next.getTime() && utcSeconds <= 19800);
  return {
    hours: String(hours), minutes, logDateUtc: quixyUtcDate(logDate),
    currentDateUtc: quixyUtcDate(currentDate),
    nextWorkingDateUtc: quixyUtcDate(parseInputDate(next.toISOString().slice(0, 10))),
    currentTime: nowUtcMinute(now), isOnTime: isOnTime ? "Yes" : "No",
  };
}
