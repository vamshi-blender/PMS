import { changeIssueStatusManifest, statusLookups } from "./manifests/change-issue-status";
// Assembles the PMS manifest bundle served to the extension and used to
// generate Donna's tool schemas + capability catalog. Adding a new PMS
// action = write its manifest file and register it here; nothing else.
import { worklogManifest, worklogLookups } from "./manifests/worklog";
import { attendanceLookups } from "./manifests/attendance";
import type { PmsBundle } from "./types";
import {
  leaveApplicationManifest,
  leaveLookups,
} from "./manifests/leave-application";

// Bump when the bundle shape (not just its content) changes, so the
// extension can reject bundles it doesn't understand.
export const PMS_BUNDLE_VERSION = 5;

export function getPmsBundle(): PmsBundle {
  return {
    version: PMS_BUNDLE_VERSION,
    lookups: { ...leaveLookups, ...worklogLookups, ...attendanceLookups, ...statusLookups },
    actions: {
      create_leave_application: leaveApplicationManifest,
      add_worklog: worklogManifest,
      change_issue_status: changeIssueStatusManifest,
    },
  };
}

/** Names of lookups Donna may call standalone via pms_lookup. */
export function queryableLookupNames(): string[] {
  return Object.entries(getPmsBundle().lookups)
    .filter(([, definition]) => definition.queryable)
    .map(([name]) => name);
}

export function actionNames(): string[] {
  return Object.keys(getPmsBundle().actions);
}
