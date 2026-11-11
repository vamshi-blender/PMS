import { parseInputDate, rawDayCount } from "./derive";
import type { PmsLookupQuery } from "./types";

export interface LookupDateRange { fromDate: string; toDate: string; excludeWeekends: boolean }

export function lookupDateRange(query: PmsLookupQuery | undefined, singleKey: "date" | "logDate"): LookupDateRange {
  const single = query?.[singleKey];
  if (single !== undefined && (query?.fromDate !== undefined || query?.toDate !== undefined)) {
    throw new Error(`Use ${singleKey} or fromDate/toDate, not both.`);
  }
  const fromDate = (single ?? query?.fromDate)?.trim();
  const toDate = (single ?? query?.toDate)?.trim();
  if (!fromDate || !toDate) throw new Error(`Provide ${singleKey} or both fromDate and toDate as YYYY-MM-DD in India.`);
  const days = rawDayCount(parseInputDate(fromDate), parseInputDate(toDate));
  if (days < 1 || days > 366) throw new Error("The date range must be ordered and contain at most 366 days.");
  if (query?.excludeWeekends !== undefined && typeof query.excludeWeekends !== "boolean") throw new Error("excludeWeekends must be true or false.");
  return { fromDate, toDate, excludeWeekends: query?.excludeWeekends ?? false };
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function indiaWorklogDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error("PMS returned an invalid worklog date.");
  const milliseconds = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(milliseconds)) throw new Error("PMS returned an invalid worklog date.");
  return new Date(milliseconds + 19_800_000).toISOString().slice(0, 10);
}

export function endOfIndiaDate(value: string): string {
  const date = parseInputDate(value);
  return new Date(Date.UTC(date.year, date.month - 1, date.day + 1) - 19_800_000 - 1).toISOString().slice(0, -1);
}

export function offsetDate(value: string, days: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function attendanceHours(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d+:\d{2}$/.test(value) || Number(value.split(":")[1]) > 59) {
    throw new Error("PMS returned invalid attendance hours.");
  }
  const [hours, minutes] = value.split(":").map(Number);
  return hours + minutes / 60;
}

const round = (hours: number) => Math.round(hours * 1e8) / 1e8;
export function summarizeDates(range: LookupDateRange, entries: { date: string; hours: number | null }[], attendance: boolean) {
  const daily: { date: string; entryCount: number; totalHours: number | null; knownHours: number }[] = [];
  for (let millis = Date.parse(`${range.fromDate}T00:00:00Z`); millis <= Date.parse(`${range.toDate}T00:00:00Z`); millis += 86_400_000) {
    const date = new Date(millis).toISOString().slice(0, 10);
    if (range.excludeWeekends && isWeekend(date)) continue;
    const matches = entries.filter(entry => entry.date === date);
    const knownHours = round(matches.reduce((total, entry) => total + (entry.hours ?? 0), 0));
    daily.push({ date, entryCount: matches.length, knownHours,
      totalHours: matches.some(entry => entry.hours === null) || (attendance && !matches.length) ? null : knownHours });
  }
  const weeks = new Map<string, typeof daily>();
  for (const day of daily) {
    const monday = new Date(`${day.date}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const key = monday.toISOString().slice(0, 10);
    weeks.set(key, [...(weeks.get(key) ?? []), day]);
  }
  const weekly = [...weeks].map(([weekStart, days]) => ({
    weekStart, fromDate: days[0].date, toDate: days.at(-1)!.date,
    knownHours: round(days.reduce((total, day) => total + day.knownHours, 0)),
    datesWithoutEntries: days.filter(day => !day.entryCount).map(day => day.date),
    datesWithUnknownHours: days.filter(day => day.entryCount && day.totalHours === null).map(day => day.date),
  }));
  const knownHours = round(daily.reduce((total, day) => total + day.knownHours, 0));
  return { knownHours, totalHours: daily.some(day => day.entryCount && day.totalHours === null) ? null : knownHours,
    daily, weekly, datesWithoutEntries: daily.filter(day => !day.entryCount).map(day => day.date) };
}
