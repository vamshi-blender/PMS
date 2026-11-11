import { changeIssueStatusManifest, statusLookups } from "./manifests/change-issue-status";
// Assembles the PMS manifest bundle served to the extension and used to
// generate Donna's tool schemas + capability catalog. Adding a new PMS
// action = write its manifest file and register it here; nothing else.
import { worklogManifest, worklogLookups } from "./manifests/worklog";
import { attendanceLookups } from "./manifests/attendance";
import type { PmsBundle } from "./types";
import type { PmsEnvironment } from "../../shared/pms-scope";
import {
  leaveApplicationManifest,
  leaveLookups,
} from "./manifests/leave-application";

// Bump when the bundle shape (not just its content) changes, so the
// extension can reject bundles it doesn't understand.
export const PMS_BUNDLE_VERSION = 7;
const PRODUCTION_FORM_HASHES: Record<string, string> = {
  create_leave_application: "b89a16100014c4bd399d93ec3b479a8f7334620312fec646bd3a3b496b7f0a1a",
  add_worklog: "b777bacb4f8e96c8b7b9c0703749e37353da22e0cf97794564d7d7cbb65eb681",
  change_issue_status: "cb482b45e4435d7f3fdc8599ae19d42e12e463624b37bb7eae666307c94c6385",
};

export function getPmsBundle(environment: PmsEnvironment = "staging"): PmsBundle {
  return {
    version: PMS_BUNDLE_VERSION,
    environment,
    lookups: { ...leaveLookups, ...worklogLookups, ...attendanceLookups, ...statusLookups },
    actions: Object.fromEntries(Object.entries({
      create_leave_application: leaveApplicationManifest,
      add_worklog: worklogManifest,
      change_issue_status: changeIssueStatusManifest,
    }).map(([name, manifest]) => [name, environment === "production"
      ? { ...manifest, formHash: PRODUCTION_FORM_HASHES[name], ...(name === "create_leave_application" ? {
        description: `${manifest.description} Production checks the seven-day backdate rule and Manager/HR unblocking automatically.`,
        payload: { ...manifest.payload,
          "EmployeeId unblock": { ref: "user.employeeCode" },
          "Fromdate unblock": { ref: "derive.fromUtc" },
          "Todate unblock": { ref: "derive.toUtc" },
          Validation: { ref: "derive.productionLeaveValidationGrid" },
        },
      } : {}) } : manifest])),
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
