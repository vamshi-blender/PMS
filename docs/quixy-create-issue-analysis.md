# Quixy "Create Issue" form + "All Issues" report — reverse-engineering notes (IN PROGRESS)

> Being captured live (Playwright) per the method in [automated-form-learning.md](automated-form-learning.md),
> following the worked example in [quixy-leave-form-analysis.md](quixy-leave-form-analysis.md). This file is
> updated incrementally during the session, not just at the end, so learnings survive a context reset.

| | |
|---|---|
| **Module** | Project Management |
| **Report screen** | All Issues (active and closed) |
| **Report URL** | `https://quixyhome.kwixee.co.in/datasources/05072022-184836362-8b83d98c-3ab0-4266-aee8-2dd646f26bb0/views/05072022-184836479-5888ab5b-d645-4e86-a937-f2d02d2414c1` |
| **appId (Create Issue form)** | `03012021-232716197-f829ab09-a3ec-4cdf-8782-d3e74d9afa6a` |
| **Open form (fetched, not navigated URL)** | `GET https://quixyhomeapi.kwixee.co.in/api/App/GetApp?appId=03012021-232716197-f829ab09-a3ec-4cdf-8782-d3e74d9afa6a` then `POST App/GetAppWithPermissions` |
| **Trigger** | "Create Issue" button on the **All Issues report itself** opens it as an **in-place modal/slide-over dialog** without changing the URL. **A dedicated standalone page also exists** (user-confirmed): `https://quixyhome.kwixee.co.in/addrecord/03012021-232716197-f829ab09-a3ec-4cdf-8782-d3e74d9afa6a` — same `/addrecord/<appId>` pattern as the Leave form. Prefer driving this dedicated URL directly (avoids modal z-index/overlay click issues seen with the report's inline button). |
| **GetNextSerialNumber appElementId** | `01032021-011711238-571e17f3-cea4-446d-9293-48cbac134a2a` |
| **Status** | Form opened, field model captured via DOM snapshot; `GetAppWithPermissions` manifest body not yet parsed; not yet submitted |

---

## 0. Plan for this run

1. Open the **All Issues** report first (URL given) — capture its datasource call (GUIDs, columns,
   filter/search shape), menu path, and column model.
2. Find and open the **Create Issue** form from the same module — capture `GetAppWithPermissions`
   (fields, enums, rules, workflow) and the load-time data calls (option lists / auto-fill).
3. Drive every branch of Create Issue (issue type, priority, assignee pickers, any conditional fields).
4. Submit at least one real issue (staged instance — allowed) to capture the write payload.
5. Identify any standalone **lookups** worth exposing to Donna (e.g. "list my open issues", "issue status
   by ID") mirroring `getLeaveApplicationStatus` from the leave work.
6. Map filter/search capability on the All Issues report (equivalent of the report-side of leave status).

---

## 1. All Issues report — findings

**Screen type:** Datasource "List Screen" (Quixy report/grid), not a form. Title observed: *"one record - ds PM Manage Issues"*.

| | |
|---|---|
| **DataSourceView Name** | `ds PM Manage Issues` |
| **DataSourceId** | `05072022-184836362-8b83d98c-3ab0-4266-aee8-2dd646f26bb0` |
| **View Id** | `05072022-184836479-5888ab5b-d645-4e86-a937-f2d02d2414c1` |
| **AddOnId** | `09012025-173825404-01c87c5f-7936-48b9-bfff-5d9b044788fd` |
| **Underlying DataTableId (most columns)** | `03012021-222607498-32da6971-07ed-42f2-8906-75ec4ac26718` |
| **Underlying DataTableId (Sprint Name / Release)** | `03012021-230553450-a7ef5be2-0ce7-43c9-a3d4-0c8d5dd9cb09` |

There is a **"Create Issue" button** directly on this report screen (`ref=e121` in the first snapshot) —
same pattern as the leave form/status-report split, but here Quixy exposes create directly from the
list view. Need to click it to find the actual `addrecord/<appId>` URL / appId for Create Issue.

### Key API calls on load
| Call | Method | Purpose |
|---|---|---|
| `Datasource/GetDataSource?dataSourceViewId=…` | GET | datasource definition |
| `Datasource/GetDataSourceView?viewId=…` | GET | **the full column model** — ~70 columns w/ DataTableId per column, types, order (response was ~112KB; full column catalog transcribed in §1 below, scratch capture file since deleted) |
| `Datasource/GetDataSourceAddOn?dataSourceAddOnId=…` | GET | add-on config (buttons/actions available on the grid, e.g. Create Issue, Add Worklog, Add Comment) |
| `User/GetCustomUserViews?referenceId=<viewId>` | GET | the user's saved custom views/filters for this report |
| `Nlp/CreateNlpFilters?message=&type=Views&id=<viewId>` | POST | NLP-assisted filter suggestion endpoint (interesting: Quixy has its own NLP filter feature on this report) |
| `Report/GetViewResult?skip=0&take=100&viewId=<viewId>` | POST | **the actual grid data fetch** — this is the equivalent of Layer-A/D "rows" primitive, but for a *report view* rather than a raw datasource. Request body captured below. |

### `Report/GetViewResult` request shape (captured)
```jsonc
{
  "orderByFields": "",
  "filters": {
    "searchString": "",
    "columns": "Actions,Sub Tasks,Issue Id,Sprint Name,Issue Type,Summary,Status,Assignee",
    "groupedColumns": "",
    "rowHeight": null,
    "columnsOrder": "Actions,Sub Tasks,Issue Id,Sprint Name,Issue Type,Summary,Status,Issue Category,Sprint Rank,Reporter,Assignee,Created Date Time,Due Date,Updated On,Dependent Id,Priority,Estimated Hours,Logged Hours,Remaining Hours,Release,Browser,Bug Type,Detection Phase,Fix Branch,Injection Phase,Severity,Required Builds,Checkin Given Branch,Configurations Made,DB scripts,DB scripts exist,Impacted Features Of The Bug,Test Case Id,Project Name,Module,Sub Module,Resource Type,Release DateTime,Created DateTime,Bug Age,Client Name,Reporter Story Points,Assignee Story Points,Task Type,Feature,Sub Feature,Group Name,Bug Scenario,Coding Target Date,Test Cases Target Date,Unit Testing Target Date,Devbox Testing Target Date,System Testing Target Date,Impact Features Sharepoint Link,Issue Reproduced Or Not,Steps To Reproduce,Reason For Not Reproducing,POD,IssueType,Bug Fixed Date,POD Test Owner,POD Dev Owner,BA Owner,DB Type",
    "resizedColumns": [],
    "pageSize": 100,
    "filters": [],
    "sorting": []
  },
  "CustomUserViewFilters": [
    { "Order": 0, "ColumnName": "Issue Id", "ElementType": "TextBox", "ConditionType": "Contains",
      "Value": "QKA-49715", "IsEditable": true, "IsVisible": false, "SecondValue": "", "SelectedValues": [""] }
  ]
}
```

**IMPORTANT — this is a real "Layer A/D primitive for report views" shape, distinct from the leave form's
`Datasource/GetReferencedDataSourceData`.** Notice:
- `filters.filters` (empty array here) is likely the **structured filter list** (equivalent of `CustomUserViewFilters` but for ad-hoc, non-saved filters) — need to drive the UI's "Filter" button to see its shape when populated.
- `CustomUserViewFilters` is a **separate, persisted-per-user** filter (a saved/last-used view filter) — this session had a stray filter over `Issue Id contains "QKA-49715"` left over from prior use, which is why only **1 of otherwise-many records** showed. This is a good discovery: **user's last report filter state persists across sessions** — relevant to Donna if she ever needs to reset/clear filters before reading "all issues."
- `filters.columns` (short list, 8 cols) is the **visible/selected columns** for display; `filters.columnsOrder` is the **full ~70-column catalog** available to add. This maps directly to our existing `columns` projection feature in `pms_lookup` — Donna could request a subset the same way.
- `pageSize: 100`, `skip`/`take` in the URL query — standard pagination.

### Grid columns observed (visible, 8 of ~70 total)
Actions, Sub Tasks, Issue Id, Sprint Name, Issue Type, Summary, Status, Assignee

### One sample row captured
| Issue Id | Sprint Name | Issue Type | Summary | Status | Assignee |
|---|---|---|---|---|---|
| QKA-49715 | DAP Backlog | Task | Team Cordination | New | vamshisaikrishna.arelli@quixy.com |

### Full column catalog (from `columnsOrder`, ~70 cols — for future filter/projection mapping)
Actions, Sub Tasks, Issue Id, Sprint Name, Issue Type, Summary, Status, Issue Category, Sprint Rank,
Reporter, Assignee, Created Date Time, Due Date, Updated On, Dependent Id, Priority, Estimated Hours,
Logged Hours, Remaining Hours, Release, Browser, Bug Type, Detection Phase, Fix Branch, Injection Phase,
Severity, Required Builds, Checkin Given Branch, Configurations Made, DB scripts, DB scripts exist,
Impacted Features Of The Bug, Test Case Id, Project Name, Module, Sub Module, Resource Type,
Release DateTime, Created DateTime, Bug Age, Client Name, Reporter Story Points, Assignee Story Points,
Task Type, Feature, Sub Feature, Group Name, Bug Scenario, Coding Target Date, Test Cases Target Date,
Unit Testing Target Date, Devbox Testing Target Date, System Testing Target Date,
Impact Features Sharepoint Link, Issue Reproduced Or Not, Steps To Reproduce, Reason For Not Reproducing,
POD, IssueType, Bug Fixed Date, POD Test Owner, POD Dev Owner, BA Owner, DB Type

> Note: this is a **shared "Manage Issues" datasource that clearly also carries Bug-tracking fields**
> (Bug Type, Detection Phase, Severity, Steps To Reproduce, etc.) alongside generic issue fields
> (Sprint, Story Points, Feature). So "Issue" here is a superset entity covering Tasks, Bugs, Stories —
> the Create Issue form is likely **one form with conditional sections per Issue Type**, similar to how
> the leave form had per-leave-type conditional fields. **To verify next.**

### `GetCustomUserViews` — persisted per-user saved views (IMPORTANT finding)

This confirms Quixy has a **first-class "saved view" concept**: named, persisted filter+column+sort
presets per user, per report. Captured 4 real saved views for this user on this report:

| View Name | IsDefault | Filters (`CustomUserViewFilters`) | Sorting |
|---|---|---|---|
| `one record` | **true** (loads by default!) | `Issue Id` Contains `"QKA-49715"` | none |
| `Current Sprint - Bugs Excluded` | false | `Sprint Name` In `["DAP - 35"]` **AND** `Issue Type` Equal `"Improvement"` | `Sprint Rank` asc |
| `One Record New` | false | `Issue Id` Contains `"35698"` | none |
| `QuickAdopt Improvements` | false | `Project Name` Equal `"QuickAdopt"` **AND** `Issue Type` Equal `"Improvement"` | `Created Date Time` desc |

**This is a major, directly-relevant discovery for the term-mapping memory work:**
- The user has *already* saved a real term mapping in their own UI: **`Sprint Name In "DAP - 35"`** —
  i.e. a human at this org already encodes "current sprint" as the literal value `DAP - 35`
  (parallel to our hypothesized `Sprint 43 → DAP - 43`). This confirms the sprint-naming convention
  is `DAP - <number>` and that users do reference sprints by number in the UI, not just to Donna.
- **`IsDefault: true`** on a view named `"one record"` with an oddly narrow filter (`Issue Id
  Contains "QKA-49715"`) explains why our first `GetViewResult` call returned only 1 row — this
  is the **user's own default saved view being silently applied**, not a bug or session leftover.
  ⇒ **When Donna runs an "all issues" lookup, she must NOT rely on the user's default saved
  view** (it may be arbitrarily narrow, per-user, and unrelated to "all"). A generic `pms_lookup`
  for issues should bypass `GetCustomUserViews`/`IsDefault` entirely and call `GetViewResult` with
  an explicit empty/full filter set, the same way the leave lookups ignore any UI view state.
- `ConditionType` values seen so far: `Contains`, `Equal`, `In` (with `SelectedValues` array) — a
  richer operator set than the leave form's `equals/contains/between`. `In` implies multi-select
  filtering (e.g. multiple sprints or statuses at once) — worth supporting in the eventual
  `pms_lookup` filter schema for issues.

### Next actions for this section
- [ ] Clear/bypass the stray default view filter to see the full, unfiltered row count and confirm the fix above.
- [ ] Click the "Filter" button to capture the ad-hoc filter UI shape → maps to `filters.filters` (the empty array seen so far).
- [ ] Click "Group" and "Sort" to see if those are also client-side-only or hit the network.
- [ ] Read `GetDataSourceAddOn` response (call #101) — pending, not yet read (a fresh capture will be needed; the earlier scratch capture was deleted unread).
- [x] Read `GetCustomUserViews` response — done, captured above.

---

## 2. Create Issue form — load-time API inventory

**Navigation is different from Leave Application:** clicking "Create Issue" on the All Issues report
opens the form **as a modal dialog layered over the report** (SPA route does not change), not a
dedicated `/addrecord/<appId>` page. Both `App/GetApp` and `App/GetAppWithPermissions` still fire
exactly like the leave form.

| Call | Method | Purpose |
|---|---|---|
| `App/GetApp?appId=…` | GET | the app/form definition (shallow) |
| `App/GetAppWithPermissions` | POST | full form definition scoped to user — **not yet parsed in detail**, need to fetch/save body (large, likely 100KB+) |
| `App/GetAppComments?appId=…&appDataId=undefined` | GET | comments panel (appDataId undefined ⇒ new/unsaved record) |
| `DataTable/GetDataTableDataByReference` ×~11 | POST | option lists — many more than the leave form's 5, consistent with the much larger field set (Project, Issue Type, Resource Type, POD, Assignee, Fix Branch, Client Name, Priority, Sprint Name, Sprint Project Id, etc.) |
| `DataTable/GetReferencedDataTableData` ×1 (so far) | POST | dependent/auto-fill values |
| `Datasource/GetReferencedDataSourceConditionData` ×1 | POST | datasource option keys (likely Sprint or Project related) |
| `App/GetNextSerialNumber?appElementId=…` | GET | generates the Issue Id serial (**note:** the visible "Issue *" field showed a **pre-filled placeholder value `-53839`** before any save — need to confirm this becomes e.g. `QKA-53839` on submit, matching the `QKA-49715` pattern seen in the report) |

**Not yet fully explored:** more `DataTable/GetDataTableDataByReference` calls fired after this
snapshot (indices 149-154) as data table sections load asynchronously (e.g. the Sprint section
loaded slightly later — visible in the snapshot as a **second region** below the main fields with
Sprint Name/Start Date/End Date/Sprint Project Id/Sprint Id/Sprint Rank/Fix Branch, all initially
disabled — likely populated once a Project or Issue Type is chosen).

---

## 3. Data sources / GUIDs

_(pending — need to fetch full request/response bodies of the DataTable/Datasource calls above and
cross-reference with `GetAppWithPermissions`. The report's two DataTableIds are already known —
§1 above — and almost certainly reused here since Create Issue writes to the same "PM Manage
Issues" entity:)_
- `03012021-222607498-32da6971-07ed-42f2-8906-75ec4ac26718` (main Issue fields)
- `03012021-230553450-a7ef5be2-0ce7-43c9-a3d4-0c8d5dd9cb09` (Sprint Name / Release)

---

## 4. Field model (from DOM snapshot — form fields observed, not yet cross-checked against the definition)

Two visible sections in the modal: a **main section** and a **Sprint section** below it.

### Main section
| Label | Control type | Required (`*`) | Initial state | Notes |
|---|---|---|---|---|
| Project Name | Dropdown | | empty | |
| Issue *(Id?)* | TextBox | ✔ (labelled "Issue *") | pre-filled `-53839` | likely the serial-number preview; probably becomes `QKA-53839` (prefix TBD — confirm against `QKA-49715` pattern from the report) |
| Issue Type | Dropdown | ✔ | **disabled** initially | likely enabled after Project Name is chosen, or has a fixed/default value not yet resolved |
| Resource Type | Dropdown | | empty | appears **twice** in the snapshot (`ref=e372` and `ref=e396`) — possibly one is a hidden/duplicate templated node, or two genuinely different fields sharing a label; needs visual re-check |
| POD | Dropdown | | empty | (label shown oddly under a "Resource Type" combobox role — likely a mislabeled a11y snapshot artifact, re-verify visually) |
| Summary | TextBox | ✔ | empty | maps to the report's "Summary" column |
| Reporter Name | TextBox | | **disabled**, prefilled `Vamshi Sai Krishna Arelli` | auto-fill from logged-in user, same pattern as leave form's Employee Name |
| Reporter Email Id | Dropdown/Email | ✔ | prefilled `vamshisaikrishna.arelli@quixy.com` | auto-fill, editable dropdown (could reassign reporter) |
| Due Date | Date picker | ✔ | empty | |
| Assignee Name | Dropdown | | empty | maps to report's "Assignee" column |
| Status | TextBox | ✔ | empty, likely defaults to "New" per report sample row | |
| Description | Rich Text | | empty | full rich-text toolbar (bold/italic/tables/images/etc.) — same `RichText` element type as leave form's policy note, but here it's user-editable input, not a constant |
| Priority | Dropdown | | **disabled** initially | |
| Client Name | Dropdown | | empty | |
| Logged In User Email Id | TextBox | | **disabled**, prefilled | pure identity/plumbing field, mirrors `_UserEmailId` control block in leave payload |
| Attachments | File upload | | empty | |
| Estimated Hours | Number (spinbutton) | | empty | maps to report's "Estimated Hours" column |

### Sprint section (separate region, mostly disabled at open)
| Label | Control type | Required | Initial state | Notes |
|---|---|---|---|---|
| Sprint Name | Dropdown | ✔ | **disabled** | maps to report's "Sprint Name" (values look like `DAP - <n>` per §1 saved-view finding) |
| Start Date | Date | | **disabled** | sprint's own start date, auto-fill once sprint chosen |
| End Date | Date | | **disabled** | sprint's own end date |
| Sprint Project Id | Dropdown | | **disabled** | |
| Sprint Id | TextBox | | **disabled** | |
| Sprint Rank | Number | | enabled, prefilled `99999` | matches report's "Sprint Rank" column; `99999` looks like a "goes to bottom of backlog" default |
| Fix Branch | Dropdown | | **disabled** | matches report's "Fix Branch" column |

Also present: **"Save Draft"** button (top-right of modal, `ref=e338`) in addition to **"Submit"**
(`ref=e649`) — a workflow affordance the Leave form did not have. Need to determine if Save Draft
hits a different endpoint/verb (e.g. `_WorkFlowAction: "Save Draft"` vs `"Start - Submit"`) or is
purely local until a later explicit submit.

**Bug-tracking fields from the report's ~70-column catalog (Bug Type, Severity, Steps To Reproduce,
Detection Phase, etc.) are NOT visible in this initial Create Issue view** — confirms the hypothesis
from §1 that these are conditional, likely shown only when **Issue Type = Bug** (disabled at open
because Issue Type is not yet chosen). **Must select each Issue Type option to confirm.**

---

## 5. Mandatory fields

_(pending Playwright capture)_

---

## 6. Business rules observed

### Rule 1: Issue Type is disabled until Project Name is chosen
Confirmed by driving the dedicated `/addrecord/<appId>` page. On load, `Issue Type *` combobox is
`disabled`. Selecting **Project Name = "Quixy"** (options were `QuickAdopt` | `Quixy`) immediately:
- Fired **~15 `DataTable/GetDataTableDataByReference` calls** + 1 `GetReferencedDataTableData` + 1
  `Datasource/GetReferencedDataSourceConditionData` — i.e. **Project Name gates almost every other
  dropdown's option list** (Issue Type, Assignee, Sprint options, etc. are likely all filtered by
  the chosen project). This is a much heavier dependency graph than the Leave form's flat
  Employee-Code-keyed lookups.
- **Enabled** the `Issue Type *` dropdown.

### Rule 2: Issue Type enum (options may be Project-dependent — TBD)
With Project Name = "Quixy", **Issue Type options are: `Bug` | `Epic` | `Feature`** — only 3 values,
notably **not** matching `Task`/`Improvement` seen earlier in the report's saved-view filter values
(`Current Sprint - Bugs Excluded` had `Issue Type Equal "Improvement"`; the report's sample row had
`Issue Type = "Task"`). **Hypothesis: Issue Type's option list is filtered by the selected Project
Name** (e.g. QuickAdopt project may expose `Task`/`Improvement` while internal Quixy project exposes
`Bug`/`Epic`/`Feature`, or there's a broader master list only partially shown per project). **Must
verify by selecting Project = "QuickAdopt" and re-opening Issue Type.**

### Rule 3: Issue Id prefix is PROJECT-dependent, not a fixed "QXY-"/"QKA-" constant
With **Project Name = Quixy**, the `Issue *` field auto-updated from placeholder `-53841` to
**`QXY-53841`** the moment Project Name was selected (before Issue Type was even chosen). This
means the serial's prefix is **derived from the Project**, not a static app constant. The report's
sample row was `QKA-49715` — so **`QKA` is a different project's prefix** (possibly "QuickAdopt" —
matches the project name `QuickAdopt` seen in the Project dropdown and in a saved-view filter
`Project Name Equal "QuickAdopt"`). **Confirms: Project → Issue-Id-prefix mapping is a real,
learnable term mapping** (e.g. "QuickAdopt" ⇒ `QKA-`, "Quixy" ⇒ `QXY-`) — a second concrete example
for the term-mapping memory design, alongside `Sprint 43 → DAP - 43`.

### Rule 4: Selecting Issue Type = "Bug" reveals a whole conditional Bug sub-section
New fields appeared immediately (no network call observed — client-side show/hide, same pattern as
the Leave form's Half-Day-Type rule), inserted between "Issue Type" and "POD":
- **Features** (dropdown) + **Sub Features** (dropdown, disabled until Features chosen — nested 2-level conditional)
- **Regression Groups** (dropdown)
- **Bug Scenario** (dropdown)
- **DB Type** (dropdown)
- A static note block: **"Note: Please check previous bugs to avoid duplicates."** (a `RichText`
  constant, same role as the Leave form's month-boundary policy note — advisory, not enforced by
  the UI)

These map directly to columns already seen in the report's ~70-column catalog (`Feature`,
`Sub Feature`, `Bug Scenario`, `DB Type`, plus others not yet surfaced: `Bug Type`, `Severity`,
`Steps To Reproduce`, `Detection Phase`, `Injection Phase`, `Fix Branch`, `Required Builds`,
`Checkin Given Branch`, `Configurations Made`, `DB scripts`, `Impacted Features Of The Bug`,
`Issue Reproduced Or Not`, `Reason For Not Reproducing` — **likely revealed further down the form,
need to scroll/re-snapshot**, this snapshot may be truncated before those fields).

### Rule 5: Auto-filled defaults appear once Issue Type is set
- **Priority** auto-set to **"Medium"** (was disabled+empty before).
- **Status** auto-set to **"New"** (was empty before) — matches the report's sample row status.
- **Sprint Name** dropdown became **enabled** (was disabled).
- **Sprint Project Id** auto-populated to **`"7"`** (still disabled/read-only) — an internal numeric
  project identifier distinct from the Project Name text ("Quixy"/"QuickAdopt"). Another
  auto-fill/derived value, like the Leave form's Employee-Code-keyed auto-fills.
- **Fix Branch** dropdown became enabled.
- Sprint's **Start Date**/**End Date**/**Sprint Id** remain disabled — likely populate once a
  specific **Sprint Name** value is picked (not yet tested).

### Rule 6: Sprint Name values are PER-PROJECT — "Quixy" project uses "Sprint <n>", NOT "DAP - <n>"
Opened the Sprint Name dropdown (with Project = Quixy, Issue Type = Bug). Options observed:
`Backlog`, `Backlog ETS`, `Backlog- Hold`, `Closed`, `IPMS Productization`,
`Product stability program`, `Product stability program v2`, `Sprint 70`, `Sprint 72`, `Sprint 72-0`,
`Sprint 73`, `Sprint 74`, `Sprint 75`, `Sprint 76`, plus several odd auto-generated-looking names
(`Sprint Name08134959`, `Sprint Name09121300`, …) that look like **leftover test/junk data**, not
real sprints.

**This corrects/refines the earlier hypothesis from §1.** The `DAP - <n>` naming convention
observed in the report's saved view (`Sprint Name In ["DAP - 35"]`) is **NOT universal across
Quixy PM — it belongs to a different underlying project** (almost certainly **"QuickAdopt"**, whose
Issue Id prefix is `QKA-` per Rule 3, and whose saved view `QuickAdopt Improvements` filters
`Project Name Equal "QuickAdopt"`). The **"Quixy" project's own sprints are named plain `Sprint <n>`**
(e.g. `Sprint 76`), not `DAP - <n>`.

⇒ **Critical refinement for the term-mapping memory design**: the mapping is not just
`"Sprint 43" → "DAP - 43"` globally — it is **scoped per Project**. The correct mapping key must be
`(project, user's sprint number) → canonical sprint name`, e.g.:
  - QuickAdopt project: user says "Sprint 43" → canonical `"DAP - 43"`
  - Quixy project: user says "Sprint 76" → canonical `"Sprint 76"` (already literal, no mapping needed)

This is exactly the kind of scoping the memory-implementation doc's `pms_term_mappings` table
already keys by `(lookup_name, field_name, user_phrase)` — **should be extended to include
`project_name` (or a general 4th scope column) wherever Sprint Name (or any field) is filtered
differently per project.** Flagging this back to [memory-implementation-approach.md](memory-implementation-approach.md) as a refinement once that architecture is implemented.

The search box did **not** filter the list when typing "DAP" — either it needs an Enter/debounce, or
search is server-driven and this project simply has no `DAP` sprints (consistent with the
per-project-naming theory above). **Not yet confirmed whether typing triggers a network call** — check next.

### Rule 3a — CORRECTION: Issue Type has MORE options than first seen — `Bug|Epic|Feature|Improvement|Suggestion|Task`
On a **fresh page load** (not just re-selecting within the same session) with Project=QuickAdopt,
the Issue Type dropdown showed **6 options**: `Bug`, `Epic`, `Feature`, `Improvement`, `Suggestion`,
`Task` — not just the 3 seen earlier (`Bug`/`Epic`/`Feature`). This **fully reconciles** the earlier
puzzle (report showing `Task`/`Improvement` as historical values that seemed "retired"): **they are
NOT retired, they were simply not visible in the dropdown during the earlier drive** — likely because
that earlier dropdown list was mid-render/truncated, or scrolled, when captured. ⇒ **Issue Type is
confirmed to be a single global static enum of (at least) 6 values, same for every Project.** Revises
Rule 3/Rule 9's premise slightly: the field-diffing already done for Bug/Feature/Epic remains valid,
but **Improvement/Suggestion/Task still need their own field-diff pass** — treat as open questions,
not covered yet.

### Next actions (added)
- [x] Diff fields for Issue Type = Task, Improvement (Suggestion skipped — not needed). See Rule 11 below.

### Rule 6a — CONFIRMED: Project = QuickAdopt uses `DAP - <n>` sprint naming
Repeated the same drive with **Project Name = QuickAdopt**:
- `Issue *` auto-updated to **`QKA-53842`** — confirms **QuickAdopt ⇒ `QKA-` prefix** (Rule 3 fully verified).
- **Issue Type options are identical**: `Bug` | `Epic` | `Feature` (same 3, for both projects) — so
  Issue Type is a **static global enum**, not project-filtered. (Revises the Rule-3 hypothesis: the
  `Task`/`Improvement` values seen in the report's saved-view filters and sample row are **legacy/historical
  data values no longer offered in the create form's dropdown** — a case where the option enum has
  narrowed over time but old records still carry retired values. Donna must treat Issue Type filters
  as accepting historical values too, not just the current 3 create-time options.)
- **Sprint Name options for QuickAdopt: `Backlog`, `DAP - 37`, `DAP - 38`, …** — **exactly matches**
  the `DAP - <n>` convention from the report's saved view. This is now a **fully confirmed, not
  hypothesized, per-project term mapping**:

| Project Name (as typed/selected by user) | Issue Id prefix | Sprint naming convention |
|---|---|---|
| **Quixy** | `QXY-` | `Sprint <n>` (e.g. `Sprint 76`) |
| **QuickAdopt** | `QKA-` | `DAP - <n>` (e.g. `DAP - 37`) |

This table is the concrete ground truth the term-mapping memory (per
[memory-implementation-approach.md](memory-implementation-approach.md)) needs to seed/learn. A
user saying **"Sprint 43 of GuideNow"** (GuideNow being a marketing/product name for QuickAdopt,
per the earlier prompt) needs to resolve to filter value **`DAP - 43`** on the `Sprint Name` field,
scoped to **Project Name = QuickAdopt** — confirming the earlier refinement that the mapping key
must include the project scope, not just the field name.

### Rule 7 — CONFIRMED: Sprint Name auto-fills Start/End Date
Selected **Sprint Name = "DAP - 38"** (Project = QuickAdopt): `Start Date` auto-filled to
`06/04/2026`, `End Date` to `17/04/2026` (both fields stay disabled/read-only). This is a
**dependent-value auto-fill** (Layer B/D pattern), same role as the Leave form's Employee-Code → 
Date-of-Joining auto-fill. The exact request that produced it wasn't isolated yet — two
`Datasource/*` calls fired around the same time were for unrelated things:
- `GetReferencedDataSourceConditionData` (call captured) → keyed on `Issue Type=Bug` + `Project Id=70` → returned `[]` (empty) — this is actually the **Checklist/workflow-status datasource** (`OutputColumns` include `Checklist Hedder`, `Current Status`, `Next Status` — likely populates a hidden workflow-status dropdown, not sprint dates). Note: **`Project Id=70` here ≠ the `Sprint Project Id="7"` field shown for the Quixy project earlier** — these look like different numeric ids in different scopes; do not conflate.
- `GetReferencedDataSourceConditionData` (a different call, index 125) keyed on `Client Name` → returned a **Client Name master list** (42 real client/account names: Yum Brands - MENA, Tata Play, HMWSSB, Curacao, Quixy CRM, Navy Smartbase, etc.) — this is the **Client Name dropdown's option list**, unrelated to Sprint dates.
- **The actual Sprint→Date lookup call was not isolated in this pass** — needs a repeat with tighter before/after network diffing (fetch the network list immediately after clicking the Sprint Name option, before other calls interleave).

Also confirmed on the same snapshot: **`Sprint Project Id` auto-populated to `"70"`** and
**`Sprint Id` to `"1665"`** (both disabled) for QuickAdopt/DAP-38 — consistent internal numeric ids
distinct from the "7" seen for Quixy project earlier. So `Sprint Project Id` is really "numeric id
of the selected Project", reused/re-labeled inside the Sprint block (matches Rule 4's checklist call
which also used `Project Id=70` for QuickAdopt).

### Rule 8 — Full "Environment Details" section revealed for Issue Type = Bug (below Sprint section)
Scrolling past the Sprint block reveals a **third, Bug-specific section** with a heading
**"Environment Details"**, containing:

| Label | Control type | Required | Notes |
|---|---|---|---|
| Environment (rich text with a **structured template**) | RichText | | Pre-filled template with literal labels: `Environment:`, `Environment:`, `Domain:`, `EmailId:`, `Password:`, `UserType:`, `Environment Version:`, `Other Relevant Details:`, `App Details:`, `Data Table Details:`, `Additional Information:`, `Can Developer Perform Add Record:` — a **fill-in-the-blanks bug report template**, similar in spirit to the Leave form's constant policy note but here it's a starting scaffold the user edits, not a pure constant. |
| Is The Issue Reproduced In Any Other Instance | Radio | | options: `Reproduced` / `Not Reproduced` — maps to report column `Issue Reproduced Or Not` |
| Iteration | Dropdown | | maps to report's hidden `Iteration` column |
| Browser | Dropdown | | maps to report's `Browser` column |
| Bug Type | Dropdown | | maps to report's `Bug Type` column |
| Detection Phase | Dropdown | | maps to report's `Detection Phase` column |
| Injection Phase | Dropdown | | maps to report's `Injection Phase` column |
| Severity | Dropdown | | maps to report's `Severity` column |
| Test Case Id | TextBox | ✔ (labelled "Test Case Id *") | maps to report's `Test Case Id` column — **interesting: required specifically for Bug**, ties a bug to an existing/failing test case |
| Support Ticket Number | TextBox | | not seen in the report's ~70-column catalog — a **new field not previously captured**; likely links to the separate "Support Tool" module visible in the top nav |

This section, combined with Rule 4's fields (Features/Sub Features/Regression Groups/Bug
Scenario/DB Type), gives a near-complete map of the **Bug-only conditional field set**. Remaining
report columns not yet located in the UI: `Fix Branch` (seen, but as a Sprint-section field, not
Bug-section — interesting, Fix Branch is **not exclusive to Bug**, it showed up before Issue Type
was even set to Bug), `Required Builds`, `Checkin Given Branch`, `Configurations Made`, `DB scripts`,
`DB scripts exist`, `Impacted Features Of The Bug`, `Reason For Not Reproducing`, `Steps To
Reproduce` — likely further down, need one more scroll pass.

### Rule 9 — CONFIRMED: switching Issue Type = Feature removes ALL Bug-only fields and adds Feature-only fields
Changed Issue Type from `Bug` → `Feature` (same Project=QuickAdopt, Sprint=DAP-38 still retained —
confirms **Sprint/Project selections survive an Issue-Type change**, they are independent axes, not reset).

**Removed** (were only for Bug): Features/Sub Features, Regression Groups, Bug Scenario, DB Type,
the "check previous bugs" note, and the **entire "Environment Details" section** (Environment rich
text, Reproduced/Not Reproduced radio, Iteration, Browser, Bug Type, Detection Phase, Injection
Phase, Severity, Test Case Id, Support Ticket Number). **Test Case Id, previously required, is
gone entirely** — confirms it really was Bug-conditional-required, not globally required.

**Added** (Feature-only), inserted right after Issue Type:
| Label | Control type | Required | Notes |
|---|---|---|---|
| POD TestOwner | Dropdown | | maps to report's `POD Test Owner` column |
| POD DevOwner | Dropdown | | maps to report's `POD Dev Owner` column |
| BA Owner | Dropdown | | maps to report's `BA Owner` column |
| Issue Category * | Dropdown | ✔ | maps to report's `Issue Category` column — **required specifically for Feature**, was not present/required for Bug |

The Sprint section (Sprint Name/Start/End/Sprint Project Id/Sprint Id/Sprint Rank/Fix Branch)
**stayed identical** across Bug → Feature — confirms the **Sprint section is shared/global across
all Issue Types**, only the main-section fields between "Issue Type" and "Summary" are conditional
on Issue Type. This is a clean, well-scoped conditional-rule model: **Issue Type gates one
contiguous block of fields (+ the Bug-only Environment Details tail section); everything else
(Project, core identity, Due Date, Assignee, Status, Description, Priority, Client Name, Estimated
Hours, Sprint block) is common to all three types.**

**Not yet tested: Epic.** Given the pattern, Epic likely has its own small field set analogous to
Feature's `POD TestOwner/DevOwner/BA Owner/Issue Category`, or possibly none extra.

### Rule 10 — CONFIRMED: Epic has NO extra conditional fields
Switched Issue Type: Feature → Epic. Result: **zero extra fields** — form goes straight from
"Issue Type / Resource Type" to "Summary *", identical to the fully-generic common set. So the
conditional model is now fully mapped:

| Issue Type | Extra fields beyond the common set |
|---|---|
| **Bug** | Features, Sub Features, Regression Groups, Bug Scenario, DB Type, duplicate-check note, **+ full "Environment Details" section** (Environment richtext template, Reproduced radio, Iteration, Browser, Bug Type, Detection Phase, Injection Phase, Severity, Test Case Id *, Support Ticket Number) |
| **Feature** | POD TestOwner, POD DevOwner, BA Owner, Issue Category * |
| **Epic** | *(none — common set only)* |

### Rule 11 — CONFIRMED: Task and Improvement field diffs (Project=QuickAdopt)
Quick pass, no submits needed (field model only):

- **Task** adds exactly **one** extra field beyond the common set: a **"Task Type"** dropdown
  (inserted right after Issue Type/Resource Type). No other sections, no Environment Details.
- **Improvement** adds the **same extra set as Feature**: **POD TestOwner, POD DevOwner, BA Owner,
  Issue Category \*** — byte-for-byte identical field list to Feature's. So Feature and Improvement
  are functionally twins in the create form (likely differ only in downstream workflow/reporting
  semantics, not in what data they collect).

Updated full table:

| Issue Type | Extra fields beyond the common set |
|---|---|
| **Bug** | Features, Sub Features, Regression Groups, Bug Scenario, DB Type, duplicate-check note, **+ full "Environment Details" section** (Environment richtext template, Reproduced radio, Iteration, Browser, Bug Type, Detection Phase, Injection Phase, Severity, Test Case Id *, Support Ticket Number) |
| **Feature** | POD TestOwner, POD DevOwner, BA Owner, Issue Category * |
| **Improvement** | POD TestOwner, POD DevOwner, BA Owner, Issue Category * *(identical to Feature)* |
| **Task** | Task Type |
| **Epic** | *(none — common set only)* |
| **Suggestion** | *(not checked — out of scope per user)* |

### Next actions for this section
- [ ] Scroll further under Bug to double check there's truly nothing past Support Ticket Number (report columns Steps To Reproduce, Reason For Not Reproducing, Required Builds, Checkin Given Branch, Configurations Made, DB scripts, DB scripts exist, Impacted Features Of The Bug remain unaccounted for — likely populated only via record-edit/workflow steps, not at creation; confirm by opening an existing Bug record for edit).
- [ ] Isolate the exact Sprint-Name → Start/End Date/Sprint Id lookup call (network diff immediately after the click) — low priority, mechanism already empirically confirmed even without the exact call.
- [ ] Find where "GuideNow" (or other product nicknames) maps to "QuickAdopt"/"Quixy" as Project Name — check if Project Name dropdown itself has more entries beyond the 2 seen, or if GuideNow is purely a verbal/marketing alias with no separate PMS record.
- [ ] Capture Client Name field's role/DataSourceId (`16052023-200609180-bd3b4648-5d0e-4943-b651-d1f5840416af`) — already have its full option list (42 clients) which may itself be a useful lookup/filter dimension for issues later.
- [x] Field-level branch coverage (Bug/Feature/Epic diffed) — done.
- [x] Fill and submit one real issue per Issue Type (Bug, Feature, Epic — 3 runs, mirroring the Leave form's 3-way differential submit) — done, see §7 (Submissions #1–#3: `QKA-53842`/`QKA-53843`/`QKA-53844`).

---

## 7. Payload (write contract)

### Submission #1 — Epic, Project=QuickAdopt, Sprint=DAP-38 (real submit, captured 2026-07-22)
User confirmed proceeding with real test submits (mirroring the Leave form's differential-submit
approach) — issues clearly marked with `TEST - ignore -` summaries so they're easy to identify/clean
up later.

| | |
|---|---|
| **Endpoint** | `POST https://quixyhomeapi.kwixee.co.in/api/App/SaveAppData?appName=Create%20Issue&users=&startDate=null&dueDate=null` |
| **Created record** | `Issue Id = QKA-53842`, `_AppDataId = 22072026-123201378-5bc207b8-50e0-40b1-b43e-8b7bd91ec03d` |
| **Response** | `{"Success":true,"StatusCode":0,"Data":"<appDataId>", "AppData":"<full JSON record>"}` — same shape as the Leave form's response. |

### HEADLINE FINDING: Create Issue is a SINGLE-STEP workflow (no approval), unlike Leave Application
The response shows **`_IsCompleted: "True"`**, **`_NextGroupName: "Done"`**, **`_CanbeEdited: false`**,
**`_WorkFlowAction: "Create Issue - Submit"`**. Compare to the Leave form where submit produced
`_IsCompleted: false` / `_NextGroupName: "Manager Approval"` (a pending multi-step workflow). **Issue
creation is final and immediate — there is no approval gate.** This matters a lot for Donna: applying
`submit_pms_action` for "create issue" is **lower-risk to auto-execute post-approval-card** than leave
(no human approver downstream will silently reject it), but also means **there's no "it's just pending,
easy to walk back" safety net** — once submitted, the issue exists permanently (though `_CanbeEdited:
false` suggests the record may still be *editable* via a separate edit flow, just not further
workflow-advanceable — TBD).

### Full rendered payload (as returned in `AppData`, pretty-printed, real values from submission #1)
```jsonc
{
  // ---- identity / routing (constants + auto) ----
  "Team Member Project Name": "QuickAdopt",
  "Team Member Email Id": "vamshisaikrishna.arelli@quixy.com",
  "Project Name": "QuickAdopt",              // USER INPUT (dropdown)
  "Project Id": "70",                         // RESOLVED — numeric id for QuickAdopt (see Rule 6a/8)
  "Issue": "QKA-53842",                       // COMPUTED — prefix (QKA) derived from Project + serial number
  "Issue Id": "QKA-53842",                    // duplicate of "Issue" under a second key
  "Issue Type": "Epic",                       // USER INPUT (enum: Bug|Epic|Feature)
  "Project Key": "QKA",                       // RESOLVED — the prefix alone, separately from "Issue"
  "Issue Key": "53842",                       // RESOLVED — the serial alone, separately from "Issue"

  // ---- Bug-only fields (all empty — Epic doesn't populate them, but they're SENT anyway) ----
  "Resource Type": "", "Features": "", "Sub Features": "", "Task Type": "",
  "Regression Groups": "", "Bug Scenario": "", "DB Type": "[]",
  "Note": "<p>...Please check previous bugs to avoid duplicates....</p>",   // CONSTANT (RichText, always sent verbatim regardless of Issue Type)
  "Hidden Link Id": "", "POD": "",

  // ---- Feature-only fields (all empty — also sent regardless of Issue Type) ----
  "POD TestOwner": "", "POD DevOwner": "", "BA Owner": "", "Issue Category": "",

  // ---- common user-input fields ----
  "Summary": "TEST - ignore - Donna PMS learning run (Epic)",   // USER INPUT
  "Reporter Name": "Vamshi Sai Krishna Arelli",                 // AUTO-FILL (logged-in user)
  "Reporter Email Id": "vamshisaikrishna.arelli@quixy.com",     // AUTO-FILL, editable
  "Reporter Name and Email Id": "Vamshi Sai Krishna Arelli - vamshisaikrishna.arelli@quixy.com",  // COMPUTED concat
  "Due Date": "2026-07-24T18:30:00.000Z",     // USER INPUT, UTC = IST-5:30 (entered 07/25/2026 IST → stored 07/24 18:30 UTC, same rule as Leave form)
  "Updated ON": "2026-07-21T18:30:00.000Z",   // ⚠ appears to be "today" in UTC, NOT related to Due Date — likely a generic "last touched date" stamp, distinct from "_UpdatedDate"
  "Updated Date Time": "2026-07-22T06:56:00.000Z",  // ⚠ NOTE: this timestamp is EARLIER than the actual submit time (07:02 UTC) — possibly captured at form-open time, not submit time; needs more investigation, don't assume this is submit time
  "Assignee Name": "", "Assignee Email Id": "",   // USER INPUT, left blank (optional)
  "Status": "New",                             // AUTO-DEFAULT
  "lbl Issue Description": "Issue Description",  // CONSTANT (a section-heading label sent as a data field — Quixy pattern also seen for "lbl Custom Fields", "lbl Environment Details")
  "Issue Type Project Id": "70",               // RESOLVED (Issue-Type-scoped lookup key, Project-specific)
  "Issue Type Lookup Name": "Issue Type",       // CONSTANT — internal lookup-config plumbing
  "Description": "",                           // USER INPUT (RichText), left blank
  "Priority": "Medium",                        // AUTO-DEFAULT
  "Client Name": "",                           // USER INPUT, left blank
  "Logged In User Email Id": "vamshisaikrishna.arelli@quixy.com",  // AUTO-FILL, pure identity plumbing
  "Priority Project Id": "70", "Priority Lookup Name": "Priority",  // RESOLVED/CONSTANT plumbing, same pattern as Issue Type
  "Attachments": "[]",                         // USER INPUT (file upload), empty array when none
  "Estimated Hours": "",                       // USER INPUT, left blank

  // ---- custom fields plumbing (always empty in this run) ----
  "lbl Custom Fields": "Custom Fields", "cf Project Id": "", "cf Issue Type": "",

  "Project Category": "Product",               // RESOLVED — from Project Name (QuickAdopt ⇒ "Product"; Quixy's category not yet captured)
  "Status Project Id": "70", "Status Issue Type": "Bug",  // ⚠ ODD: "Status Issue Type" = "Bug" even though we submitted an EPIC — looks like a stale/default value from the Status lookup's own internal scoping, not reflective of the actual Issue Type. Needs verification — could be a Quixy quirk where the Status master data is keyed by a default/first Issue Type regardless of the actual one chosen.
  "Is Initial Status": "Yes",                  // COMPUTED — true because Status="New" is the workflow's initial state

  // ---- Sprint block ----
  "Sprint Name": "DAP - 38",                   // USER INPUT
  "Start Date": "2026-04-05T18:30:00.000Z",    // RESOLVED (auto-fill from Sprint Name, UTC-shifted; UI showed 06/04/2026 IST)
  "End Date": "2026-04-16T18:30:00.000Z",      // RESOLVED (UI showed 17/04/2026 IST)
  "Sprint Project Id": "70", "Sprint Id": "1665",  // RESOLVED — internal ids for the chosen sprint
  "Sprint Rank": "99999",                      // USER INPUT (spinbutton), left at default
  "Fix Branch": "", "Fix Branch Project Id": "70", "Fix Branch Lookup Name": "Fix Branch",  // USER INPUT (blank) + plumbing

  // ---- Environment Details block (Bug-only UI fields — all sent empty for Epic) ----
  "lbl Environment Details": "Environment Details",  // CONSTANT
  "Environment": "<p>Environment: ... Can Developer Perform Add Record:</p>",  // CONSTANT template (same as UI scaffold, unedited)
  "Is The Issue Reproduced In Any Other Instance": "", "Reason for unable to reproduce": "",
  "Mention the steps to reproduce": "",         // ⚠ NEW FIELD NAME — this is the actual payload key for what the report calls "Steps To Reproduce" / "Reason For Not Reproducing"! Confirms those report columns ARE created here, just under different internal key names than their display labels (another Leave-form-style "key ≠ label" case).
  "Iteration": "", "Iteration Project Id": "70", "Iteration Lookup Name": "Iteration",
  "Browser": "", "Browser Project Id": "70", "Browser Lookup Name": "Browser",
  "Bug Type": "", "IssueType": "",              // ⚠ note BOTH "Issue Type" (top) and "IssueType" (no space, here) exist as separate keys — "IssueType" appears to be Bug-specific sub-classification, not a duplicate
  "Detection Phase": "", "Detection Phase Project Id": "70", "Detection Phase Lookup Name": "Detection Phase",
  "Feature Or Improvement": "", "Group Or Category": "", "Select Feature ID": "",
  "Summary of feature": "", "Select Improvement ID": "", "Summary of Improvement": "",  // ⚠ NEW FIELDS not seen in the UI at all during this run — likely surface for OTHER historical Issue Type values (Task/Improvement) that are no longer offered in the create dropdown but still have payload slots (ties back to Rule 6a's note about retired enum values)
  "Injection Phase": "", "Injection Phase Project Id": "70", "Injection Phase Lookup Name": "Injection Phase",
  "Severity": "", "Severity Project Id": "70", "Severity Lookup Name": "Severity",
  "Test Case Id": "",
  "Support Ticket Number": "",
  "Bug Type Project Id": "70", "Bug Type Lookup Name": "Bug Type",

  "Email Id": "vamshisaikrishna.arelli@quixy.com",   // yet another identity-email key (3rd one: Reporter Email Id, Logged In User Email Id, Email Id)
  "Project Id for Chklist": "70", "Issue Type Chklist": "Epic", "Cheklist": "[]",  // ⚠ MISSPELLED key "Cheklist" (sic) — Leave-form-style misspelling preserved; ties to the checklist datasource call seen in Rule 4/8 (Datasource/GetReferencedDataSourceConditionData keyed on Issue Type + Project Id)
  "Custom Fields": "[]",

  // ---- control / workflow envelope ----
  "_AppId": "03012021-232716197-f829ab09-a3ec-4cdf-8782-d3e74d9afa6a",
  "_AppName": "Create Issue",
  "_CurrentStepNumber": "1",
  "_WorkSpaceId": "03012021-192624661-c4d2d235-e371-4983-973f-c82b074f9b21",
  "_OrganizationId": "29102019-093434548-a4fe41b0-1fd0-489a-ac08-a29b98883143",
  "_NextGroupName": "Done",              // ⚠ single-step workflow — see headline finding above
  "_IsCompleted": "True",
  "_UserId": "17062024-181413146-241121e4-6644-481f-a0ea-ddf9e3832575",
  "_Username": "vamshisaikrishna.arelli@quixy.com",
  "_FullName": "Vamshi Sai Krishna Arelli",
  "_UserEmailId": "vamshisaikrishna.arelli@quixy.com",
  "_CreatedLocation": "{ \"lat\": 17.41197..., \"lng\": 78.33660... }",   // ⚠ NEW vs Leave form — geolocation captured at submit time! Leave form payload had no location field. Privacy-relevant: Donna/the extension does not currently pass geolocation, so submitting via the API (not real browser geolocation) may submit blank/0,0 — needs testing.
  "_WorkFlowAction": "Create Issue - Submit",   // the verb, mirrors Leave's "Start - Submit"
  "_id": "22072026-123201378-5bc207b8-50e0-40b1-b43e-8b7bd91ec03d",
  "_CreatedDate": { "$date": "2026-07-22T07:02:01.378Z" },
  "_UpdatedDate": { "$date": "2026-07-22T07:02:01.378Z" },
  "_CanbeEdited": false,
  "_WorkFlowStatus": true,
  "_AppDataId": "22072026-123201378-5bc207b8-50e0-40b1-b43e-8b7bd91ec03d"
}
```

**Note:** the raw request body for this submission was captured to a scratch file but deleted before
being diffed against the response above — the request is what the client actually SENT; the response
`AppData` is what the server actually STORED/rendered, and these can differ in derived fields. If
this distinction matters later, re-capture the request body on a fresh submit (`browser_network_request`
with `part: "request-body"` on the `SaveAppData` call) rather than relying on the response alone.

### Gotchas already visible from this single submission (Leave-form-style traps)
1. **Every field for every Issue Type is sent on every submit, populated or empty.** There is no
   per-Issue-Type payload subset — a payload builder must always emit the FULL ~90-key envelope
   (all Bug fields + all Feature fields + all common fields), leaving irrelevant ones as `""`/`"[]"`.
   This is a bigger, flatter version of the Leave form's "same ~70-field envelope every time" finding.
2. **Key ≠ label, again, multiple times**: `"Mention the steps to reproduce"` is the real key for the
   UI's "Steps To Reproduce"-equivalent concept; `"Cheklist"` (sic) mirrors the Leave form's `"Leave
   Tyoe"` misspelling pattern — **never "correct" these when building a payload**.
3. **Geolocation (`_CreatedLocation`) is captured at submit** — not present in the Leave form's payload
   at all. Must determine whether Quixy's backend requires this or tolerates its absence/zeros when
   submitted via a non-browser (extension/API) client.
4. **`"Status Issue Type": "Bug"` despite submitting an Epic** — flagged as suspicious, needs
   confirmation via a second run with a different Issue Type to see if this key ever changes, or if
   it's always "Bug" (a possible master-data default/bug in Quixy itself, unrelated to our payload).
5. **Timestamps (`Updated ON`, `Updated Date Time`) don't obviously correspond to "now"** at submit
   time — do not assume these can be safely client-computed the way the Leave form's `Date Time Stamp`
   could; may need to be left as whatever the last-loaded value was, or investigated further before
   a payload builder synthesizes them.

### Submission #2 — Feature, Project=QuickAdopt, Sprint=DAP-39 (real submit, captured 2026-07-22)
Filled `Issue Category = "Roadmap"` (its dropdown options were: `Roadmap`, `Client Request`,
`Tech Debt`), `Summary`, `Due Date`, `Sprint Name = DAP - 39`. Result: `Issue Id = QKA-53843`.

**Key diffs vs Submission #1 (Epic):**
| Field | Epic (#1) | Feature (#2) |
|---|---|---|
| `Issue` / `Issue Id` | `QKA-53842` | `QKA-53843` (serial incremented by 1 — confirms it's a simple sequential counter, shared across ALL Issue Types within a project, not per-type) |
| `Issue Type` | `Epic` | `Feature` |
| `Issue Category` | `""` | `"Roadmap"` — now populated |
| **`Status Issue Type`** | `"Bug"` ⚠ | **`"Feature"`** ✅ | 
| `Sprint Name` / dates / ids | DAP-38 / 1665 | DAP-39 / 1666 (sequential sprint ids too) |
| `_CreatedLocation` | lat 17.411970656..., lng 78.336603999... | lat 17.411972348..., lng 78.336604835... (near-identical — same physical/IP-based location both times, as expected) |

**RESOLVES the earlier flagged oddity**: `Status Issue Type` DOES correctly reflect the submitted
Issue Type (`"Feature"` here, not stuck at `"Bug"`). The Epic submission's `"Bug"` value is therefore
suspicious specifically **for Epic** — hypothesis: **Epic may not have its own Status-lookup config
in Quixy's master data, and silently falls back to Bug's status set** (consistent with Epic having no
extra UI fields at all — it may be the most "generic"/least-configured Issue Type). Not fully
confirmed, but no longer looks like a general payload-building bug — safe to treat `Status Issue
Type` as **reliably mirroring the actual Issue Type for Feature/Bug**, with **Epic as a known
exception to double check** if it matters for a filter/lookup later.

### Next: submit Bug to complete the 3-way differential
- [x] Submit a **Bug** issue (Project=QuickAdopt) with real values in the Bug-only fields (Severity, Test Case Id, reproduction fields) — done, see Submission #3 below; confirmed `Status Issue Type = "Bug"`.
- [ ] Diff all 3 payloads to build a formal field-classification table for this form (mirroring §7 of the Leave analysis: user_input / computed / resolved / constant / workflow / runtime buckets) — the classification is scattered inline across Submissions #1–#3 below but not yet consolidated into one table.

### RESOLVED — root cause of the stuck Bug submission was a UI overlay, not a validation error
**Root cause found:** the fixed-position bottom button bar (`class="btns-bottom-fixed print-hide"`,
which contains the Submit button) **overlaps/intercepts pointer events over the lower part of the
form** (confirmed directly: Playwright's own click-retry diagnostics reported `<div ...
class="btns-bottom-fixed print-hide"> intercepts pointer events` when trying to click the
"Not Reproduced" radio button, which sits lower on the page). Ordinary `element.click()` (and even a
raw `page.mouse.click()` at the Submit button's own screen coordinates) landed on/was swallowed by
this overlay and **never reached the real Submit handler** — no JS error, no validation error, just
silently no-op. **Fix: focus the Submit button and press Enter (keyboard activation) instead of a
pointer click** — this bypasses the overlay entirely and worked immediately.

**Practical implication for future Playwright drives of this app**: if a click on a fixed-position
action button (Submit, Save, etc.) appears to silently do nothing (no network call, no error), try
keyboard activation (`.focus()` + `Enter`) before assuming a validation/business-logic block. This
is a UI-framework quirk (Syncfusion/Angular fixed-footer overlap), not a Quixy business rule.

Also worth noting for a real automated executor (not Playwright-UI-driven): **this entire
overlay-interception problem is irrelevant** — Donna/the extension will call `SaveAppData` directly
via `pmsFetch`, never simulating clicks, so this gotcha is purely a lesson for *this analysis
methodology*, not for the eventual manifest/executor implementation.

### Submission #3 — Bug, Project=QuickAdopt, Sprint=DAP-Backlog (real submit, captured 2026-07-22)
Filled: Severity="High", Test Case Id="TC-TEST-001", Is The Issue Reproduced In Any Other Instance =
"Not Reproduced" (revealed a further conditional textbox **"Reason for unable to reproduce"**, filled
with "N/A - test issue" — confirms this field is itself conditional on the radio choice, a
second-level nested conditional). Result: **`Issue Id = QKA-53844`**.

**Confirms, with real data this time:**
- **`Status Issue Type: "Bug"`** — now matches the actual Issue Type submitted, fully closing out the
  earlier "Status Issue Type stuck at Bug for Epic" question: Bug submissions correctly show `"Bug"`,
  Feature correctly showed `"Feature"` (Submission #2) — **only Epic showed the anomalous `"Bug"`
  value**, reinforcing the hypothesis that Epic has no distinct Status-lookup config and falls back
  to Bug's.
- **`cf Issue Type: "Bug"`** — this "Custom Fields" plumbing key was empty (`""`) in both prior
  submissions (Epic, Feature) but populated here. Another Bug-specific behavior to note.
- **Sprint dates empty for "DAP Backlog"**: `"Start Date": ""`, `"End Date": ""` — unlike DAP-38/
  DAP-39 which had real dates. **"Backlog"-type sprints (DAP Backlog, DAP - Hold, plain "Backlog")
  have no start/end date**, only real numbered sprints do. Useful for a payload-builder/lookup to
  know: don't assume every Sprint Name resolves to non-empty dates.
- All Bug-only fields correctly populated: `Severity: "High"`, `Test Case Id: "TC-TEST-001"`,
  `Is The Issue Reproduced In Any Other Instance: "Not Reproduced"`,
  `Reason for unable to reproduce: "N/A - test issue"`. `Features`/`Sub Features`/`Bug Scenario`/
  `DB Type`/`Iteration`/`Browser`/`Bug Type`/`Detection Phase`/`Injection Phase`/
  `Support Ticket Number` all still empty (not filled in this run — left as an exercise, their
  presence/shape is already confirmed from the field model in §6).

### 3-way differential submit — COMPLETE
All three Issue Types now have a real captured payload: Epic (`QKA-53842`), Feature (`QKA-53843`),
Bug (`QKA-53844`) — sequential serials confirm a single shared counter per Project, not per Issue
Type. This completes the differential-submit phase of the methodology (§7 header goal). Remaining
work is lower-priority polish (Task/Improvement/Suggestion field-diffs, exact Sprint→Date lookup
call, GuideNow naming question) rather than core payload/rule discovery.

---

## 8. Navigation & menu mapping

_(pending Playwright capture)_

---

## 9. Open questions

_(pending)_
