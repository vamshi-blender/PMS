# Issue status changes

`getAllowedIssueStatuses` resolves the exact issue and reads its live form and
project/type/current-status flow. With `newStatus` and optional `details`, it
returns visible transition fields, current choices, required flags, validation
errors, and any requirements that need the PMS screen. No write occurs.

`change_issue_status` uses the existing approval/claim/resume path. Approval shows
the issue ID, summary, current/target statuses and supplied details. Execution
re-fetches the issue, allowed transitions and user-scoped form definition; runs
conditional visibility and submission validation; resolves status indicators,
RCA, story points and watcher/configuration references; renders the manifest;
and checks the issue again immediately before a single SaveAppData call.

The rule interpreter handles the condition/action types verified in the real
form and rejects unsupported new types. Explicit CONDITION-n expressions number
leaf conditions through nested groups. A visible field is not automatically
required: the form's actual validations determine that.

Verified rules include branch/component choices, configuration/DB-script
answers and descriptions, impact features and server-resolved RCA for Bug/Fixed;
remarks for Design Completed to Design Review; and visible required details for
Improvement/Coding review. Upload-required transitions direct the user to PMS;
chat cannot fabricate file metadata. Reviewer fields that require a user selector
also require the PMS screen when visible. The live form remains authoritative.

The next-status API is DataTable/GetDataTableDataByReference, parameterized from
the form's status-flow reference. The write is App/SaveAppData with appName
Change Issue Status. No separate serial number is fetched. Unknown/stale IDs,
unavailable transitions, changed summaries/statuses, missing details and failed
dependencies stop before saving. No write is automatically retried. The API does
not expose an atomic compare-and-swap contract; the final read narrows but cannot
eliminate a race with another user's simultaneous edit.

Live staging verification on 5 November 2026 used the actual executor with only
authentication/bundle adapters for the browser harness: QKA-49715 moved from
In Progress to Resolved and was independently read back as Resolved. Tests use a
trimmed copy of the captured form definition and make no live API calls.

Bundle version 5 requires updating the backend and rebuilding/reloading the
extension together. Voice can read allowed transitions and requirements; writes
remain in text chat's approval flow.
