# To-Do Tracker

A Mac app for the tasks that come out of meetings.

Workspace keeps your tasks and their meeting context side by side. Today separates My tasks from Waiting; Meetings keeps discussions, decisions and follow-ups together. Knowledge searches saved notes, topics, decisions and tasks, with links back to their sources.

Quick capture opens immediately with Command-N, or Command-Shift-N from anywhere on this Mac. Enter saves a bullet; Shift-Enter adds a line break. Each bullet keeps its original time and a recovery draft. Clear first-person commitments become My tasks; named commitments from known people become Waiting. Uncertain statements remain notes. Type, owner and meeting links can be corrected afterward.

Calendar overlap suggests a meeting; you choose whether to attach it. Existing Google calendar feeds refresh on focus, manually and every ten minutes while running. Gemini note ingestion is planned and is not enabled; organizational Google access must be approved before connecting a work account. No meeting text is sent to an external AI service.

People, Settings and existing planning features remain available. Press Command-K to jump somewhere. See [design and release notes](docs/workspace-release.md) for benchmarks, verification and limitations.

## Your notes stay on this Mac

People, meetings, and tasks are saved in a private file that belongs to the app. They are not part of this project, and they are not uploaded to GitHub.

Another assistant that needs to add a to-do should follow [AGENTS.md](AGENTS.md). That file is the step-by-step.

Application writes use native transactions. Undo stops when another window has saved changes, protecting newer work. Automatic backups contain a consistent database snapshot, attachments and a manifest in a dated bundle. An unsuccessful backup retries; it is not marked complete.

## Open it

From this folder:

```bash
npm install
npm run tauri dev
```

That opens the app on your Mac.

To make the copy you can keep in your Applications folder:

```bash
npm run tauri build
```

The first time you open that copy, Mac may ask you to confirm it. Right-click the app and choose Open.

## Development checks

Pure and synthetic regression tests run with `node --experimental-strip-types --test tests/*.test.ts`. They do not open a local database. `npm run build` checks the production frontend, and `cargo check --manifest-path src-tauri/Cargo.toml` checks the native shell.

For UI testing, start the development server and open `http://127.0.0.1:1420/?preview`. This development-only page uses fictional records in memory and separate draft storage. It includes simulated failed saves. The preview is excluded from production builds.
