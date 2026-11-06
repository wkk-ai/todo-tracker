# Workspace release

Selected direction: **D — Workspace**, 6 November 2026. A quiet sidebar opens Today, Capture, Meetings and Knowledge. Work and source context share the main screen. Advanced planning stays secondary.

## Design benchmarks

- [Linear](https://linear.app/now/behind-the-latest-design-refresh): quieter navigation, stable headers, less visual emphasis on secondary controls.
- [Things Quick Entry](https://culturedcode.com/things/support/articles/2249437/): immediate capture, consistent shortcuts and unobtrusive context.
- [Agenda](https://agenda.com/manual/en/dates-events-and-reminders/): explicit event links and dated notes.
- [Obsidian backlinks](https://obsidian.md/help/plugins/backlinks): source passages and understandable links between conversations.

These are interaction references. The implementation uses the app's cream/green palette and system typography; it does not copy another product's code or artwork.

## Behavior

Capture is independent of people and meetings. The first typed character establishes an immutable capture time, timezone and offset. A stable bullet ID supports retry. Clear actions are added automatically using conservative local phrase rules in English, Portuguese and Spanish. These rules are limited; they are not a general AI extractor. Unknown actors and uncertain wording remain notes. No deadline is invented when no supported explicit day is present.

My tasks and Waiting remain distinct. A source bullet stays intact when its task is reclassified or completed. Users control meeting attachment. Only explicit timed event intervals produce overlap suggestions; all-day or untimed records do not establish attendance.

Knowledge searches titles, notes, structured bullets, decisions, tasks and captures, ignoring accents. Related meetings share explicit topic labels. It is local text search, without semantic answers or a graph. Every result retains source context.

Calendar parsing uses ical.js for recurrence, exclusions, overrides, timezones and occurrence identity. Google calendar feeds refresh on focus, manual request, date rollover and a ten-minute interval while the app is running. Different providers' similarly named events are kept separate. Legacy Apple Calendar results lack precise intervals and cannot generate overlap suggestions.

## Review scope

The approved source review found 19 issues at baseline `05e635a1620fdd50862d7ebbbf794a219e3763b9`. Recovery, transactions, concurrent Undo, failed drafts, restore completeness, requester assignments, recurrence/date handling, duplicate save rows, CSV exports, backups, calendar refresh and startup retry are addressed in this release. Native permissions, exports and content policy are hardened. Broad restructuring remains incremental.

Review disposition: F01–F12, F14 and F17 have targeted recovery, calendar, export or retry coverage. F13 now creates consistent backup bundles with attachments, but a complete native restore exercise remains outstanding. F15 has bounded serialized history; full-data operations remain. F16 profiling and the broad F19 refactor are deferred. F18 native permissions and content policy are tightened; this is hardening, not a claim of a demonstrated exploit.

Meeting submissions keep their original input across unchanged retries, including person resolution and completion choices. Durable receipts bind the request ID to a content hash. Changed drafts cannot silently receive the earlier result. Recovery retains all authored fields and takes precedence over selecting a different calendar event.


Undo uses serialized snapshots with conflict checks inside a pinned transaction. It retains at most 40 actions, prunes older actions above an estimated 32 MiB budget, and keeps the latest action. Backup location metadata does not consume an Undo step or invalidate prior work. Full table reads and whole-data restoration remain a scaling limit; this is not a delta-based history engine.

Synthetic snapshot benchmark on the development Mac, 40 mutations over fictional rows (no database I/O):

| Rows | Original retained heap | Revised retained heap | Revised median | Revised p95 |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 23 MiB | 17 MiB | 3 ms | 5 ms |
| 10,000 | 227 MiB | 19 MiB | 37 ms | 44 ms |

These measure only JavaScript snapshot overhead. They do not establish native write latency, cold startup or real-world data performance. Repeated collection scans in older People/detail pages remain candidates for profiling.

## Google Meet and Gemini notes

The documented route is Calendar event instances plus [Meet Smart Notes](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.smartNotes), followed by the generated document through [Drive export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export). Smart Notes are distinct from transcripts. Artifact availability, document permissions, account policies and an approved client all matter.

Work-account activation is not configured. No OAuth client, credential import or background note polling is included. Once an approved organizational route exists, the planned cadence is every two hours while running, with catch-up after sleep. Stable source/action identifiers, revision checks and explicit ownership evidence must prevent duplicate tasks and preserve user corrections.

## Verification

Validation results and the complete edited-file list are recorded in [release verification](release-verification.md).
