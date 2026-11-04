# Add worklog

`add_worklog` uses the same text-chat approval, execution claim, cancellation
and resume flow as `create_leave_application`. It creates a real Worklog
record and completes its workflow as Done.

## Conversation and execution

1. Donna calls `pms_lookup` with `getIssueContext` and the user's exact
   `issueId`. A full prefix must match exactly. A bare number must resolve
   uniquely across all candidate pages; ambiguity or incomplete searches stop.
2. `getWorklogCategories` supplies current active labels. Donna collects log
   date, category, log hours and description. Billable hours default to log hours;
   Donna does not ask separately. An explicit billable-hours value (including
   zero) overrides that default. Null or omitted values default in the executor,
   and the approval card displays the effective billable hours.
3. Donna requests `submit_pms_action` with actionName `add_worklog`.
   Fields include canonical full `issueId` and the resolved `issueSummary`.
   The approval description is built from these actual fields, including hours,
   billable hours and description.
4. After approval/claim, the extension re-fetches issue context, department,
   category options, server time and working calendar. A changed summary or
   inactive category requires a fresh lookup and approval.
5. The worklog calculation strategy derives hours/minutes, India calendar dates,
   next working date and Is On Time. The manifest renders the captured payload.
6. One SaveAppData call submits it. There is no serial-number fetch and no
   automatic write retry. The result includes the returned app-data ID.

`getIssueWorklogs` reads existing worklogs for an issue. Like
`getIssueContext`, it accepts `issueId`; no saved UI view is needed.
Issue fields, department and worklog rows are projected locally before results
can reach the model.

If `QKA-39545` is absent and `AGHR-39545` exists, execution fails rather than
switching prefixes. Donna must ask the user to correct the ID. If both exist,
the exact full ID is used. Bare-number submissions are rejected: resolve them
first so the approval shows the canonical ID and summary.

## Deployment

Deploy the backend and rebuild/reload the extension together:

```powershell
npm run build
npm run build --prefix chrome-extension
```

Bundle version is now 4 because the extension supports new source contracts and
worklog calculations. Older extensions reject newer bundles and need updating.
Voice exposes the new read-only lookups; writes continue through the text-chat
approval interface, as they do for leave.

## Validation and scope

`tests/worklog.test.ts` exercises actual executor and transport code using mocked
PMS responses: issue resolution, prefix/substring rejection, pagination ambiguity,
changed issue/category rejection, captured payload types, calendar/decimal
calculations, cancellation, no automatic retries, and leave compatibility.
The tests do not create real records.

Live evidence in [quixy-worklog-form-analysis.md](quixy-worklog-form-analysis.md)
includes a UI submission for QKA-49715 and direct API submission for QKA-35174,
with independent report read-back. Both belong to QuickAdopt; cross-project
permissions and populated watcher lists have not been live tested.

Calendar calculations follow the returned calendar and captured form rules,
including the 05:30 UTC cutoff. Only same-day submissions and an ordinary
next-working-day transition have live evidence; historical/cutoff and
weekend/holiday branches have unit coverage but still need live confirmation.
No undocumented daily-hour limits or billable-versus-log-hour restrictions are
invented. Decimal hours must be nonnegative finite strings.

Stop aborts pending requests and prevents further execution, but cannot undo a
write the PMS has already accepted. If a save response is uncertain, inspect
existing worklogs before deciding whether another user-approved attempt is needed.

## Daily logged-hours lookup

`getMyWorklogs` accepts `logDate` (YYYY-MM-DD in India), automatically uses the
logged-in user's email, and queries GetReferencedDataTableData with both date
and email references. It returns `totalHours`, `entryCount`, date/timezone and
a capped detail list. Totals use all returned rows before the display cap;
invalid hours, malformed responses or unexpected row dates cause an error.
Donna resolves today/yesterday with the hidden prompt timestamp before calling it. This
read-only lookup does not need a submission approval card.

Live read-only verification on 4 November 2026 returned five entries totaling
7 hours. No worklogs were added during that check. The source returns date,
hours, description and worklog ID; it does not supply issue IDs or billable
hours, so those breakdowns are not claimed by this lookup.
