# PMS environments

One extension supports staging (`quixyhome.kwixee.co.in`) and production
(`vividminds.quixy.com`). API and OIDC origins live in
`chrome-extension/src/api/pmsEnvironment.ts`. Tokens stay in the browser and are
read from the selected environment's tabs in the active Donna group.

Every text run and voice session captures an environment, PMS user, organization,
and browser-session ID. Each PMS call rechecks these values. Token refreshes for
the same user are accepted; account changes, expired logins and environment/group
switches stop the call. Switching away and back invalidates previous approvals.
An already dispatched write cannot be rolled back by cancellation; uncertain
writes are never retried automatically.

Approvals carry the conversation ID and a SHA-256 fingerprint of the exact tool
name/arguments. The backend checks the binding at claim and resume; the extension
checks it and the live PMS identity before execution. Approval descriptions show
the environment. Historical pending approvals cannot be resumed after reloading.

OpenAI conversation metadata records the environment and owner. Existing
unlabelled staging conversations are adopted once. Unlabelled production
conversations from the UI-only rollout require a new chat. Local histories and
last selections are separated by environment and user; legacy history migrates
once. Manifest caches are separated by environment and backend origin. Backend
and extension must both use bundle version 7.

The backend receives identity assertions, not a PMS bearer token. These bindings
prevent accidental cross-environment execution; they do not replace backend
authentication or rate limiting for an organization-wide deployment. The existing
in-memory approval store still requires the same server process for claim/resume.

## Production contracts verified on 11 November 2026

All nine public lookups and their employee/department/calendar dependencies were
verified with read-only production requests. App IDs, payload fields and referenced
IDs match the shared manifests. Production issue-worklog reports return
`Status=false` with valid rows; their parser validates rows and explicit errors.

Each production action checks a live form fingerprint before running its
resolvers. Fingerprints cover field types, reference definitions, calculations,
nested grid definitions, validations, business rules and workflow. Changes stop
the action until the manifest configuration is reviewed and reverified. Labels,
styling and user-specific permission summaries are excluded.

Production leave additionally resolves the form's attendance-unblocking datasource
for every requested date. Dates older than seven India calendar days require a
server-owned `Autogenerate` unblock record. Blocked, duplicate, missing or invalid
dates stop before serial allocation. The resulting validation grid goes into the
submission. Staging retains its existing leave contract.

Worklog and status-change preparation were exercised using the actual executor
with a browser adapter that only permits read APIs and rejects SaveAppData.
Leave preparation was exercised up to the blocked GetNextSerialNumber call.
No production records or serial numbers were created. Automated tests cover
mocked submissions for all three actions; a controlled live production submission
remains a manual rollout check.

## Manual rollout checks

Attendance and worklog lookups accept a single `date`/`logDate` or inclusive
`fromDate`/`toDate` (up to 366 days). Use `excludeWeekends: true` when Saturday and
Sunday are off. Attendance uses literal India dates; worklog report bounds use
shifted timestamps through the end of the final India date, including entries
whose stored timestamp is not midnight. The worklog API may include adjacent dates
because it filters stored UTC dates; the executor trims the verified one-day
boundary spill in India time. Both reports paginate internally (500 rows/page,
5,000 entry limit) and validate employee identity and dates before
computing complete daily/weekly summaries. Detail rows remain capped at 50.
Missing attendance dates/hours stay unknown; no worklog entries means nothing
logged, not proof of absence. Weekly `knownHours` includes only returned hours.
Weeks start Monday; first/last weeks are clipped to the requested range. Holidays
are not automatically excluded.

- Deploy the backend and reload the rebuilt extension together.
- With both PMS environments open, check issue details, daily worklogs and attendance.
- Confirm each environment restores its last chat and has separate Recents.
- Switch environments with an approval pending; confirm it cannot execute later.
- Log out or change accounts before approval; confirm the request stops.
- Submit one intentional worklog in each environment and verify the record in that PMS.
- Verify leave (including an HR-unblocked backdate) and an allowed issue transition
  using records intended for those tests.
