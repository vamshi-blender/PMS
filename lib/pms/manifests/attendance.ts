import type { PmsLookupDefinition } from "../types";

export const attendanceLookups: Record<string, PmsLookupDefinition> = {
  getMyAttendance: {
    description: "Your attendance for one date. Pass date as YYYY-MM-DD in India. Returns In Time (attendance login), Out Time, Total Hours and Status. Uses your signed-in employee access. No rows means no record returned, not proof of absence. Missing Out Time or Total Hours must not be invented.",
    queryable: true,
    source: {
      kind: "attendanceReport",
      reportId: "27052024-171954081-2775b943-8c3b-44f6-8a03-c0acbc565edb",
      availableColumns: ["Date", "In Time", "Out Time", "Total Hours", "Status"],
    },
  },
};
