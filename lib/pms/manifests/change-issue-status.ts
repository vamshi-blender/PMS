import type { PmsActionManifest, PmsLookupDefinition } from "../types";

export const STATUS_DETAIL_FIELDS = ["Estimated Hours","Change Remarks","Release Datetime","Configurations","Scripts","Environment level","Specific details","Select Branch","Select Required Components","Any DB Scripts Exists","Issue Remarks","Mention the DB script","Any configuration changes made","Specify the configuration change","Configurations added","DB Scripts","Migration scripts","Dev Remarks","Specify Impact Feature Related To Bug"];
export const statusLookups: Record<string, PmsLookupDefinition> = {
  getAllowedIssueStatuses: {
    description: "Resolve an issue and read its currently allowed next statuses. Pass issueId exactly as supplied. Optionally pass newStatus and details to see that transition's visible fields, required fields, valid choices and blocking validations. Never infer allowed transitions from a global status list.",
    queryable: true,
    source: {
      kind: "issueTransitions", detailFields: STATUS_DETAIL_FIELDS,
      viewId: "05072022-184836479-5888ab5b-d645-4e86-a937-f2d02d2414c1",
      appId: "01022021-064254831-3920198f-f15c-4ea9-b8f3-22913911c281",
    },
  },
};

export const changeIssueStatusManifest: PmsActionManifest = {
  title: "Change issue status",
  description: "Change an issue to an allowed next status. Use getAllowedIssueStatuses to collect transition-specific fields first. The current issue, allowed transition and live form rules are revalidated after approval. File/reviewer requirements that cannot be fulfilled in chat must be completed in PMS.",
  appId: "01022021-064254831-3920198f-f15c-4ea9-b8f3-22913911c281",
  appName: "Change Issue Status",
  derive: "statusChange",
  resolvers: { issue: "getIssueContext", transition: "getAllowedIssueStatuses" },
  inputs: [
    { name: "issueId", label: "Issue ID", type: "string", required: true, description: "Exact canonical full issue ID returned by lookup. Never silently change an explicit prefix." },
    { name: "issueSummary", label: "Issue summary", type: "string", required: true, description: "Exact resolved issue summary shown in the approval." },
    { name: "currentStatus", label: "Current status", type: "string", required: true, description: "Exact current status from the lookup; execution stops if it changes." },
    { name: "newStatus", label: "New status", type: "string", required: true, description: "Exact target from getAllowedIssueStatuses; never guess or skip intermediate transitions." },
    { name: "details", label: "Transition details", type: "details", required: false, options: STATUS_DETAIL_FIELDS, description: "Only fields required or explicitly supplied for this transition, as returned by the lookup. Each entry has field and either value (text) or values (multi-select), with the other null. Do not invent answers, branch/lead confirmations, RCA or files. null when no details are needed." },
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
  "Issue Id": {
    "ref": "derive.Issue Id"
  },
  "Status": {
    "ref": "derive.Status"
  },
  "Project Id": {
    "ref": "issue.Project Id"
  },
  "var Issue Type": {
    "ref": "issue.Issue Type"
  },
  "Issue Type": {
    "ref": "issue.Issue Type"
  },
  "var Current Assignee": {
    "ref": "issue.Assignee"
  },
  "var Issue Current Status": {
    "ref": "issue.Status"
  },
  "var Summary": {
    "ref": "issue.Summary"
  },
  "Current Status": {
    "ref": "issue.Status"
  },
  "Estimated Hours": {
    "ref": "derive.Estimated Hours"
  },
  "Detection Phase": {
    "ref": "derive.Detection Phase"
  },
  "New Status": {
    "ref": "derive.New Status"
  },
  "Change Remarks": {
    "ref": "derive.Change Remarks"
  },
  "Release Datetime": {
    "ref": "derive.Release Datetime"
  },
  "Review Closed Task By": {
    "const": ""
  },
  "Configurations": {
    "ref": "derive.Configurations"
  },
  "Scripts": {
    "ref": "derive.Scripts"
  },
  "Environment level": {
    "ref": "derive.Environment level"
  },
  "Specific details": {
    "ref": "derive.Specific details"
  },
  "Select Branch": {
    "ref": "derive.Select Branch"
  },
  "Select Required Components": {
    "ref": "derive.Select Required Components"
  },
  "Any DB Scripts Exists": {
    "ref": "derive.Any DB Scripts Exists"
  },
  "Issue Remarks": {
    "ref": "derive.Issue Remarks"
  },
  "Mention the DB script": {
    "ref": "derive.Mention the DB script"
  },
  "Any configuration changes made": {
    "ref": "derive.Any configuration changes made"
  },
  "Specify the configuration change": {
    "ref": "derive.Specify the configuration change"
  },
  "Configurations added": {
    "ref": "derive.Configurations added"
  },
  "DB Scripts": {
    "ref": "derive.DB Scripts"
  },
  "Migration scripts": {
    "ref": "derive.Migration scripts"
  },
  "Configurations Files": {
    "const": []
  },
  "DB Files": {
    "const": []
  },
  "Migration files": {
    "const": []
  },
  "Dev Remarks": {
    "ref": "derive.Dev Remarks"
  },
  "Specify Impact Feature Related To Bug": {
    "ref": "derive.Specify Impact Feature Related To Bug"
  },
  "Var Sub Task Id": {
    "ref": "derive.Var Sub Task Id"
  },
  "status Indicator Project Id": {
    "ref": "issue.Project Id"
  },
  "status Indicator Issue Type": {
    "ref": "issue.Issue Type"
  },
  "status Indicator Status": {
    "ref": "derive.status Indicator Status"
  },
  "Status Indicator": {
    "ref": "derive.Status Indicator"
  },
  "Updated Date Time": {
    "ref": "derive.Updated Date Time"
  },
  "Issue Id for watch": {
    "ref": "derive.Issue Id for watch"
  },
  "Logged In User Name": {
    "ref": "user.fullName"
  },
  "Assignee Story Points": {
    "ref": "derive.Assignee Story Points"
  },
  "Status Changed User": {
    "ref": "user.emailId"
  },
  "Sprint Name": {
    "ref": "derive.Sprint Name"
  },
  "Story points Issue Id": {
    "ref": "issue.Issue Id"
  },
  "Get Assignee Story Points": {
    "ref": "derive.Get Assignee Story Points"
  },
  "Story Sub Task Id": {
    "ref": "derive.Story Sub Task Id"
  },
  "Sub task Story Points": {
    "ref": "derive.Sub task Story Points"
  },
  "Get ready for QA Issue id": {
    "ref": "derive.Get ready for QA Issue id"
  },
  "Watch List Details": {
    "ref": "derive.Watch List Details"
  },
  "Get ready for QA Issue id Grid": {
    "ref": "derive.Get ready for QA Issue id Grid"
  },
  "_AppId": {
    "const": "01022021-064254831-3920198f-f15c-4ea9-b8f3-22913911c281"
  },
  "_AppName": {
    "const": "Change Issue Status"
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
  submitPath: "/api/App/SaveAppData?appName=Change%20Issue%20Status&users=&startDate=null&dueDate=null",
};
