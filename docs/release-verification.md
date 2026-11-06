# Release verification

Release date: 6 November 2026. Selected layout: D — Workspace. Baseline rollback commit: `05e635a1620fdd50862d7ebbbf794a219e3763b9`.

## Scope and evidence

This release adds the Workspace shell, timestamped quick capture, conservative automatic task routing, meeting attachment choices and local knowledge search. Calendar recurrence, retry, persistence, recovery, Undo, exports and native boundaries were reviewed against the original findings. See [release notes and benchmarks](workspace-release.md).

## Verification status

- 56 Node regression tests pass, including receipt identity, changed-content rejection, restore fidelity, capture correction, recurrence, concurrency conflicts and CSV escaping.
- 7 Rust tests pass for SQL validation, owner/expiry receipts, typed bindings/decoding and backup naming. Rust formatting passes.
- Production TypeScript/Vite build and the optimized Tauri Mac application bundle pass.
- Production dependency audit reports zero known vulnerabilities; whitespace checks pass.
- The completed bundle was signed locally with an ad-hoc signature and passes strict recursive signature verification. This is a local installation, not a notarized distribution.
- The installed bundle matches the built executable hash. The previous application bundle is retained outside the repository for rollback. Installation preserved the already running process; the user must reopen the app to run this update.

Tests use fictional in-memory adapters and in-memory SQLite only. They do not open an on-disk database or establish production data correctness.

## Limits and remaining checks

Visual interaction checks before the shared-desktop pause covered task context, failed capture draft recovery, successful retry, explicit meeting attachment and knowledge excerpts. Final responsive, keyboard and native end-to-end checks remain incomplete. The application was not relaunched to test migrations against personal data. A full native backup-and-restore round trip has not been verified.

Snapshot history is bounded and detects newer content, but writes and restores still read the full dataset. Repeated scans in older People/detail pages need profiling before further optimization. A broad architecture rewrite remains deferred.

Quick capture inference uses local phrase rules, not a general language model. Knowledge uses local text and topic search. Google Meet/Gemini work-account ingestion remains unconfigured pending a supported organizational integration route; no work credentials or private meeting content are included in this source release.

## Changed application files

- [README.md](../README.md)
- [docs/NEXT.md](../docs/NEXT.md)
- [docs/release-verification.md](../docs/release-verification.md)
- [docs/workspace-release.md](../docs/workspace-release.md)
- [package-lock.json](../package-lock.json)
- [package.json](../package.json)
- [src-tauri/Cargo.lock](../src-tauri/Cargo.lock)
- [src-tauri/Cargo.toml](../src-tauri/Cargo.toml)
- [src-tauri/capabilities/default.json](../src-tauri/capabilities/default.json)
- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs)
- [src-tauri/src/persistence.rs](../src-tauri/src/persistence.rs)
- [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)
- [src/App.tsx](../src/App.tsx)
- [src/Dashboard.tsx](../src/Dashboard.tsx)
- [src/MeetingSheet.tsx](../src/MeetingSheet.tsx)
- [src/TaskInspector.tsx](../src/TaskInspector.tsx)
- [src/Workspace.tsx](../src/Workspace.tsx)
- [src/calendar.ts](../src/calendar.ts)
- [src/calendarSync.ts](../src/calendarSync.ts)
- [src/capture.ts](../src/capture.ts)
- [src/database.ts](../src/database.ts)
- [src/db.ts](../src/db.ts)
- [src/devPreview.css](../src/devPreview.css)
- [src/devPreview.tsx](../src/devPreview.tsx)
- [src/history.ts](../src/history.ts)
- [src/logic.ts](../src/logic.ts)
- [src/main.tsx](../src/main.tsx)
- [src/native.ts](../src/native.ts)
- [src/task-inspector.css](../src/task-inspector.css)
- [src/workspace.css](../src/workspace.css)
- [tests/calendar-sync.test.ts](../tests/calendar-sync.test.ts)
- [tests/calendar.test.ts](../tests/calendar.test.ts)
- [tests/capture.test.ts](../tests/capture.test.ts)
- [tests/database-bridge.test.ts](../tests/database-bridge.test.ts)
- [tests/history.test.ts](../tests/history.test.ts)
- [tests/logic.test.ts](../tests/logic.test.ts)
- [tests/persistence-domain.test.ts](../tests/persistence-domain.test.ts)
