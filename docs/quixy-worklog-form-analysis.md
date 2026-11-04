# Quixy Worklog form — interaction and API analysis

Captured 2026-11-04 (India time), using Playwright MCP on `new-implementation`.
This is an incremental investigation, following the evidence structure in
[quixy-leave-form-analysis.md](quixy-leave-form-analysis.md).
The initial pass stopped before submission. A subsequent user-authorized submission
succeeded; section 8 records its full payload and result. Other validation branches
remain unverified.

## 1. Capture context

- Source: Manage Issues datasource `05072022-184836362-8b83d98c-3ab0-4266-aee8-2dd646f26bb0`.
- View: `05072022-184836479-5888ab5b-d645-4e86-a937-f2d02d2414c1`.
- Opened row: `QKA-49715`, summary `Team Cordination`, using its Add Worklog clock icon.
- Form: Worklog, app ID `07022021-220225896-25e3fa6f-ac18-4835-8437-f0f460b9062f`.
- Workspace: `03012021-192624661-c4d2d235-e371-4983-973f-c82b074f9b21`.
- Organization: `29102019-093434548-a4fe41b0-1fd0-489a-ac08-a29b98883143`.
- API host: `https://quixyhomeapi.kwixee.co.in`.
- Request numbers below are session-local Playwright network indices.
- Baseline before opening: request 211. Form-open requests: 212–245.
- Baseline before field changes: 245. Final network check: 247.
- Auth headers, tokens, bulk employee details, and email option lists are omitted.

## 2. Exact interaction sequence

| Step | Change | New API requests | Observed result |
|---|---|---|---|
| 1 | Select Action = Add Worklog using its label | 246, 247: POST /api/DataTable/GetDataTableDataByReference | Both return []; hidden worklog-date/email dependencies refresh |
| 2 | Open Category and choose Research | None after 247 | Research selected from already-loaded options |
| 3 | Enter Log Hours = 1.5, then Tab | None after 247 | Hours = 1; Minutes = 30 |
| 4 | Enter Billable Hours = 1, then Tab | None after 247 | Billable Hours remains 1; Log Hours remains 1.5 |
| 5 | Enter description below, then Tab | None after 247 | Description retained |
| 6 | Final read-only field and network verification | None after 247 | All requested values still present; no submission |

Description:
> Test entry for API analysis: researched worklog field dependencies and request formats.

Log Date remained at its default `04/11/2026`; Current Date also showed `04/11/2026`.
The first attempt to click the radio input was intercepted by its styled label and
did not select it. Clicking the Add Worklog label succeeded. The category dropdown
was also opened before that successful selection; no additional requests appeared
until the radio label was clicked. Counts above describe these observed actions,
not all possible category/date combinations.

### Requests 246 and 247: action-triggered worklog-email options

Same endpoint, table, function, and projected columns:

```json
{
  "DataTableFunctionId": "09032021-003147819-f26197aa-fb37-4bf4-b8a8-82f6eff7f631",
  "DataTableId": "03012021-224715242-24c88b8e-8228-4231-aa14-003334728058",
  "ReferencedElements": "Worklog Date,Worklog Description,Worklog Hours,Worklog Id,Worklog Date Grid",
  "DataTableDataReferenceDataDTOs": [
    {
      "IsFocused": false,
      "ReferenceName": "Worklog Date",
      "Value": "2026-11-03T18:30:00.00",
      "SelectedValue": ""
    },
    {
      "IsFocused": true,
      "ReferenceName": "Worklog Email Id",
      "Value": "",
      "SelectedValue": ""
    }
  ]
}
```

That is request 246. Request 247 changes:
- Date `SelectedValue` to `2026-11-03T18:30:00.00`.
- Email `Value` to the logged-in user's email.

Both responses: `[]` (HTTP 200). This is an option-list endpoint: it does not
establish that a dependent-record fetch returned no worklogs, or that the API
enforces a daily-hours limit. The date represents midnight 4 November in India.
The exact two-step refresh order is observed SPA behavior; whether both calls are
necessary in a direct executor remains to be established.

## 3. Form-open API inventory

| Request(s) | API | Evidence / purpose |
|---|---|---|
| 214 | Organization/GetCurrentUTC | Server time |
| 215 | App/GetApp | Worklog form definition |
| 217 | App/GetAppWithPermissions | User-scoped definition, fields, rules, workflow button |
| 220, 227, 231 | Lookup/GetLookupType | Worklog Category options |
| 221, 233 | DataTable/GetDataTableDataByReference | Watch-link Issue Id options |
| 222, 232 | DataTable/GetDataTableDataByReference | Worklog Email Id options |
| 223 | Datasource/GetReferencedDataSourceData | Department by official email |
| 234 | Datasource/GetReferencedDataSourceConditionData | Official Email Id options |
| 224–226, 228–230 | Organization/GetCalendar | Same working-calendar ID, repeated |
| 235–240 | Organization/GetCalendarHolidays | Same calendar, repeated |
| 241–245 | Report metadata, datasource, collection columns, GetListReportData, GetReportAggregatesResult | Embedded Worklog Details table |
| 212–213, 216, 218–219 | Transaction/guest gating, help, comments, payment metadata | Ancillary form infrastructure |

No GetNextSerialNumber or SaveAppData call occurred during loading or field entry.
The subsequent SaveAppData call is recorded in section 8.

### Category source

`GET /api/Lookup/GetLookupType?lookupTypeId=12102021-224749297-38efb25d-41d0-4a20-b447-07adeb4aeefa`

Response is an object with `LookupValues` entries containing `LookupId`,
`LookupValue`, and `IsDeleted`. The visible Research option came from this
load-time list. The subsequent write confirmed label serialization (section 8).

### Watch-link option source

Table: `13072021-104137449-2ea1521d-01d4-4c20-8cc1-8f499b72906d`.
Function: `13072021-104141734-28ddfb43-4922-4388-b1f3-90ecb0b5bd5c`.
Columns: `Date,Issue Id,Record Id,Watcher Email Id,Issue Id Grid`.
Request 221 focuses Issue Id with Value `QKA-49715`, SelectedValue empty;
response `[]`. Request 233 uses an empty Issue Id and returns `[{AppData: ...}]`
issue options. These are option responses, not complete watcher rows.

### Worklog-email option source

Table/function match requests 246–247. At load, request 222 has a null date and
the current user's email and returns one `AppData` email option.
Request 232 has a null date and empty email and returns many email options.

### Department resolver candidate

Request 223:
```json
{
  "DataSourceId": "09122025-151140038-04a0ffaf-8915-4233-9927-f944eba13fe9",
  "DataSourceReferenceId": "09122025-151212613-6e69c429-eda6-4b2d-833f-a0da2f197677",
  "OutputColumns": "Department",
  "DataSourceReferenceConditions": [
    {
      "DataSourceCollectionConditionLabelName": "Official Email Id",
      "IsFocused": true,
      "Value": "<logged-in email>"
    }
  ]
}
```

Response is nested Name/Value rows. Despite OutputColumns, it contains a full
employee record; the Department value observed was Product. Extract the required
field locally. Do not relay the complete employee response to the model.

Request 234 loads email options using the same datasource/reference, with
`DataSourceCollectionConditionLabelName: "Official Email Id"`, empty Value,
empty DataSourceReferenceConditions, and SelectedValue set to current user's email.

### Embedded report

Report ID: `05072022-184853727-5a6ca7a1-7af6-4e03-b9d1-1fe7ae99cea6`.
Definition maps `var Issue Id` to report field `Issue Id`.
Visible columns: Name, Worklog Date, Worklog Hours, Worklog Description.
81 rows were displayed in this session. This display is not proof that the same
report must be fetched to submit a new worklog; the report request/filter contract
still needs a dedicated capture.

## 4. Field model and calculations

The user-scoped definition (217) was inspected as well as the visible form.

| Field | Source/type | Confirmed details |
|---|---|---|
| Action | Radio | Required; Add/Edit/Delete Worklog |
| Log Date | Date | Required; default current; dd/MM/yyyy |
| Current Date | Date | Default current; disabled in UI |
| Category | DropDown | Required; lookup type above |
| Log Hours | Number | Required; pattern `\\d+(\\.\\d+)?`; 1.5 accepted in UI |
| Hours | Calculate | Disabled; RoundDown(Log Hours, 0) |
| Minutes | Calculate | Disabled; Log Hours * 60 - Hours * 60 |
| Billable Hours | Number | Required; default 0; entered 1 |
| Log Description | TextArea | Required |
| var Logged In User | EmailId | User-data field; required and email validation |
| var Project Id / var Issue Record Id / var Issue Id / var Issue Type / var Current Assignee | TextBox | Context fields in the definition; final payload mapping unverified |
| Summary | TextArea | Disabled in UI; prefilled from issue |
| Department | TextBox | Datasource-dependent field |

Do not infer numeric bounds, a billable-hours <= log-hours constraint, rounding
behavior for other fractions, or server acceptance from this single input pass.
The form warns that after submission the date and hours cannot be changed, while
the description can be edited later; this warning has not been tested here.

## 5. Rules relevant to add_worklog

Definition-backed facts (not all runtime branches exercised):
- Action = Add Worklog hides var Worklog Date and var Worklog Email Id, and shows
  Log Hours, Hours, Minutes, instructions, Log Description, and Category.
- Action = Add Worklog propagates Log Date to var Worklog Date. This is consistent
  with the date-conditioned option requests observed after selecting the action.
- When var Logged In User exists and var Worklog Email Id is empty, copy the
  logged-in email to that field.
- Copy var Logged In User to Official Email Id when present.
- Copy var Issue Id to Issue Id watchers; disable Watchers List.
- Copy Log Hours to var Log Efforts on empty/nonempty Log Hours changes.
- Set Next Working Date using Add Days = 1 from Log Date with selected calendar
  `11032021-114424154-3dd87e8c-37b3-40b7-bf69-cccd06207d68`.
- Log Date = Current Date sets Is On Time = Yes.
- Log Date < Next Working Date, Current Time <= Cut Off Time, and Log Date !=
  Current Date sets Is On Time = Yes.
- The equivalent branch with Current Time > Cut Off Time sets Is On Time = No.
- Is On Time = No shows the late-entry notification; Yes/empty hides it.
- Cut Off Time has literal default `2022-12-28T05:30:00.00`. Its date/time
  normalization and comparison semantics need live boundary testing; do not
  silently replace the recorded condition with an assumed next-day policy.

The workflow definition exposes a Start-step Submit button with IsConfirm = true.
The subsequent Submit confirmation and successful write are recorded in section 8.

## 6. Mapping to the existing manifest architecture

- **Manifest inputs:** issue identifier, log date, category, log hours, billable
  hours, description; Action can be fixed to Add Worklog for this capability.
- **Lookup candidates:** category options; existing worklogs; issue context.
  Standalone exposure and precise query contracts remain to be decided.
- **Resolver candidates:** employee department, issue details, watcher data, and
  any worklog data actually needed in the final payload.
- **Primitives:** category Lookup/GetLookupType and data-table option calls are
  different contracts from the current dependent-row primitive. Reuse existing
  datasource transport where its actual request contract is compatible.
- **Derived values:** Hours, Minutes, var Log Efforts, current date/time, and
  calendar-based Next Working Date / Is On Time.
- **Executor:** preserve recorded field names and value types; require final
  write evidence before implementing the submission template.

## 7. Evidence checklist before submission (status updated by section 8)

- Captured in section 8: final request/response, confirmation, null/empty/array
  distinctions, hidden fields, grids, and workflow envelope.
- Identify how issue row context populates all var fields and how to resolve that
  context without relying on an open row in the UI.
- Verify dependent-record requests when there are existing worklogs for a date.
- Observe date changes, working/nonworking days, and cutoff boundaries.
- Category serialization and numeric types for this example are confirmed in
  section 8. Precision bounds, duplicate/daily-hours checks and billable rules
  remain unverified.
- Inspect embedded report request filters independently.
- Compare another issue/category/date combination; add/edit/delete are separate
  branches and must not be treated as already captured.

## 8. Submission capture — successful real write

The user requested clicking Submit. This created a real test worklog; it has not
been deleted. Form-opening and field-entry observations above precede this write.

### Sequence

1. Submit opened **Are you sure you want to Submit ?**, with No/Yes buttons.
   No API call occurred before confirmation.
2. Yes triggered request 248: GET App/GetPaymentGateWayDetails with appId above
   and workflowStepId `01032021-142152241-95467958-6f96-4aed-b220-167ea5f2291e`;
   HTTP 204.
3. Request 249: POST
   `/api/App/SaveAppData?appName=Worklog&users=&startDate=null&dueDate=null`;
   HTTP 200 and Success = true.
4. Request 250: POST Report/GetViewResult with skip=0, take=100 and the source
   viewId; HTTP 200. The form closed and Manage Issues became visible.

### Complete request body

All keys and value types are preserved. Identity and captured location coordinates
are replaced by explicit placeholders; HTML strings are verbatim. One successful
request does not prove every field is required by the server.

```json
{
  "var Project Id": "70",
  "var Issue Record Id": "63798",
  "var Issue Id": "QKA-49715",
  "var Issue Type": "Task",
  "var Current Assignee": "<logged-in email>",
  "var Summary": "Team Cordination",
  "Action": "Add Worklog",
  "var Logged In User": "<logged-in email>",
  "Log Date": "2026-11-03T18:30:00.00",
  "Current Date": "2026-11-03T18:30:00.00",
  "Category": "Research",
  "Log Hours": "1.5",
  "Hours": "1",
  "Minutes": 30,
  "Billable Hours": "1",
  "Next Working Date": "2026-11-04T18:30:00.00",
  "Current Time": "2026-11-04T16:00:00.00",
  "Cut Off Time": "2022-12-28T05:30:00.00",
  "Is On Time": "Yes",
  "Worklog Late Entry Notification": "<p><span style=\"font-style: normal; font-weight: 400; text-indent: 0; white-space: normal; text-decoration: inherit; color: rgba(255, 0, 0, 1); font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;, &quot;Segoe UI Web&quot;, sans-serif; font-size: 12pt; background-color: rgba(255, 255, 255, 1); float: none; display: inline !important\">Please note</span><span style=\"font-style: normal; font-weight: 400; text-indent: 0; white-space: normal; text-decoration: inherit; color: rgba(255, 0, 0, 1); font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;, &quot;Segoe UI Web&quot;, sans-serif; font-size: 12pt; background-color: rgba(255, 255, 255, 1); float: none; display: inline !important\">&nbsp;t</span><span style=\"font-style: normal; font-weight: 400; text-indent: 0; white-space: normal; text-decoration: inherit; color: rgba(255, 0, 0, 1); font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, system-ui, &quot;Apple Color Emoji&quot;, &quot;Segoe UI Emoji&quot;, &quot;Segoe UI Web&quot;, sans-serif; font-size: 12pt; background-color: rgba(255, 255, 255, 1); float: none; display: inline !important\">hat it shall be considered as late log entry</span><br></p>",
  "var Log Efforts": "1.5",
  "Log Hours Instructions": "<p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><strong style=\"font-weight: 700\"><span style=\"font-size: 12pt\">Note :</span></strong></p><p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><span style=\"font-size: 12pt\">1. Please enter log hours as 1.5, if you have spent 1 hour 30 minutes.</span></p><p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><span style=\"font-size: 12pt\">2. Before you click on submit, please ensure that you have entered correct work log date.</span></p><p style=\"margin: 0 0 10px; color: rgba(51, 51, 51, 1); font-family: Roboto, sans-serif; font-size: 14px; font-style: normal; font-weight: 400; text-indent: 0; white-space: normal\"><span style=\"font-size: 12pt\">3. Once you submit you can't modify worklog date and hour, all you can modify description at later point</span></p>",
  "Log Description": "Test entry for API analysis: researched worklog field dependencies and request formats.",
  "var Worklog Date": "2026-11-03T18:30:00.00",
  "var Worklog Email Id": null,
  "Issue Id watchers": null,
  "Department": "Product",
  "Official Email Id": "<logged-in email>",
  "Report": "",
  "Watchers List": [],
  "Worklog Date Grid": [],
  "_AppId": "07022021-220225896-25e3fa6f-ac18-4835-8437-f0f460b9062f",
  "_AppName": "Worklog",
  "_CurrentStepNumber": 1,
  "_WorkSpaceId": "03012021-192624661-c4d2d235-e371-4983-973f-c82b074f9b21",
  "_OrganizationId": "29102019-093434548-a4fe41b0-1fd0-489a-ac08-a29b98883143",
  "_NextGroupName": "Done",
  "_IsCompleted": true,
  "_ExternalApiIds": "",
  "_InternalApiIds": "",
  "_DataFunctionIds": "",
  "_UserFunctionIds": "",
  "_UserId": "<logged-in user ID>",
  "_Username": "<logged-in email>",
  "_FullName": "<logged-in full name>",
  "_UpdatedUserId": "",
  "_UpdatedUsername": "",
  "_UpdatedEmailId": "",
  "_UserEmailId": "<logged-in email>",
  "_CreatedLocation": {
    "lat": "<captured latitude>",
    "lng": "<captured longitude>"
  },
  "_NextStepUsers": "",
  "_UpdatedLocation": "",
  "_WorkFlowAction": "Start - Submit"
}
```

### Response

The response includes AppData as a JSON-encoded string containing the stored
record. The remaining top-level response fields were:

```json
{
  "Success": true,
  "StatusCode": 0,
  "SuccessMessage": "",
  "ErrorMessage": "",
  "Data": "04112026-213658739-e7826adf-6775-4c7e-8c75-51d5871dd847",
  "Object": [],
  "Statuses": []
}
```

Normalization observed in stored AppData:

| Field | Request | Stored AppData |
|---|---|---|
| Minutes | number 30 | string "30" |
| Log Hours / Hours / Billable Hours / var Log Efforts | strings "1.5" / "1" / "1" / "1.5" | same strings |
| Dates | strings ending .00 | strings ending .000Z |
| Current Time | "2026-11-04T16:00:00.00" | number 57600 |
| Cut Off Time | "2022-12-28T05:30:00.00" | number 19800 |
| var Worklog Email Id / Issue Id watchers | null | empty strings |
| Watchers List / Worklog Date Grid | arrays [] | strings "[]" |
| _IsCompleted | boolean true | string "True" |

Server-added _CanbeEdited = false and _WorkFlowStatus = true.
_CreatedDate and _UpdatedDate both equal 2026-11-04T16:06:58.739Z.
Returned app-data ID: `04112026-213658739-e7826adf-6775-4c7e-8c75-51d5871dd847`.
No human-readable serial number was requested or returned in this exchange.

### Implications for add_worklog

- Category is its label "Research", not a lookup GUID.
- The outgoing summary key is **var Summary**, despite the UI label Summary.
- Project ID "70" and issue record ID "63798" are strings separate from QKA-49715.
- Workflow completes: _NextGroupName = "Done", _IsCompleted = true,
  _WorkFlowAction = "Start - Submit"; unlike leave, it does not enter Manager Approval.
- No GetNextSerialNumber or dependent-record fetch occurred during submission.
- Hidden worklog-email and watcher reference fields are null in this successful
  example. Previously fetched option values are not necessarily submission values.
- Hidden instructions and the late-entry notification HTML are still submitted.
- Browser geolocation is an object. Empty-location behavior in the extension is
  still unverified for Worklog.
- Current Time is 16:00:00 in the request, whereas the save is at 16:06:58 UTC.
  It may reflect initialization time. Verify before choosing executor clock semantics.

Still unverified: other fractions and numeric bounds; billable/log-hours
relationships; date/cutoff and holiday boundaries; context resolution without the
open issue row; existing-date worklog behavior; report filters; and additional
issue/category combinations. At that point no other writes had been made;
section 9 records the subsequent user-authorized direct API test.

## 9. Direct API validation on a different issue

Captured 2026-11-04. The user authorized creating a second real worklog via API,
without UI interaction. One POST write was made; no retry or deletion occurred.
Authenticated fetch ran in the existing logged-in page through Playwright MCP.
The token stayed in browser context and was not exported.

### API sequence and evidence

| Request | Call | Result |
|---|---|---|
| 251 | POST Report/GetViewResult, filtered by Issue Id Contains 35174 | One match: QKA-35174 |
| 252 | GET User/GetUserDetails | Current identity for payload |
| 253 | GET Lookup/GetLookupType, same Worklog Category ID | Confirmed Code Review is active |
| 254 | GET Organization/GetCurrentUTC | 2026-11-04T16:13:41.5863561Z |
| 255 | GET Organization/GetCalendar, same calendar ID | Monday–Friday working days |
| 256 | GET Organization/GetCalendarHolidays, same calendar ID | 16 holiday records |
| 257 | POST Datasource/GetReferencedDataSourceData | Department = Product, keyed on fresh user's email |
| 258 | POST Report/GetListReportData, Issue Id = QKA-35174 | Status/result read; __count = 0 |
| 259 | POST App/SaveAppData?appName=Worklog&users=&startDate=null&dueDate=null | HTTP 200, Success = true |
| 260 | Repeat request 258 | __count = 1; new row matches issue, category, hours, description |

No form, confirmation, payment-metadata, or option-list call was required for this
successful API submission. This establishes a working path for this example;
it does not establish all server-side requirements or bypass business validation.

### Issue-context resolver contract tested

```text
POST /api/Report/GetViewResult?skip=0&take=100&viewId=05072022-184836479-5888ab5b-d645-4e86-a937-f2d02d2414c1
```

```json
{
  "orderByFields": "",
  "filters": {
    "searchString": "",
    "columns": "Issue Id,Summary,Issue Type,Assignee,Project Name",
    "groupedColumns": "",
    "columnsOrder": "",
    "resizedColumns": [],
    "pageSize": 100,
    "filters": [],
    "sorting": [],
    "CustomUserViewFilters": [
      {
        "Order": 0,
        "ColumnName": "Issue Id",
        "ElementType": "TextBox",
        "ConditionType": "Contains",
        "Value": "35174",
        "IsEditable": true,
        "IsVisible": false,
        "SecondValue": "",
        "SelectedValues": [""]
      }
    ]
  }
}
```

Response: Status = true, results is a JSON-encoded array. It includes internal
fields despite the visible column selection:
- Issue Id: QKA-35174
- Project Id: string "70"
- Record Id: string "39209"
- Issue Type: Improvement
- Summary: Web app - Surveys creation
- Assignee: current user's email in this instance
- Project Name: QuickAdopt

The test required exactly one row and exact resolved ID QKA-35174 before writing.
Contains is only candidate discovery: a reusable action must check exact full ID
or unique numeric suffix, detect ambiguity, and never silently choose the first
match. This call uses an explicit filter, independent of the user's saved UI view.

### Read-back report contract

```text
POST /api/Report/GetListReportData
```

```json
{
  "ReportId": "05072022-184853727-5a6ca7a1-7af6-4e03-b9d1-1fe7ae99cea6",
  "UserId": "<freshly resolved user ID>",
  "ListScreenReportFilters": [
    {
      "DataSourceCollectionConditionLabelName": "Issue Id",
      "Value": "QKA-35174"
    }
  ],
  "skip": 0,
  "take": 100,
  "IsFromReportMappingDrillDown": false,
  "IsChartBasedReportGridCall": false
}
```

Response has Status, results (JSON-encoded rows), and __count.
Before: 0 rows. After: 1 row with:
- Issue Id: QKA-35174
- Worklog Category: Code Review
- Worklog Hours: number 1.5
- Worklog Date: 2026-11-03T18:30:00 (midnight 4 November in India)
- Worklog Description: API test entry: validating direct worklog submission and issue context resolution.
- Department: Product
- Log Entry Delay: 0

### Submission construction and differences from section 8

The body kept the section-8 constants, HTML, workflow fields and value types.
The following were explicitly resolved or replaced before sending:

| Payload field | Direct-API value / source |
|---|---|
| var Project Id | "70", from issue response |
| var Issue Record Id | "39209", from issue response |
| var Issue Id | "QKA-35174", from issue response |
| var Issue Type | "Improvement", from issue response |
| var Current Assignee | Assignee from issue response |
| var Summary | "Web app - Surveys creation", from issue response |
| Category | "Code Review", validated against fresh options |
| Log Hours / Hours / Minutes | "1.5" / "1" / number 30 |
| Billable Hours / var Log Efforts | "1" / "1.5" |
| Log Description | "API test entry: validating direct worklog submission and issue context resolution." |
| Log Date / Current Date / var Worklog Date | "2026-11-03T18:30:00.00" |
| Next Working Date | "2026-11-04T18:30:00.00" |
| Current Time | "2026-11-04T16:13:00.00" |
| Cut Off Time | Captured constant "2022-12-28T05:30:00.00" |
| Is On Time | "Yes", same-day entry |
| Department | "Product", from fresh email-keyed datasource response |
| var Logged In User / Official Email Id / _Username / _UserEmailId | Fresh user EmailId |
| _UserId / _FullName / _OrganizationId | Fresh user fields |
| _CreatedLocation | Empty string; accepted and stored as empty string |

The date came from fresh server UTC converted to India calendar day. Next working
date was calculated by advancing one day and checking working weekdays and returned
holiday dates. This tested a Wednesday-to-Thursday transition only; holiday and
weekend branches still require separate validation.

Save response:
```json
{
  "Success": true,
  "StatusCode": 0,
  "ErrorMessage": "",
  "Data": "04112026-214417289-3d6440f5-be84-4cda-8593-362daf101bbc"
}
```

The save response's AppData confirms the resolved issue, category, hours, description,
Done/True workflow completion, and empty location. Report read-back independently
confirms the worklog appeared. This validates direct submission on a second issue
and a different issue type/category, within the same QuickAdopt project.

### Remaining scope before/generalizing the action

- No claim of cross-project coverage: both captured issues belong to project 70.
- Prior checks for other numeric ranges, historical dates/cutoffs, duplicate daily
  entries, and alternate assignees remain outstanding.
- Both examples have empty watcher arrays; populated watcher behavior is untested.
- An empty geolocation value is now verified for this direct API path.
- Issue context and report query contracts above now have live API evidence.
- Implement the action with the existing approval/claim/cancellation path and
  avoid automatic retries after an uncertain write response.



