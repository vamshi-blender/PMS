// Contracts verified against both UI and direct API worklogs. See docs/quixy-worklog-form-analysis.md.
import type { PmsActionManifest, PmsLookupDefinition } from "../types";

const VIEW_ID = "05072022-184836479-5888ab5b-d645-4e86-a937-f2d02d2414c1";
const ISSUE_COLUMNS = ["Issue Id", "Project Id", "Record Id", "Issue Type", "Assignee", "Summary"];
export const worklogLookups: Record<string, PmsLookupDefinition> = {
  getMyWorklogs: {
    description: "Your worklogs across ALL issues for an India calendar date. Pass logDate as YYYY-MM-DD. Returns totalHours and entryCount computed over every returned entry, plus a capped detail list. Uses the logged-in user's email automatically.",
    queryable: true,
    source: {
      kind: "dailyWorklogs",
      dataTableId: "03012021-224715242-24c88b8e-8228-4231-aa14-003334728058",
      functionId: "09032021-003147819-f26197aa-fb37-4bf4-b8a8-82f6eff7f631",
      referencedElements: ["Worklog Date", "Worklog Description", "Worklog Hours", "Worklog Id", "Worklog Date Grid"],
      availableColumns: ["Worklog Id", "Worklog Date", "Worklog Hours", "Worklog Description"],
    },
  },
  getIssueContext: {
    description: "Resolve an exact full issue ID or a unique numeric suffix. Full prefixes must match exactly; never substitute a different prefix. Returns canonical Issue Id, Summary, Project Id, Record Id, Issue Type and Assignee. Pass issueId.",
    queryable: true,
    source: { kind: "issueContext", viewId: VIEW_ID, keyRef: "input.issueId", availableColumns: ISSUE_COLUMNS },
  },
  getWorklogCategories: {
    description: "Current active worklog category labels. Choose an exact returned label before proposing a worklog.",
    queryable: true,
    source: { kind: "lookupOptions", lookupTypeId: "12102021-224749297-38efb25d-41d0-4a20-b447-07adeb4aeefa" },
  },
  getIssueWorklogs: {
    description: "Read existing worklogs for an issue. Pass issueId (full ID or unique numeric suffix). Includes category, hours, date and description.",
    queryable: true,
    source: {
      kind: "worklogReport", viewId: VIEW_ID, keyRef: "input.issueId",
      reportId: "05072022-184853727-5a6ca7a1-7af6-4e03-b9d1-1fe7ae99cea6",
      availableColumns: ["Issue Id", "Worklog Date", "Worklog Hours", "Worklog Description", "Worklog Category", "Department", "Name"],
    },
  },
  getEmployeeDepartment: {
    description: "Logged-in employee's department for worklog submission; returns only Department.",
    queryable: false,
    source: {
      kind: "datasourceRows", single: true,
      dataSourceId: "09122025-151140038-04a0ffaf-8915-4233-9927-f944eba13fe9",
      referenceId: "09122025-151212613-6e69c429-eda6-4b2d-833f-a0da2f197677",
      outputColumns: ["Department"], conditionLabel: "Official Email Id", keyRef: "user.emailId",
    },
  },
  getWorklogCalendar: {
    description: "Server clock, working days and holidays for worklog timing calculations.",
    queryable: false,
    source: { kind: "calendar", calendarId: "11032021-114424154-3dd87e8c-37b3-40b7-bf69-cccd06207d68" },
  },
};

export const worklogManifest: PmsActionManifest = {
  title: "Add worklog",
  description: "Add a real worklog to an existing issue. Resolve the issue and category first; show its full ID and summary in the approval. Completes immediately.",
  appId: "07022021-220225896-25e3fa6f-ac18-4835-8437-f0f460b9062f",
  appName: "Worklog",
  derive: "worklog",
  resolvers: { issue: "getIssueContext", department: "getEmployeeDepartment", categories: "getWorklogCategories", calendar: "getWorklogCalendar" },
  inputs: [
    { name: "issueId", label: "Issue ID", type: "string", required: true, maxLength: 100, description: "Canonical full issue ID returned by getIssueContext (for example QKA-35174). Preserve any prefix the user explicitly supplied; never silently correct it." },
    { name: "issueSummary", label: "Issue summary", type: "string", required: true, description: "Exact Summary returned by getIssueContext. Show this and the full issue ID in the approval. Execution stops if the summary changed." },
    { name: "logDate", label: "Log date", type: "date", required: true, description: "Work date, YYYY-MM-DD in India. Resolve relative dates using the hidden donna_context timestamp." },
    { name: "category", label: "Category", type: "string", required: true, description: "Exact active label returned by getWorklogCategories." },
    { name: "logHours", label: "Log hours", type: "string", required: true, description: "Nonnegative decimal hours as a string, for example 1.5 means 1 hour 30 minutes." },
    { name: "billableHours", label: "Billable hours", type: "string", required: false, description: "Defaults to logHours. Do not ask separately. Use a different nonnegative decimal string only when the user explicitly requests different billable hours; 0 is allowed. Otherwise pass null." },
    { name: "description", label: "Log description", type: "string", required: true, description: "Description of the work performed." },
  ],
  rules: [],
  payload: {
  "var Project Id": {
    "ref": "issue.Project Id"
  },
  "var Issue Record Id": {
    "ref": "issue.Record Id"
  },
  "var Issue Id": {
    "ref": "issue.Issue Id"
  },
  "var Issue Type": {
    "ref": "issue.Issue Type"
  },
  "var Current Assignee": {
    "ref": "issue.Assignee"
  },
  "var Summary": {
    "ref": "issue.Summary"
  },
  "Action": {
    "const": "Add Worklog"
  },
  "var Logged In User": {
    "ref": "user.emailId"
  },
  "Log Date": {
    "ref": "derive.logDateUtc"
  },
  "Current Date": {
    "ref": "derive.currentDateUtc"
  },
  "Category": {
    "ref": "input.category"
  },
  "Log Hours": {
    "ref": "input.logHours"
  },
  "Hours": {
    "ref": "derive.hours"
  },
  "Minutes": {
    "ref": "derive.minutes"
  },
  "Billable Hours": {
    "ref": "input.billableHours"
  },
  "Next Working Date": {
    "ref": "derive.nextWorkingDateUtc"
  },
  "Current Time": {
    "ref": "derive.currentTime"
  },
  "Cut Off Time": {
    "const": "2022-12-28T05:30:00.00"
  },
  "Is On Time": {
    "ref": "derive.isOnTime"
  },
  "Worklog Late Entry Notification": {
    "const": "<p><span style=\"font-style: normal; font-weight: 400; text-indent: 0; white-space: normal; text-decoration: inherit; color: rgba(255, 0, 0, 1); font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;, &quot;Segoe UI Web&quot;, sans-serif; font-size: 12pt; background-color: rgba(255, 255, 255, 1); float: none; display: inline !important\">Please note</span><span style=\"font-style: normal; font-weight: 400; text-indent: 0; white-space: normal; text-decoration: inherit; color: rgba(255, 0, 0, 1); font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;, &quot;Segoe UI Web&quot;, sans-serif; font-size: 12pt; background-color: rgba(255, 255, 255, 1); float: none; display: inline !important\">&nbsp;t</span><span style=\"font-style: normal; font-weight: 400; text-indent: 0; white-space: normal; text-decoration: inherit; color: rgba(255, 0, 0, 1); font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;, &quot;Segoe UI Web&quot;, sans-serif; font-size: 12pt; background-color: rgba(255, 255, 255, 1); float: none; display: inline !important\">hat it shall be considered as late log entry</span><br></p>"
  },
  "var Log Efforts": {
    "ref": "input.logHours"
  },
  "Log Hours Instructions": {
    "const": "<p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><strong style=\"font-weight: 700\"><span style=\"font-size: 12pt\">Note :</span></strong></p><p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><span style=\"font-size: 12pt\">1. Please enter log hours as 1.5, if you have spent 1 hour 30 minutes.</span></p><p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><span style=\"font-size: 12pt\">2. Before you click on submit, please ensure that you have entered correct work log date.</span></p><p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><span style=\"font-size: 12pt\">3. Once you submit you can't modify worklog date and hour, all you can modify description at later point</span></p>"
  },
  "Log Description": {
    "ref": "input.description"
  },
  "var Worklog Date": {
    "ref": "derive.logDateUtc"
  },
  "var Worklog Email Id": {
    "const": null
  },
  "Issue Id watchers": {
    "const": null
  },
  "Department": {
    "ref": "department.Department"
  },
  "Official Email Id": {
    "ref": "user.emailId"
  },
  "Report": {
    "const": ""
  },
  "Watchers List": {
    "const": []
  },
  "Worklog Date Grid": {
    "const": []
  },
  "_AppId": {
    "const": "07022021-220225896-25e3fa6f-ac18-4835-8437-f0f460b9062f"
  },
  "_AppName": {
    "const": "Worklog"
  },
  "_CurrentStepNumber": {
    "const": 1
  },
  "_WorkSpaceId": {
    "const": "03012021-192624661-c4d2d235-e371-4983-973f-c82b074f9b21"
  },
  "_OrganizationId": {
    "ref": "user.organizationId"
  },
  "_NextGroupName": {
    "const": "Done"
  },
  "_IsCompleted": {
    "const": true
  },
  "_ExternalApiIds": {
    "const": ""
  },
  "_InternalApiIds": {
    "const": ""
  },
  "_DataFunctionIds": {
    "const": ""
  },
  "_UserFunctionIds": {
    "const": ""
  },
  "_UserId": {
    "ref": "user.userId"
  },
  "_Username": {
    "ref": "user.emailId"
  },
  "_FullName": {
    "ref": "user.fullName"
  },
  "_UpdatedUserId": {
    "const": ""
  },
  "_UpdatedUsername": {
    "const": ""
  },
  "_UpdatedEmailId": {
    "const": ""
  },
  "_UserEmailId": {
    "ref": "user.emailId"
  },
  "_CreatedLocation": {
    "const": ""
  },
  "_NextStepUsers": {
    "const": ""
  },
  "_UpdatedLocation": {
    "const": ""
  },
  "_WorkFlowAction": {
    "const": "Start - Submit"
  }
},
  submitPath: "/api/App/SaveAppData?appName=Worklog&users=&startDate=null&dueDate=null",
};

