import { useCallback, useEffect, useRef, useState } from "react";
import {
  addAsk,
  addCompany,
  addDayLog,
  addDecision,
  addGift,
  addLifeDate,
  addLooseTask,
  addPerson,
  addSection,
  applyTask,
  deleteDecision,
  deleteMeeting,
  deletePerson,
  deleteTemplate,
  deleteView,
  loadAll,
  openDatabase,
  replaceAll,
  replaceBullets,
  restoreRemoved,
  saveMeeting,
  saveTemplate,
  saveView,
  setManyDue,
  setManyStatus,
  patchTask,
  setSetting,
  updateGuests,
  updateMeeting,
  updatePerson,
  updatePersonNote,
  updateTaskDue,
  updateTaskTitle,
  type SaveMeetingInput,
  type TaskAction,
} from "./db";
import {
  addDays,
  agendaFromIcs,
  calendarEventMatches,
  boardCsv,
  boardText,
  groupOpen,
  meetingText,
  personInTitle,
  personOpenText,
  savedLine,
  todayISO,
  tasksForHome,
  type Data,
  type Meeting,
  type Task,
} from "./logic";
import { Icon } from "./icons";
import { Dashboard } from "./Dashboard";
import { Workspace, type WorkspacePage } from "./Workspace";
import { TaskInspector } from "./TaskInspector";
import { saveCapture, correctCapture } from "./capture";
import { MeetingSheet } from "./MeetingSheet";
import { People } from "./People";
import { PersonPage } from "./PersonPage";
import { ArchivePage, BriefPage, Palette, ReviewPage, SettingsPage } from "./pages";
import { BoxesPage, DayPage, SomedayPage } from "./tools";
import { SearchResults } from "./SearchResults";
import {
  backupNow,
  fetchGoogleCalendar,
  loadCalendar,
  type CalEvent,
  notifyDue,
  onLogMeeting,
  onQuickCapture,
  onShowPerson,
  cardFromUrl,
  onSayDue,
  onShowTask,
  openBeside,
  openCard,
  personFromUrl,
  pickAndStoreFile,
  saveTextFile,
  sayText,
  setMenuCount,
  setTrayMenu,
  watchClose,
  writeSpotlight,
} from "./native";
import { transaction, type Database } from "./database";
import { SafeHistory } from "./history";
import { mergeCalendarEvents, SingleFlight } from "./calendarSync";

type Screen =
  | { name: "home" }
  | { name: "capture" }
  | { name: "meetings" }
  | { name: "knowledge" }
  | { name: "planning" }
  | { name: "people" }
  | { name: "person"; personId: string; meetingId?: string }
  | { name: "review" }
  | { name: "archive" }
  | { name: "brief"; personId: string }
  | { name: "settings" }
  | { name: "day" }
  | { name: "boxes" }
  | { name: "someday" };

type Toast = { message: string; undo: (() => Promise<void>) | null };

export default function App() {
  const [db, setDb] = useState<Database | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [screen, setScreen] = useState<Screen>(() => {
    const personId = personFromUrl();
    return personId ? { name: "person", personId } : { name: "home" };
  });
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const past = useRef<Screen[]>([]);
  const [canBack, setCanBack] = useState(false);
  const openScreen = useCallback((next: Screen) => {
    const current = screenRef.current;
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    past.current.push(current);
    if (past.current.length > 40) past.current.shift();
    setCanBack(true);
    screenRef.current = next;
    setScreen(next);
  }, []);
  const goBack = useCallback(() => {
    const prev = past.current.pop();
    setCanBack(past.current.length > 0);
    if (!prev) return;
    screenRef.current = prev;
    setScreen(prev);
  }, []);
  const [query, setQuery] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetPersonId, setSheetPersonId] = useState<string | null>(null);
  const [sheetDate, setSheetDate] = useState<string | null>(null);
  const woke = useRef(false);
  const [sheetDirty, setSheetDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [today, setToday] = useState(todayISO);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [agendaError, setAgendaError] = useState("");
  const [agendaVersion, setAgendaVersion] = useState(0);
  const calendarFlight = useRef(new SingleFlight<CalEvent[]>());
  const [agendaPick, setAgendaPick] = useState<CalEvent | null>(null);
  const [palette, setPalette] = useState<string | null>(null);
  const [inspectedTaskId, setInspectedTaskId] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);
  const historyRef = useRef<SafeHistory<Data, Database> | null>(null);
  if (!historyRef.current) historyRef.current = new SafeHistory(transaction, loadAll, async (database, snapshot) => {
    const current = await loadAll(database);
    await replaceAll(database, { ...snapshot, settings: { ...snapshot.settings, backupPath: current.settings.backupPath } });
  }, (snapshot) => ({ ...snapshot, settings: { ...snapshot.settings, backupPath: "" } }));
  const dataRef = useRef(data);
  const dbRef = useRef(db);
  const dirtyRef = useRef(false);
  dataRef.current = data;
  dbRef.current = db;
  dirtyRef.current = sheetOpen && sheetDirty;

  const refresh = useCallback(async (_database: Database) => {
    const next = await transaction(loadAll);
    setData(next);
    return next;
  }, []);

  const showToast = useCallback((next: Toast, ms: number) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  const mutate = useCallback(
    async <T,>(work: (database: Database) => Promise<T>, options: { throwOnError?: boolean; onCommit?: (id: number | null) => void } = {}): Promise<T | undefined> => {
      if (!dbRef.current) {
        if (options.throwOnError) throw new Error("Your saved tasks have not opened yet. Your draft is still here.");
        return;
      }
      try {
        const result = await historyRef.current!.mutate(work);
        setData(result.state);
        options.onCommit?.(result.undoId);
        return result.value;
      } catch (caught) {
        if (dbRef.current) await refresh(dbRef.current).catch(() => undefined);
        showToast({ message: caught instanceof Error ? caught.message : "That did not save.", undo: null }, 5000);
        if (options.throwOnError) throw caught;
      }
    },
    [refresh, showToast],
  );

  const undo = useCallback(async (expectedId?: number) => {
    try {
      const state = await historyRef.current!.undo(expectedId);
      if (state) setData(state);
    } catch (caught) {
      showToast({ message: caught instanceof Error ? caught.message : "Could not undo.", undo: null }, 6000);
      if (dbRef.current) await refresh(dbRef.current).catch(() => undefined);
    }
  }, [refresh, showToast]);

  const redo = useCallback(async () => {
    try {
      const state = await historyRef.current!.redo();
      if (state) setData(state);
    } catch (caught) {
      showToast({ message: caught instanceof Error ? caught.message : "Could not redo.", undo: null }, 6000);
      if (dbRef.current) await refresh(dbRef.current).catch(() => undefined);
    }
  }, [refresh, showToast]);

  useEffect(() => {
    let alive = true;
    openDatabase()
      .then(async (database) => {
        const all = await transaction(loadAll);
        if (!alive) return;
        setDb(database);
        setData(all);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : "The app could not open your saved tasks.");
      });
    return () => {
      alive = false;
    };
  }, [startupAttempt]);

  useEffect(() => {
    const update = () => {
      setToday(todayISO());
      setAgendaVersion((value) => value + 1);
      const database = dbRef.current;
      if (database) void refresh(database).catch(() => showToast({ message: "Saved tasks could not refresh. Try again when this window is active.", undo: null }, 5000));
    };
    window.addEventListener("focus", update);
    const id = window.setInterval(() => setToday(todayISO()), 60_000);
    return () => {
      window.removeEventListener("focus", update);
      window.clearInterval(id);
    };
  }, [refresh, showToast]);

  useEffect(() => {
    if (!data) return;
    document.documentElement.dataset.theme = data.settings.theme;
    document.documentElement.dataset.type = data.settings.typeSize;
    document.documentElement.dataset.contrast = data.settings.contrast ? "more" : "off";
    const groups = groupOpen(tasksForHome(data, today), today);
    const text =
      groups.overdue.length === 0 && groups.today.length === 0
        ? "To-Do Tracker · All caught up"
        : `To-Do Tracker · ${groups.overdue.length} overdue, ${groups.today.length} due today`;
    void setMenuCount(text);
    const due = tasksForHome(data, today).filter((task) => task.dueOn && task.dueOn <= today);
    void setTrayMenu(due.slice(0, 8).map((task) => ({ id: task.id, label: task.title })));
    void writeSpotlight(
      ["Due", ...due.map((task) => task.title), "", "People", ...data.people.map((person) => person.name)].join("\n"),
    );
  }, [data, today]);

  useEffect(() => {
    if (!data) return;
    const url = data.settings.googleIcal;
    let gone = false;
    void calendarFlight.current.run(url + "|" + today, async () => {
      const mac = await loadCalendar();
      const google = url ? await agendaFromIcs(await fetchGoogleCalendar(url), today) : [];
      return mergeCalendarEvents(google, mac);
    }).then((next) => {
      if (gone) return;
      setEvents(next);
      setAgendaError("");
    }).catch(() => {
      if (!gone) setAgendaError("Calendar could not refresh. Previously loaded meetings are still shown. Try Refresh.");
    });
    return () => { gone = true; };
  }, [data?.settings.googleIcal, today, agendaVersion]);

  useEffect(() => {
    const id = window.setInterval(() => setAgendaVersion((value) => value + 1), 10 * 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!db) return;
    let stopped = false;
    let inFlight = false;
    const attempt = async () => {
      const key = `todo-tracker.backup.v2.${todayISO()}`;
      if (inFlight || localStorage.getItem(key)) return;
      inFlight = true;
      try {
        const path = await backupNow(`todo-tracker-${todayISO()}.db`);
        await transaction((database) => setSetting(database, "backupPath", path));
        localStorage.setItem(key, "1");
        if (!stopped && dbRef.current) await refresh(dbRef.current);
      } catch {
        if (!stopped) showToast({ message: "Automatic backup could not finish. It will retry; you can also back up in Settings.", undo: null }, 6000);
      } finally {
        inFlight = false;
      }
    };
    void attempt();
    const retry = window.setInterval(() => void attempt(), 15 * 60_000);
    window.addEventListener("focus", attempt);
    return () => { stopped = true; window.clearInterval(retry); window.removeEventListener("focus", attempt); };
  }, [db, today, refresh, showToast]);

  useEffect(() => {
    if (!data) return;
    for (const task of data.tasks) {
      if (!task.remind || task.dueOn !== today) continue;
      if (task.status === "done" || task.status === "set_aside" || task.status === "void") continue;
      const key = `todo-tracker.reminded.${task.id}.${today}`;
      if (localStorage.getItem(key)) continue;
      localStorage.setItem(key, "1");
      void notifyDue(`Due today: ${task.title}`);
    }
  }, [data, today]);

  useEffect(() => {
    if (!data || screen.name !== "person") return;
    if (!data.people.some((person) => person.id === screen.personId)) {
      past.current = past.current.filter((item) => item.name !== "person" || item.personId !== screen.personId);
      setCanBack(past.current.length > 0);
      screenRef.current = { name: "home" };
      setScreen({ name: "home" });
    }
  }, [data, screen]);

  const openSheet = useCallback((personId: string | null, date?: string, event?: CalEvent | null) => {
    setAgendaPick(event ?? null);
    setSheetPersonId(personId);
    setSheetDate(date ?? null);
    setSheetOpen(true);
  }, []);

  useEffect(() => {
    let stopped = false;
    const listeners: (() => void)[] = [];
    const keep = (fn: () => void) => { if (stopped) fn(); else listeners.push(fn); };
    void onLogMeeting(() => openSheet(null)).then(keep);
    void onShowPerson((personId) => {
      setQuery("");
      openScreen({ name: "person", personId });
    }).then(keep);
    void watchClose(() => dirtyRef.current).then(keep);
    return () => { stopped = true; listeners.forEach((stop) => stop()); };
  }, [openScreen, openSheet]);

  useEffect(() => {
    let stopped = false;
    let unlisten = () => undefined as void;
    void onQuickCapture(() => { setQuery(""); openScreen({ name: "capture" }); }).then((stop) => {
      if (stopped) stop(); else unlisten = stop;
    });
    return () => { stopped = true; unlisten(); };
  }, [openScreen]);

  useEffect(() => {
    let stopped = false;
    let stop = () => undefined as void;
    void onShowTask((taskId) => {
      const current = dataRef.current;
      const task = current?.tasks.find((item) => item.id === taskId);
      if (!task) return;
      setQuery("");
      setInspectedTaskId(task.id);
    }).then((fn) => {
      if (stopped) fn(); else stop = fn;
    });
    return () => { stopped = true; stop(); };
  }, []);

  useEffect(() => {
    let stop = () => undefined as void;
    void onSayDue(() => {
      const current = dataRef.current;
      if (!current) return;
      const line = tasksForHome(current, todayISO())
        .filter((task) => task.dueOn && task.dueOn <= todayISO())
        .map((task) => task.title)
        .join(". ");
      void sayText(line || "Nothing is due");
    }).then((fn) => {
      stop = fn;
    });
    return () => stop();
  }, []);

  useEffect(() => {
    if (!data || !db || woke.current) return;
    woke.current = true;
    const waiting = data.tasks.filter((task) => task.wake === "open");
    if (waiting.length === 0) return;
    void mutate(async (database) => {
      for (const task of waiting) await patchTask(database, task.id, { wake: "", returned: true });
    });
  }, [data, db, mutate]);

  useEffect(() => {
    if (!data || !navigator.geolocation) return;
    const places = data.people.filter((person) => person.place && person.place.includes(","));
    if (places.length === 0) return;
    const watch = navigator.geolocation.watchPosition((position) => {
      for (const person of places) {
        const [lat, lng] = (person.place ?? "").split(",").map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const distance = Math.hypot(position.coords.latitude - lat, position.coords.longitude - lng);
        const near = distance < 0.003;
        const key = `todo-tracker.near.${person.id}`;
        const was = localStorage.getItem(key) === "1";
        if (near !== was) void notifyDue(near ? `You are near ${person.name}` : `You left ${person.name}`);
        localStorage.setItem(key, near ? "1" : "0");
      }
    });
    return () => navigator.geolocation.clearWatch(watch);
  }, [data]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      const key = event.key.toLowerCase();
      if (meta && key === "n" && !event.shiftKey) {
        event.preventDefault();
        setQuery("");
        openScreen({ name: "capture" });
      } else if (meta && key === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (meta && key === "k") {
        event.preventDefault();
        setPalette("");
      } else if (meta && event.key === "[") {
        event.preventDefault();
        goBack();
      } else if (meta && key === "1") {
        event.preventDefault();
        setQuery("");
        openScreen({ name: "home" });
      } else if (meta && key === "2") {
        event.preventDefault();
        setQuery("");
        openScreen({ name: "people" });
      } else if (meta && key === "3") {
        event.preventDefault();
        setQuery("");
        openScreen({ name: "review" });
      } else if (meta && key === "p") {
        event.preventDefault();
        window.print();
      } else if (meta && event.shiftKey && key === "v" && !typing) {
        event.preventDefault();
        void navigator.clipboard.readText().then(async (text) => {
          const line = text
            .split("\n")
            .map((item) => item.trim())
            .find(Boolean);
          const current = dataRef.current;
          if (!line || !current) return;
          const latest = [...current.meetings].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          const personId = current.settings.onlyPersonId || latest?.personId || null;
          await mutate((database) => addLooseTask(database, personId, line, text), { throwOnError: true });
          showToast(
            { message: personId ? "Saved that line for the last person." : "Saved that line in the catch pile.", undo: null },
            4000,
          );
        }).catch(() => showToast({ message: "Could not save that clipboard text. Please try again.", undo: null }, 4000));
      } else if (meta && key === "z") {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) void redo();
        else void undo();
      } else if (!meta && !event.altKey && !typing && !sheetOpen && palette === null && event.key.length === 1 && event.key !== " ") {
        if (screen.name === "home" && "jk[]".includes(key)) return;
        setPalette(event.key);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goBack, openScreen, openSheet, redo, screen, sheetOpen, undo]);

  function openTask(task: Task) {
    setQuery("");
    setInspectedTaskId(task.id);
  }

  async function onTask(task: Task, action: TaskAction) {
    if (action.type === "ask") {
      await mutate((database) => addLooseTask(database, action.personId, action.title, ""));
      return;
    }
    if (action.type === "attach" && !action.path) {
      const file = await pickAndStoreFile();
      if (!file) return;
      await mutate((database) => applyTask(database, task.id, { type: "attach", name: file.name, path: file.path }));
      return;
    }
    if (action.type === "status" && action.status === "set_aside") {
      showToast({ message: "Set aside. It stays on the meeting.", undo: null }, 4000);
    }
    await mutate((database) => applyTask(database, task.id, action));
  }

  async function onSave(input: SaveMeetingInput) {
    if (!db || !data) throw new Error("Your saved tasks have not opened yet. Your draft is still here.");
    const keep = data.settings.keepSheetOpen;
    setBusy(true);
    try {
      let saveUndoId: number | null = null;
      const result = await mutate((database) => saveMeeting(database, input), { throwOnError: true, onCommit: (id) => { saveUndoId = id; } });
      if (!result) throw new Error("That did not save. Your draft is still here.");
      setQuery("");
      if (!keep) {
        setSheetOpen(false);
        if (!["home", "capture", "meetings", "knowledge"].includes(screenRef.current.name)) {
          openScreen({ name: "person", personId: result.personId });
        }
      }
      showToast(
        {
          message:
            events.filter((item) => item.date === input.meetingDate).length >= 3
              ? `${savedLine(result.taskCount)} That day already looks full.`
              : savedLine(result.taskCount),
          undo: saveUndoId === null ? null : async () => {
            await undo(saveUndoId!);
          },
        },
        8000,
      );
    } finally {
      setBusy(false);
    }
  }

  async function exportText(contents: string, name: string) {
    try {
      const saved = await saveTextFile(name, contents);
      if (saved) showToast({ message: "Saved the file.", undo: null }, 4000);
    } catch (caught) {
      showToast({ message: caught instanceof Error ? caught.message : "Could not save the file.", undo: null }, 5000);
    }
  }

  function setting(key: string, value: string) {
    void mutate((database) => setSetting(database, key, value));
  }

  const searching = query.trim().length > 0;
  const focusId = new URLSearchParams(window.location.search).get("task");

  if (focusId && data) {
    const task = data.tasks.find((item) => item.id === focusId);
    return (
      <div className="card-app">
        <h1>{task?.title ?? "That follow-up is gone"}</h1>
        {task && task.status !== "done" && (
          <button className="primary" type="button" onClick={() => void onTask(task, { type: "status", status: "done" })}>
            Done
          </button>
        )}
      </div>
    );
  }

  if (cardFromUrl() && data) {
    const due = tasksForHome(data, today).filter((task) => task.dueOn && task.dueOn <= today);
    return (
      <div className="card-app">
        <h1>Due</h1>
        {due.length === 0 && <p>Nothing is due.</p>}
        {due.map((task) => (
          <label key={task.id} className="open-item">
            <input type="checkbox" onChange={() => void onTask(task, { type: "status", status: "done" })} />
            <span>{task.title}</span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <div className="app workspace-app">
      <aside className="sidebar no-print">
        <div className="brand">To-Do Tracker</div>
        <label className="search">
          <span className="sr-only">Search</span>
          <input ref={searchRef} placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <nav className="nav" aria-label="Main navigation">
          {(
            [
              ["home", "Today", "sun"],
              ["capture", "Capture", "plus"],
              ["meetings", "Meetings", "calendar"],
              ["knowledge", "Knowledge", "link"],
            ] as const
          ).map(([name, label, icon]) => (
            <button
              key={name}
              className={screen.name === name && !searching ? "nav-button active" : "nav-button"}
              aria-current={screen.name === name && !searching ? "page" : undefined}
              onClick={() => {
                setQuery("");
                openScreen({ name } as Screen);
              }}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>
        <button className="primary sidebar-action" onClick={() => { setQuery(""); openScreen({ name: "capture" }); }}>
          <span className="with-icon">
            <Icon name="plus" />
            Quick capture
          </span>
          <kbd className="kbd">⌘N</kbd>
        </button>
        <button className={screen.name === "people" ? "nav-button active" : "nav-button"} onClick={() => { setQuery(""); openScreen({ name: "people" }); }}><Icon name="people" />People</button>
        <details className="workspace-more">
          <summary>Planning &amp; history</summary>
          <nav className="nav" aria-label="Planning and history">
            {([
              ["planning", "Insights", "home"], ["review", "Review", "list"], ["archive", "Set aside", "box"],
              ["day", "Daily log", "sun"], ["boxes", "Four boxes", "squares"], ["someday", "Someday", "cloud"],
            ] as const).map(([name, label, icon]) => <button key={name} className={screen.name === name && !searching ? "nav-button active" : "nav-button"} onClick={() => { setQuery(""); openScreen({ name }); }}><Icon name={icon} />{label}</button>)}
          </nav>
        </details>
        <button
          className={screen.name === "settings" ? "nav-button tone-none active" : "nav-button tone-none"}
          onClick={() => {
            setQuery("");
            openScreen({ name: "settings" });
          }}
        >
          <Icon name="gear" />
          Settings
        </button>
      </aside>
      <main className="main">
        <div className={["home", "capture", "meetings", "knowledge"].includes(screen.name) ? "main-inner workspace-page" : "main-inner"}>
          <button className="back no-print" type="button" onClick={goBack} disabled={!canBack}>
            <Icon name="back" />
            Back
          </button>
          {error && <div className="error-banner" role="alert"><p>The app could not open your saved tasks. {error}</p><button type="button" onClick={() => { setError(""); setStartupAttempt((attempt) => attempt + 1); }}>Try again</button></div>}
          {!error && !data && <Skeleton />}
          {data && searching && (
            <SearchResults
              data={data}
              query={query}
              onPerson={(id, meetingId) => {
                setQuery("");
                openScreen({ name: "person", personId: id, meetingId });
              }}
            />
          )}
          {data && !searching && ["home", "capture", "meetings", "knowledge"].includes(screen.name) && (
            <Workspace data={data} page={(screen.name === "home" ? "today" : screen.name) as WorkspacePage} today={today} events={events} agendaError={agendaError}
              onRefreshAgenda={() => setAgendaVersion((value) => value + 1)}
              onOpenTask={openTask} onAction={(task, action) => void onTask(task, action)}
              onOpenMeeting={(meeting) => { setQuery(""); openScreen({ name: "person", personId: meeting.personId, meetingId: meeting.id }); }}
              onLog={(event) => openSheet(null, event?.date, event)}
              onGoCapture={() => { setQuery(""); openScreen({ name: "capture" }); }}
              onCapture={async (entry) => { await mutate(async (database) => saveCapture(database, entry, await loadAll(database)), { throwOnError: true }); }}
              onCorrect={async (entry, patch) => { await mutate((database) => correctCapture(database, entry, patch), { throwOnError: true }); }}
            />
          )}
          {data && !searching && screen.name === "planning" && (
          <Dashboard
            data={data}
            today={today}
            events={events}
            googleConnected={Boolean(data.settings.googleIcal)}
            agendaError={agendaError}
            onRefreshAgenda={() => setAgendaVersion((value) => value + 1)}
            onOpenAgenda={(event) => {
              const linked = data.meetings.find((meeting) => calendarEventMatches(meeting, event));
              if (linked) {
                setQuery("");
                openScreen({ name: "person", personId: linked.personId, meetingId: linked.id });
                return;
              }
              const person = personInTitle(data.people, event.title);
              openSheet(person?.id ?? null, event.date, event);
            }}
            onOpenSettings={() => openScreen({ name: "settings" })}
            onOpenTask={openTask}
              onOpenPerson={(id) => openScreen({ name: "person", personId: id })}
              onLog={(id) => openSheet(id ?? null)}
              onOpenDay={(date) => openSheet(null, date)}
              onAction={(task, action) => void onTask(task, action)}
              onCheckIn={(id, kind) =>
                void mutate((database) =>
                  updatePerson(database, id, { checkInOn: kind === "snooze" ? addDays(today, 7) : null }),
                )
              }
              onMorning={(keepIds, moveIds) =>
                void mutate(async (database) => {
                  await setManyDue(database, keepIds, today);
                  await setManyDue(database, moveIds, addDays(today, 1));
                  await setSetting(database, "morningDate", today);
                })
              }
              onSaveView={(name, filter) => void mutate((database) => saveView(database, name, filter))}
              onDeleteView={(id) => void mutate((database) => deleteView(database, id))}
              onPrint={() => window.print()}
              onExport={(kind) =>
                void exportText(kind === "csv" ? boardCsv(data) : boardText(data, today), kind === "csv" ? "todo-tracker.csv" : "todo-tracker.txt")
              }
              onBulkDone={(ids) => void mutate((database) => setManyStatus(database, ids, "done"))}
              onBulkDue={(ids, dueOn) => void mutate((database) => setManyDue(database, ids, dueOn))}
            />
          )}
          {data && !searching && screen.name === "people" && (
            <People
              data={data}
              today={today}
              onOpen={(id) => openScreen({ name: "person", personId: id })}
              onAdd={async (name) => {
                const id = await mutate((database) => addPerson(database, name));
                if (id) openScreen({ name: "person", personId: id });
              }}
            />
          )}
          {data && !searching && screen.name === "person" && (
            <PersonPage
              data={data}
              personId={screen.personId}
              today={today}
              focusMeetingId={screen.meetingId}
              onLog={() => openSheet(screen.personId)}
              onDone={(task) => void onTask(task, { type: "status", status: "done" })}
              onReopen={(task) => void onTask(task, { type: "status", status: "open" })}
              onSetAside={(task) => void onTask(task, { type: "status", status: "set_aside" })}
              onTitle={(task, title) => void mutate((database) => updateTaskTitle(database, task.id, title))}
              onDue={(task, dueOn) => void mutate((database) => updateTaskDue(database, task.id, dueOn))}
              onNote={(note) => void mutate((database) => updatePersonNote(database, screen.personId, note))}
              onMeeting={(meeting: Meeting, fields) => void mutate((database) => updateMeeting(database, meeting.id, fields))}
              onDeleteMeeting={(meetingId) => void mutate((database) => deleteMeeting(database, meetingId))}
              onDeletePerson={() => {
                const id = screen.personId;
                void mutate(async (database) => {
                  await deletePerson(database, id);
                  past.current = past.current.filter((item) => item.name !== "person" || item.personId !== id);
                  setCanBack(past.current.length > 0);
                  screenRef.current = { name: "home" };
                  setScreen({ name: "home" });
                });
              }}
              tools={{
                onAction: (task, action) => void onTask(task, action),
                onPerson: (fields) => void mutate((database) => updatePerson(database, screen.personId, fields)),
                onCompany: (name) =>
                  void mutate(async (database) => {
                    const id = await addCompany(database, name);
                    await updatePerson(database, screen.personId, { companyId: id });
                  }),
                onGuests: (meetingId, ids) => void mutate((database) => updateGuests(database, meetingId, ids)),
                onDecision: (meetingId, body) => void mutate((database) => addDecision(database, meetingId, body)),
                onDeleteDecision: (id) => void mutate((database) => deleteDecision(database, id)),
                onBrief: () => openScreen({ name: "brief", personId: screen.personId }),
                onBeside: () => {
                  const person = data.people.find((item) => item.id === screen.personId);
                  void openBeside(screen.personId, person?.name ?? "To-Do Tracker").catch(() =>
                    showToast({ message: "Could not open a second window.", undo: null }, 4000),
                  );
                },
                onGift: (body) => void mutate((database) => addGift(database, screen.personId, body)),
                onDate: (label, onDate) => void mutate((database) => addLifeDate(database, screen.personId, label, onDate)),
                onAsk: (body, onDate) => void mutate((database) => addAsk(database, screen.personId, body, onDate)),
                onSection: (name) => void mutate((database) => addSection(database, screen.personId, name)),
                onOnly: () => setting("onlyPersonId", data.settings.onlyPersonId === screen.personId ? "" : screen.personId),
                onMessage: () =>
                  showToast(
                    {
                      message: `Open asks for ${data.people.find((person) => person.id === screen.personId)?.name ?? "them"} are on this page.`,
                      undo: null,
                    },
                    4000,
                  ),
                onDropText: (title, note) => void mutate((database) => addLooseTask(database, screen.personId, title, note)),
                onTopic: (text) =>
                  void mutate((database) =>
                    replaceBullets(database, "person", screen.personId, "topic", [
                      ...(data.bullets ?? [])
                        .filter((bullet) => bullet.ownerKind === "person" && bullet.ownerId === screen.personId && bullet.kind === "topic")
                        .map((bullet) => ({ text: bullet.body, indent: bullet.indent })),
                      { text, indent: 0 },
                    ]),
                  ),
                onExport: () => void exportText(personOpenText(data, screen.personId, today), "open-tasks.txt"),
                onExportMeeting: (meetingId) => void exportText(meetingText(data, meetingId, today), "meeting.txt"),
                onToggleHide: () => setting("hideFinished", data.settings.hideFinished ? "0" : "1"),
                onToggleSort: () => setting("sortClosest", data.settings.sortClosest ? "0" : "1"),
              }}
            />
          )}
          {data && !searching && screen.name === "review" && (
            <ReviewPage
              data={data}
              today={today}
              onStatus={(task, status) => void onTask(task, { type: "status", status })}
            />
          )}
          {data && !searching && screen.name === "archive" && (
            <ArchivePage
              data={data}
              today={today}
              onReopen={(task) => void onTask(task, { type: "status", status: "open" })}
              onOpen={openTask}
            />
          )}
          {data && !searching && screen.name === "day" && (
            <DayPage
              data={data}
              today={today}
              onLog={(kind, body) => void mutate((database) => addDayLog(database, today, kind, body))}
              onCarry={(ids) => void mutate((database) => setManyDue(database, ids, addDays(today, 1)))}
              onAdd={(body) => void mutate((database) => addLooseTask(database, null, body, ""))}
              onOpenTask={openTask}
            />
          )}
          {data && !searching && screen.name === "boxes" && <BoxesPage data={data} today={today} onOpenTask={openTask} />}
          {data && !searching && screen.name === "someday" && <SomedayPage data={data} onOpenTask={openTask} />}
          {data && !searching && screen.name === "brief" && (
            <BriefPage data={data} personId={screen.personId} today={today} onBack={goBack} />
          )}
          {data && !searching && screen.name === "settings" && (
            <SettingsPage
              data={data}
              onTheme={() => setting("theme", data.settings.theme === "dark" ? "light" : "dark")}
              onType={() => setting("typeSize", data.settings.typeSize === "large" ? "normal" : "large")}
              onKeep={() => setting("keepSheetOpen", data.settings.keepSheetOpen ? "0" : "1")}
              onHide={() => setting("hideFinished", data.settings.hideFinished ? "0" : "1")}
              onSort={() => setting("sortClosest", data.settings.sortClosest ? "0" : "1")}
              onContrast={() => setting("contrast", data.settings.contrast ? "0" : "1")}
              onWeekday={() => setting("weekdayOnly", data.settings.weekdayOnly ? "0" : "1")}
              onValue={(key, value) => setting(key, value)}
              onSay={() =>
                void sayText(
                  tasksForHome(data, today)
                    .filter((task) => task.dueOn && task.dueOn <= today)
                    .map((task) => task.title)
                    .join(". ") || "Nothing is due",
                )
              }
              onCard={() => void openCard()}
              onBackup={() =>
                void backupNow(`todo-tracker-${today}.db`)
                  .then((path) => mutate((database) => setSetting(database, "backupPath", path), { throwOnError: true }))
                  .then(() => showToast({ message: "Backup saved on this Mac.", undo: null }, 4000))
                  .catch((caught: unknown) =>
                    showToast({ message: caught instanceof Error ? caught.message : "Could not back up.", undo: null }, 5000),
                  )
              }
              onRestore={(id) => void mutate((database) => restoreRemoved(database, id))}
              onExportText={() => void exportText(boardText(data, today), "todo-tracker.txt")}
              onExportCsv={() => void exportText(boardCsv(data), "todo-tracker.csv")}
              onPrint={() => {
                openScreen({ name: "home" });
                window.setTimeout(() => window.print(), 50);
              }}
            />
          )}
        </div>
      </main>
      {sheetOpen && data && (
        <MeetingSheet
          data={data}
          presetPersonId={sheetPersonId}
          presetDate={sheetDate}
          presetEvent={agendaPick}
          agenda={events}
          travelDates={events.filter((item) => /travel|offsite|flight|ooo/i.test(item.title)).map((item) => item.date)}
          busy={busy}
          stayOpen={data.settings.keepSheetOpen}
          onDirty={setSheetDirty}
          onClose={() => setSheetOpen(false)}
          onSave={onSave}
          onSaveTemplate={(name, lines) => void mutate((database) => saveTemplate(database, name, lines))}
          onDeleteTemplate={(id) => void mutate((database) => deleteTemplate(database, id))}
        />
      )}
      {palette !== null && data && (
        <Palette
          data={data}
          initialQuery={palette}
          onClose={() => setPalette(null)}
          onPerson={(id) => openScreen({ name: "person", personId: id })}
          onTask={openTask}
          onDone={(task) => void onTask(task, { type: "status", status: "done" })}
          onScreen={(name) => openScreen({ name } as Screen)}
          onLog={() => openSheet(null)}
          onPrint={() => window.print()}
          onToggleTheme={() => setting("theme", data.settings.theme === "dark" ? "light" : "dark")}
          onToggleType={() => setting("typeSize", data.settings.typeSize === "large" ? "normal" : "large")}
        />
      )}
      {data && inspectedTaskId && data.tasks.find((task) => task.id === inspectedTaskId) && (
        <TaskInspector key={inspectedTaskId} task={data.tasks.find((task) => task.id === inspectedTaskId)!} data={data} today={today}
          onAction={(action) => void onTask(data.tasks.find((task) => task.id === inspectedTaskId)!, action)} onClose={() => setInspectedTaskId("")} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                const run = toast.undo;
                if (toastTimer.current) window.clearTimeout(toastTimer.current);
                setToast(null);
                if (run) void run();
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      <div className="sk-line wide" />
      <div className="sk-line" />
      <div className="sk-cards">
        <div />
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}
