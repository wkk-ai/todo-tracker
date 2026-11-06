import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type CalEvent = { id: string; date: string; time: string; title: string; url: string; start?: string; end?: string; allDay?: boolean };

export async function setTrayMenu(lines: { id: string; label: string }[]): Promise<void> {
  try {
    await invoke("set_tray_menu", { lines });
  } catch {
    // The menu is a convenience.
  }
}

export async function writeSpotlight(contents: string): Promise<void> {
  try {
    await invoke("write_spotlight", { contents });
  } catch {
    // Spotlight is optional.
  }
}

export async function sayText(text: string): Promise<void> {
  try {
    await invoke("say_text", { text });
  } catch {
    // Speech is optional.
  }
}

export async function setMenuCount(text: string): Promise<void> {
  try {
    await invoke("set_menu_count", { text });
  } catch {
    // The menu bar icon is a convenience. The window still works.
  }
}

export async function loadCalendar(): Promise<CalEvent[]> {
  try {
    const rows = await invoke<{ date: string; title: string }[]>("calendar_week");
    return rows.map((row) => ({
      id: `mac:${row.date}:${row.title}`,
      date: row.date,
      time: "",
      title: row.title,
      url: "",
    }));
  } catch {
    return [];
  }
}

export async function fetchGoogleCalendar(url: string): Promise<string> {
  return await invoke<string>("fetch_google_calendar", { url });
}

export async function backupNow(name: string): Promise<string> {
  return invoke<string>("backup_database", { name });
}

export async function saveTextFile(defaultName: string, contents: string): Promise<boolean> {
  return invoke<boolean>("save_text_file", { defaultName, contents });
}

export async function pickAndStoreFile(): Promise<{ name: string; path: string } | null> {
  const picked = await open({ multiple: false, directory: false });
  if (typeof picked !== "string") return null;
  const stored = await invoke<string>("copy_attachment", { source: picked });
  const name = picked.split("/").pop() || "File";
  return { name, path: stored };
}

export async function notifyDue(body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    sendNotification({ title: "To-Do Tracker", body });
  } catch {
    // A reminder is optional. The task stays on the list either way.
  }
}

export async function onQuickCapture(run: () => void): Promise<UnlistenFn> {
  try {
    return await listen("quick-capture", () => run());
  } catch {
    return () => undefined;
  }
}

export async function onLogMeeting(run: () => void): Promise<UnlistenFn> {
  try {
    return await listen("log-meeting", () => run());
  } catch {
    return () => undefined;
  }
}

export async function onShowTask(run: (taskId: string) => void): Promise<UnlistenFn> {
  try {
    return await listen<string>("show-task", (event) => {
      if (typeof event.payload === "string") run(event.payload);
    });
  } catch {
    return () => undefined;
  }
}

export async function onSayDue(run: () => void): Promise<UnlistenFn> {
  try {
    return await listen("say-due", () => run());
  } catch {
    return () => undefined;
  }
}

export async function onShowPerson(run: (personId: string) => void): Promise<UnlistenFn> {
  try {
    return await listen<string>("show-person", (event) => {
      if (typeof event.payload === "string") run(event.payload);
    });
  } catch {
    return () => undefined;
  }
}

export async function openBeside(personId: string, title: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel("person");
  if (existing) {
    await existing.emit("show-person", personId);
    await existing.setFocus();
    return;
  }
  const created = new WebviewWindow("person", {
    url: `/?person=${encodeURIComponent(personId)}`,
    title,
    width: 760,
    height: 840,
    backgroundColor: "#F3F0EA",
  });
  created.once("tauri://error", () => undefined);
}

export async function watchClose(dirty: () => boolean): Promise<() => void> {
  try {
    const current = getCurrentWindow();
    let allow = false;
    return await current.onCloseRequested(async (event) => {
      if (allow || !dirty()) return;
      event.preventDefault();
      if (!window.confirm("This meeting is not saved yet. Close anyway?")) return;
      allow = true;
      await current.close();
    });
  } catch {
    return () => undefined;
  }
}

export function personFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("person");
}

export function cardFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get("card") === "1";
}

export async function openCard(): Promise<void> {
  const created = new WebviewWindow("card", {
    url: "/?card=1",
    title: "Due",
    width: 320,
    height: 480,
    alwaysOnTop: true,
    backgroundColor: "#F3F0EA",
  });
  created.once("tauri://error", () => undefined);
}

export async function openFocus(taskId: string, title: string): Promise<void> {
  const created = new WebviewWindow("focus", {
    url: `/?task=${encodeURIComponent(taskId)}`,
    title,
    width: 420,
    height: 280,
    backgroundColor: "#F3F0EA",
  });
  created.once("tauri://error", () => undefined);
}
