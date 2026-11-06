use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

mod persistence;

const MAX_CALENDAR_BYTES: u64 = 5 * 1024 * 1024;

fn up(version: i64, description: &'static str, sql: &'static str) -> Migration {
    Migration {
        version,
        description,
        sql,
        kind: MigrationKind::Up,
    }
}

#[derive(serde::Serialize)]
struct CalEvent {
    date: String,
    title: String,
}

fn parse_events(raw: &str) -> Vec<CalEvent> {
    let mut events: Vec<CalEvent> = Vec::new();
    for line in raw.lines() {
        let Some((date, title)) = line.split_once("||") else {
            continue;
        };
        let mut parts = date.split('-');
        let (Some(year), Some(month), Some(day)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(year) = year.parse::<i32>() else {
            continue;
        };
        let Ok(month) = month.parse::<i32>() else {
            continue;
        };
        let Ok(day) = day.parse::<i32>() else {
            continue;
        };
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            continue;
        }
        let date = format!("{year:04}-{month:02}-{day:02}");
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        if events
            .iter()
            .any(|event| event.date == date && event.title == title)
        {
            continue;
        }
        events.push(CalEvent {
            date,
            title: title.to_string(),
        });
    }
    events
}

#[tauri::command]
fn set_menu_count(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("tray") else {
        return Ok(());
    };
    tray.set_tooltip(Some(text)).map_err(|err| err.to_string())
}

fn google_calendar_url(url: &str) -> Result<(), String> {
    let clean = url.trim();
    if clean.len() > 2000 || clean.contains(' ') || clean.contains('\n') || clean.contains('\r') {
        return Err("That calendar address is not usable.".into());
    }
    if !clean.starts_with("https://calendar.google.com/calendar/ical/") || !clean.contains(".ics") {
        return Err("Use the secret iCal address from Google Calendar.".into());
    }
    Ok(())
}

#[tauri::command]
fn fetch_google_calendar(url: String) -> Result<String, String> {
    google_calendar_url(&url)?;
    let escaped_url = url.trim().replace('\\', "\\\\").replace('"', "\\\"");
    let mut child = Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--max-redirs",
            "0",
            "--max-time",
            "20",
            "--max-filesize",
            &MAX_CALENDAR_BYTES.to_string(),
            "--user-agent",
            "To-Do Tracker",
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Google Calendar could not be fetched.".to_owned())?;
    if child
        .stdin
        .take()
        .ok_or_else(|| "Google Calendar could not be fetched.".to_owned())?
        .write_all(format!("url = \"{escaped_url}\"\n").as_bytes())
        .is_err()
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Google Calendar could not be fetched.".into());
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Google Calendar could not be fetched.".to_owned())?;
    let mut body = Vec::with_capacity((MAX_CALENDAR_BYTES as usize).min(64 * 1024));
    if stdout
        .take(MAX_CALENDAR_BYTES + 1)
        .read_to_end(&mut body)
        .is_err()
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Google Calendar could not be fetched.".into());
    }
    if body.len() as u64 > MAX_CALENDAR_BYTES {
        let _ = child.kill();
        let _ = child.wait();
        return Err("The calendar file is too large to read.".into());
    }
    if !child
        .wait()
        .map_err(|_| "Google Calendar could not be fetched.".to_owned())?
        .success()
    {
        return Err("Google Calendar did not answer.".into());
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("That address did not return a calendar.".into());
    }
    Ok(text)
}

#[tauri::command]
fn calendar_week() -> Vec<CalEvent> {
    let script = r#"
set output to ""
set d to current date
set time of d to 0
set endDate to d + (8 * days)
tell application "Calendar"
  repeat with c in calendars
    try
      set evs to (every event of c whose start date >= d and start date < endDate)
      repeat with e in evs
        set sd to start date of e
        set y to year of sd as integer
        set m to month of sd as integer
        set da to day of sd as integer
        set output to output & (y as string) & "-" & (m as string) & "-" & (da as string) & "||" & (summary of e as string) & linefeed
      end repeat
    end try
  end repeat
end tell
return output
"#;
    let Ok(mut child) = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Vec::new();
                }
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut out);
                }
                return parse_events(&out);
            }
            Ok(None) if started.elapsed() > Duration::from_secs(8) => {
                let _ = child.kill();
                return Vec::new();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return Vec::new(),
        }
    }
}

#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    window: WebviewWindow,
    default_name: String,
    contents: String,
) -> Result<bool, String> {
    if !["main", "person"].contains(&window.label()) {
        return Err("Exports can only be saved from the app window.".into());
    }
    let safe_name: String = default_name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "-_.".contains(*character))
        .take(96)
        .collect();
    if safe_name.is_empty() {
        return Err("Choose a file name.".into());
    }
    let Some(selected) = app
        .dialog()
        .file()
        .set_file_name(safe_name)
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let destination = selected
        .into_path()
        .map_err(|_| "The selected save location is not available.".to_owned())?;
    std::fs::write(destination, contents)
        .map_err(|_| "Could not save the exported file.".to_owned())?;
    Ok(true)
}

#[tauri::command]
fn copy_attachment(app: tauri::AppHandle, source: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&source);
    let raw = src
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let clean: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || ".-_ ".contains(*c))
        .collect();
    let files = app
        .path()
        .app_config_dir()
        .map_err(|err| err.to_string())?
        .join("files");
    std::fs::create_dir_all(&files).map_err(|err| err.to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let dest = files.join(format!("{millis}-{clean}"));
    std::fs::copy(&src, &dest).map_err(|err| err.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[derive(serde::Deserialize)]
struct TrayLine {
    id: String,
    label: String,
}

#[tauri::command]
fn set_tray_menu(app: tauri::AppHandle, lines: Vec<TrayLine>) -> Result<(), String> {
    let open = MenuItem::with_id(&app, "open-app", "Open To-Do Tracker", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let log = MenuItem::with_id(&app, "log-meeting", "Log a meeting", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let capture = MenuItem::with_id(&app, "quick-capture", "Quick capture", true, None::<&str>)
        .map_err(|err| err.to_string())?;
    let mut owned = vec![open, capture, log];
    for line in lines.into_iter().take(8) {
        let label: String = line.label.chars().take(80).collect();
        let id = format!("task-{}", line.id);
        owned.push(
            MenuItem::with_id(&app, &id, label, true, None::<&str>)
                .map_err(|err| err.to_string())?,
        );
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        owned.iter().map(|item| item as _).collect();
    let menu = Menu::with_items(&app, &refs).map_err(|err| err.to_string())?;
    if let Some(tray) = app.tray_by_id("tray") {
        tray.set_menu(Some(menu)).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn write_spotlight(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let base = match app.path().document_dir() {
        Ok(dir) => dir,
        Err(_) => app.path().app_config_dir().map_err(|err| err.to_string())?,
    };
    let dir = base.join("To-Do Tracker");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    std::fs::write(dir.join("Due today.txt"), contents).map_err(|err| err.to_string())
}

#[tauri::command]
fn say_text(text: String) -> Result<(), String> {
    let clean: String = text.chars().take(400).collect();
    if clean.trim().is_empty() {
        return Ok(());
    }
    std::process::Command::new("say")
        .arg(&clean)
        .spawn()
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn setup_tray(app: &tauri::App) {
    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip("To-Do Tracker")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "log-meeting" {
                let _ = app.emit("log-meeting", ());
            } else if id == "quick-capture" {
                let _ = app.emit("quick-capture", ());
            } else if let Some(task_id) = id.strip_prefix("task-") {
                let _ = app.emit("show-task", task_id.to_string());
            }
            if id == "open-app"
                || id == "log-meeting"
                || id == "quick-capture"
                || id.starts_with("task-")
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    if let Err(err) = builder.build(app) {
        eprintln!("menu bar: {err}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        up(
            1,
            "create_people",
            "CREATE TABLE people (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );",
        ),
        up(
            2,
            "create_meetings",
            "CREATE TABLE meetings (
                id TEXT PRIMARY KEY NOT NULL,
                person_id TEXT NOT NULL,
                title TEXT NOT NULL,
                meeting_date TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );",
        ),
        up(
            3,
            "create_tasks",
            "CREATE TABLE tasks (
                id TEXT PRIMARY KEY NOT NULL,
                meeting_id TEXT NOT NULL,
                requester_id TEXT NOT NULL,
                title TEXT NOT NULL,
                requested_on TEXT NOT NULL,
                due_on TEXT,
                status TEXT NOT NULL,
                completed_at TEXT,
                created_at TEXT NOT NULL
            );",
        ),
        up(
            4,
            "index_meetings_person",
            "CREATE INDEX idx_meetings_person ON meetings(person_id);",
        ),
        up(
            5,
            "index_tasks_meeting",
            "CREATE INDEX idx_tasks_meeting ON tasks(meeting_id);",
        ),
        up(
            6,
            "index_tasks_requester",
            "CREATE INDEX idx_tasks_requester ON tasks(requester_id);",
        ),
        up(
            7,
            "people_color",
            "ALTER TABLE people ADD COLUMN color TEXT NOT NULL DEFAULT '';",
        ),
        up(
            8,
            "people_company",
            "ALTER TABLE people ADD COLUMN company_id TEXT;",
        ),
        up(
            9,
            "people_check_in",
            "ALTER TABLE people ADD COLUMN check_in_on TEXT;",
        ),
        up(
            10,
            "people_cadence",
            "ALTER TABLE people ADD COLUMN cadence_days INTEGER;",
        ),
        up(
            11,
            "companies",
            "CREATE TABLE companies (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);",
        ),
        up(
            12,
            "tasks_priority",
            "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'none';",
        ),
        up(
            13,
            "tasks_pinned",
            "ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            14,
            "tasks_evening",
            "ALTER TABLE tasks ADD COLUMN evening INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            15,
            "tasks_repeat",
            "ALTER TABLE tasks ADD COLUMN repeat_rule TEXT;",
        ),
        up(
            16,
            "tasks_notes",
            "ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT '';",
        ),
        up(
            17,
            "tasks_moved",
            "ALTER TABLE tasks ADD COLUMN moved_count INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            18,
            "tasks_parent",
            "ALTER TABLE tasks ADD COLUMN parent_id TEXT;",
        ),
        up(
            19,
            "tasks_remind",
            "ALTER TABLE tasks ADD COLUMN remind INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            20,
            "tasks_updated",
            "ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';",
        ),
        up(
            21,
            "meeting_people",
            "CREATE TABLE meeting_people (
                meeting_id TEXT NOT NULL,
                person_id TEXT NOT NULL,
                PRIMARY KEY (meeting_id, person_id)
            );",
        ),
        up(
            22,
            "decisions",
            "CREATE TABLE decisions (
                id TEXT PRIMARY KEY NOT NULL,
                meeting_id TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            );",
        ),
        up(
            23,
            "checks",
            "CREATE TABLE checks (
                id TEXT PRIMARY KEY NOT NULL,
                task_id TEXT NOT NULL,
                title TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL DEFAULT 0
            );",
        ),
        up(
            24,
            "tags",
            "CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);",
        ),
        up(
            25,
            "task_tags",
            "CREATE TABLE task_tags (
                task_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (task_id, tag_id)
            );",
        ),
        up(
            26,
            "activity",
            "CREATE TABLE activity (
                id TEXT PRIMARY KEY NOT NULL,
                task_id TEXT,
                kind TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );",
        ),
        up(
            27,
            "attachments",
            "CREATE TABLE attachments (
                id TEXT PRIMARY KEY NOT NULL,
                task_id TEXT,
                meeting_id TEXT,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                created_at TEXT NOT NULL
            );",
        ),
        up(
            28,
            "templates",
            "CREATE TABLE templates (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                lines TEXT NOT NULL
            );",
        ),
        up(
            29,
            "saved_views",
            "CREATE TABLE saved_views (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                stale INTEGER NOT NULL DEFAULT 0,
                tag_id TEXT,
                person_id TEXT
            );",
        ),
        up(
            30,
            "settings",
            "CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        ),
        up(
            31,
            "removed_people",
            "CREATE TABLE removed_people (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                snapshot TEXT NOT NULL,
                removed_at TEXT NOT NULL
            );",
        ),
        up(
            32,
            "people_paused",
            "ALTER TABLE people ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            33,
            "people_household",
            "ALTER TABLE people ADD COLUMN household TEXT NOT NULL DEFAULT '';",
        ),
        up(
            34,
            "people_met",
            "ALTER TABLE people ADD COLUMN met_how TEXT NOT NULL DEFAULT '';",
        ),
        up(
            35,
            "people_starred",
            "ALTER TABLE people ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            36,
            "people_zone",
            "ALTER TABLE people ADD COLUMN timezone TEXT NOT NULL DEFAULT '';",
        ),
        up(
            37,
            "people_place",
            "ALTER TABLE people ADD COLUMN place TEXT NOT NULL DEFAULT '';",
        ),
        up(
            38,
            "people_event",
            "ALTER TABLE people ADD COLUMN event_group TEXT NOT NULL DEFAULT '';",
        ),
        up(
            39,
            "people_promise",
            "ALTER TABLE people ADD COLUMN promise_on TEXT;",
        ),
        up(
            40,
            "people_sequential",
            "ALTER TABLE people ADD COLUMN sequential INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            41,
            "tasks_do_on",
            "ALTER TABLE tasks ADD COLUMN do_on TEXT;",
        ),
        up(
            42,
            "tasks_hide",
            "ALTER TABLE tasks ADD COLUMN hide_until TEXT;",
        ),
        up(
            43,
            "tasks_someday",
            "ALTER TABLE tasks ADD COLUMN someday INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            44,
            "tasks_section",
            "ALTER TABLE tasks ADD COLUMN section_id TEXT;",
        ),
        up(
            45,
            "tasks_owner",
            "ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'mine';",
        ),
        up(
            46,
            "tasks_clock",
            "ALTER TABLE tasks ADD COLUMN clock_time TEXT NOT NULL DEFAULT '';",
        ),
        up(
            47,
            "tasks_duration",
            "ALTER TABLE tasks ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            48,
            "tasks_remind_time",
            "ALTER TABLE tasks ADD COLUMN remind_time TEXT NOT NULL DEFAULT '';",
        ),
        up(
            49,
            "tasks_count_done",
            "ALTER TABLE tasks ADD COLUMN count_done INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            50,
            "tasks_count_goal",
            "ALTER TABLE tasks ADD COLUMN count_goal INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            51,
            "tasks_blocked",
            "ALTER TABLE tasks ADD COLUMN blocked_by TEXT;",
        ),
        up(
            52,
            "tasks_span",
            "ALTER TABLE tasks ADD COLUMN span_end TEXT;",
        ),
        up(
            53,
            "tasks_source",
            "ALTER TABLE tasks ADD COLUMN source_url TEXT NOT NULL DEFAULT '';",
        ),
        up(
            54,
            "tasks_indent",
            "ALTER TABLE tasks ADD COLUMN indent INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            55,
            "tasks_wake",
            "ALTER TABLE tasks ADD COLUMN wake TEXT NOT NULL DEFAULT '';",
        ),
        up(
            56,
            "tasks_folded",
            "ALTER TABLE tasks ADD COLUMN folded INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            57,
            "tasks_line",
            "ALTER TABLE tasks ADD COLUMN source_line TEXT NOT NULL DEFAULT '';",
        ),
        up(
            58,
            "tasks_unfiled",
            "ALTER TABLE tasks ADD COLUMN unfiled INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            59,
            "tasks_returned",
            "ALTER TABLE tasks ADD COLUMN returned INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            60,
            "tasks_spent",
            "ALTER TABLE tasks ADD COLUMN spent_min INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            61,
            "meetings_private",
            "ALTER TABLE meetings ADD COLUMN private_note TEXT NOT NULL DEFAULT '';",
        ),
        up(
            62,
            "meetings_next",
            "ALTER TABLE meetings ADD COLUMN next_on TEXT;",
        ),
        up(
            63,
            "meetings_focus",
            "ALTER TABLE meetings ADD COLUMN next_focus TEXT NOT NULL DEFAULT '';",
        ),
        up(
            64,
            "meetings_span",
            "ALTER TABLE meetings ADD COLUMN span_end TEXT;",
        ),
        up(
            65,
            "meetings_source",
            "ALTER TABLE meetings ADD COLUMN source_url TEXT NOT NULL DEFAULT '';",
        ),
        up(
            66,
            "meetings_pinned",
            "ALTER TABLE meetings ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
        ),
        up(
            67,
            "decisions_why",
            "ALTER TABLE decisions ADD COLUMN why TEXT NOT NULL DEFAULT '';",
        ),
        up(
            68,
            "bullets",
            "CREATE TABLE bullets (
                id TEXT PRIMARY KEY NOT NULL,
                owner_kind TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                indent INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL DEFAULT 0,
                done INTEGER NOT NULL DEFAULT 0,
                folded INTEGER NOT NULL DEFAULT 0
            );",
        ),
        up(
            69,
            "sections",
            "CREATE TABLE sections (
                id TEXT PRIMARY KEY NOT NULL,
                person_id TEXT NOT NULL,
                name TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0
            );",
        ),
        up(
            70,
            "life_dates",
            "CREATE TABLE life_dates (
                id TEXT PRIMARY KEY NOT NULL,
                person_id TEXT NOT NULL,
                label TEXT NOT NULL,
                on_date TEXT NOT NULL
            );",
        ),
        up(
            71,
            "gifts",
            "CREATE TABLE gifts (
                id TEXT PRIMARY KEY NOT NULL,
                person_id TEXT NOT NULL,
                body TEXT NOT NULL,
                given INTEGER NOT NULL DEFAULT 0
            );",
        ),
        up(
            72,
            "asks",
            "CREATE TABLE asks (
                id TEXT PRIMARY KEY NOT NULL,
                person_id TEXT NOT NULL,
                body TEXT NOT NULL,
                on_date TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0
            );",
        ),
        up(
            73,
            "day_logs",
            "CREATE TABLE day_logs (
                id TEXT PRIMARY KEY NOT NULL,
                on_date TEXT NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL
            );",
        ),
        up(
            74,
            "meetings_calendar_uid",
            "ALTER TABLE meetings ADD COLUMN calendar_uid TEXT NOT NULL DEFAULT '';",
        ),
        up(
            75,
            "tasks_repeat_anchor_day",
            "ALTER TABLE tasks ADD COLUMN repeat_anchor_day INTEGER;",
        ),
        up(
            76,
            "capture_entries",
            "CREATE TABLE capture_entries (
                id TEXT PRIMARY KEY NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL,
                timezone TEXT NOT NULL,
                offset_min INTEGER NOT NULL,
                kind TEXT NOT NULL DEFAULT 'note',
                actor_id TEXT NOT NULL DEFAULT '',
                meeting_id TEXT NOT NULL DEFAULT '',
                task_id TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX capture_entries_created_at ON capture_entries(created_at);
            CREATE INDEX capture_entries_meeting_id ON capture_entries(meeting_id);",
        ),
        up(
            77,
            "meeting_save_receipts",
            "CREATE TABLE meeting_save_receipts (
                save_id TEXT PRIMARY KEY NOT NULL,
                meeting_id TEXT NOT NULL,
                person_id TEXT NOT NULL,
                task_count INTEGER NOT NULL DEFAULT 0
            );",
        ),
        up(
            78,
            "meeting_save_receipt_payload_hash",
            "ALTER TABLE meeting_save_receipts ADD COLUMN payload_hash TEXT;",
        ),
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:todo-tracker.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(persistence::TransactionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            set_menu_count,
            set_tray_menu,
            write_spotlight,
            say_text,
            calendar_week,
            fetch_google_calendar,
            persistence::backup_database,
            persistence::begin_database_transaction,
            persistence::transaction_execute,
            persistence::transaction_select,
            persistence::finish_database_transaction,
            persistence::database_transaction_status,
            save_text_file,
            copy_attachment
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let registry = window
                    .app_handle()
                    .state::<persistence::TransactionRegistry>()
                    .inner()
                    .clone();
                let owner = window.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    persistence::rollback_transactions_for_window(registry, owner).await;
                });
            }
        })
        .setup(|app| {
            persistence::start_transaction_cleanup(
                app.state::<persistence::TransactionRegistry>()
                    .inner()
                    .clone(),
            );
            setup_tray(app);
            let _ = app.global_shortcut().on_shortcut(
                "CommandOrControl+Shift+Y",
                |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("say-due", ());
                    }
                },
            );
            if let Err(err) = app.global_shortcut().on_shortcut(
                "CommandOrControl+Shift+N",
                |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("quick-capture", ());
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                },
            ) {
                eprintln!("shortcut: {err}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
