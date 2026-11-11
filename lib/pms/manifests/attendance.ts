import type { PmsLookupDefinition } from "../types";

export const attendanceLookups: Record<string, PmsLookupDefinition> = {
  getMyAttendance: {
    description: "Your attendance for date OR an inclusive fromDate/toDate range (YYYY-MM-DD in India, at most 366 days). Fetch the whole range once; returns complete daily/weekly summaries plus capped detail rows. excludeWeekends=true omits Saturdays/Sundays. Hours are decimal in summaries and HH:mm in details. Missing records/hours are unknown, not absence or zero hours. Attendance does not prove physical office presence. Uses your signed-in employee access.",
    queryable: true,
    source: {
      kind: "attendanceReport",
      reportId: "27052024-171954081-2775b943-8c3b-44f6-8a03-c0acbc565edb",
      availableColumns: ["Date", "In Time", "Out Time", "Total Hours", "Status"],
    },
  },
};
