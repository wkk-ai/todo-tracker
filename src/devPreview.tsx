import { useState } from "react";
import { MeetingSheet } from "./MeetingSheet";
import { TaskInspector } from "./TaskInspector";
import { Workspace, type WorkspacePage } from "./Workspace";
import { captureDue, inferCapture, type CaptureEntry, type CaptureKind } from "./capture";
import { Icon } from "./icons";
import { DEFAULT_SETTINGS, addDays, todayISO, type Data, type Meeting, type Person, type Task } from "./logic";
import type { NewTaskInput, SaveMeetingInput, TaskAction } from "./db";
import type { CalEvent } from "./native";
import "./devPreview.css";

type PreviewData = Data & { captureEntries: CaptureEntry[] };

const wait = (duration = 220) => new Promise<void>((resolve) => window.setTimeout(resolve, duration));

function eventAt(day: string, hour: number, minute: number): string {
  const date = new Date(`${day}T00:00:00`);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function timeLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function createEvents(today: string): CalEvent[] {
  const now = new Date();
  const liveStart = new Date(now.getTime() - 12 * 60_000);
  const liveEnd = new Date(now.getTime() + 24 * 60_000);
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const tomorrowStart = new Date(eventAt(tomorrow, 9, 30));
  const tomorrowEnd = new Date(eventAt(tomorrow, 10, 15));
  const laterStart = new Date(eventAt(dayAfter, 14, 0));
  const laterEnd = new Date(eventAt(dayAfter, 14, 45));
  return [
    {
      id: "preview-live-event",
      date: today,
      time: `${timeLabel(liveStart)}–${timeLabel(liveEnd)}`,
      title: "Campaign QA sync",
      url: "https://meet.google.com/preview-only",
      start: liveStart.toISOString(),
      end: liveEnd.toISOString(),
    },
    {
      id: "preview-tomorrow-event",
      date: tomorrow,
      time: `${timeLabel(tomorrowStart)}–${timeLabel(tomorrowEnd)}`,
      title: "Q4 programmatic review",
      url: "https://meet.google.com/preview-only",
      start: tomorrowStart.toISOString(),
      end: tomorrowEnd.toISOString(),
    },
    {
      id: "preview-upcoming-event",
      date: dayAfter,
      time: `${timeLabel(laterStart)}–${timeLabel(laterEnd)}`,
      title: "Partner forecast check-in",
      url: "https://meet.google.com/preview-only",
      start: laterStart.toISOString(),
      end: laterEnd.toISOString(),
    },
  ];
}

function person(id: string, name: string, color: string): Person {
  return {
    id,
    name,
    note: "",
    createdAt: "2026-01-05T09:00:00.000Z",
    color,
    companyId: null,
    checkInOn: null,
    cadenceDays: null,
  };
}

function meeting(
  id: string,
  personId: string,
  title: string,
  meetingDate: string,
  calendarUid = "",
): Meeting {
  return {
    id,
    personId,
    title,
    meetingDate,
    note: "",
    createdAt: `${meetingDate}T15:00:00.000Z`,
    guestIds: [],
    calendarUid,
  };
}

function task(
  id: string,
  title: string,
  requesterId: string,
  meetingId: string,
  dueOn: string | null,
  options: Partial<Task> = {},
): Task {
  return {
    id,
    meetingId,
    requesterId,
    title,
    requestedOn: todayISO(),
    dueOn,
    status: "open",
    completedAt: null,
    createdAt: new Date().toISOString(),
    priority: "none",
    pinned: false,
    evening: false,
    repeatRule: null,
    notes: "",
    movedCount: 0,
    parentId: null,
    remind: false,
    updatedAt: todayISO(),
    tagIds: [],
    owner: "mine",
    ...options,
  };
}

function fixtureData(today: string, events: CalEvent[]): PreviewData {
  const people = [
    person("preview-maya", "Maya Chen", "#7D9A84"),
    person("preview-sofia", "Sofia Rivera", "#8AA0B4"),
    person("preview-daniel", "Daniel Kim", "#B48A9A"),
  ];
  const programmatic = meeting("preview-programmatic", people[0].id, "Programmatic launch planning", addDays(today, -1));
  const live = meeting("preview-live", people[1].id, "Campaign QA sync", today, events[0].id);
  live.guestIds = [people[0].id];
  live.nextOn = addDays(today, 7);
  live.nextFocus = "Confirm the pilot readout";
  const inventory = meeting("preview-inventory", people[2].id, "Inventory and yield review", addDays(today, -8));
  return {
    people,
    companies: [{ id: "preview-company", name: "Northstar Media" }],
    meetings: [programmatic, live, inventory],
    tasks: [
      task("preview-task-1", "Draft the programmatic test plan", people[0].id, programmatic.id, today, {
        status: "in_progress",
        priority: "high",
        notes: "Keep the first test to two placements.",
        sourceLine: "Programmatic launch planning",
      }),
      task("preview-task-2", "Send the pilot brief to Ad Ops", people[1].id, live.id, addDays(today, 1), {
        sourceLine: "Campaign QA sync",
      }),
      task("preview-task-3", "Upload the placement reconciliation", people[0].id, programmatic.id, addDays(today, -2), {
        priority: "medium",
      }),
      task("preview-task-4", "Confirm Q4 media rates", people[1].id, programmatic.id, addDays(today, 2), {
        owner: "theirs",
        sourceLine: "Asked by Maya · Programmatic launch planning",
      }),
      task("preview-task-5", "Approve launch assets", people[2].id, inventory.id, addDays(today, 3), {
        owner: "theirs",
        sourceLine: "Asked by Maya · Inventory and yield review",
      }),
    ],
    checks: [],
    tags: [{ id: "preview-tag-programmatic", name: "Programmatic" }],
    decisions: [
      {
        id: "preview-decision-1",
        meetingId: programmatic.id,
        body: "Start with a two-week pilot.",
        createdAt: `${addDays(today, -1)}T15:00:00.000Z`,
        why: "Keep placement risk small while we learn which inventory performs.",
      },
      {
        id: "preview-decision-2",
        meetingId: live.id,
        body: "Use one shared QA checklist for the launch.",
        createdAt: `${today}T10:00:00.000Z`,
        why: "A single checklist makes handoffs easier to verify.",
      },
    ],
    activity: [],
    attachments: [],
    templates: [],
    views: [],
    removed: [],
    settings: { ...DEFAULT_SETTINGS, lastPersonId: people[0].id },
    bullets: [
      { id: "preview-note-1", ownerKind: "meeting", ownerId: programmatic.id, kind: "note", body: "Initial read points to strong reach in premium inventory.", indent: 0, position: 1, done: false, folded: false },
      { id: "preview-topic-1", ownerKind: "meeting", ownerId: programmatic.id, kind: "topic", body: "Programmatic", indent: 0, position: 1, done: false, folded: false },
      { id: "preview-topic-2", ownerKind: "meeting", ownerId: programmatic.id, kind: "topic", body: "Launch readiness", indent: 0, position: 2, done: false, folded: false },
      { id: "preview-question-1", ownerKind: "meeting", ownerId: programmatic.id, kind: "question", body: "Which inventory should the pilot include?", indent: 0, position: 1, done: false, folded: false },
      { id: "preview-note-2", ownerKind: "meeting", ownerId: live.id, kind: "note", body: "Three campaign checks are ready; one needs an owner.", indent: 0, position: 1, done: false, folded: false },
      { id: "preview-topic-3", ownerKind: "meeting", ownerId: live.id, kind: "topic", body: "Campaign QA", indent: 0, position: 1, done: false, folded: false },
      { id: "preview-topic-4", ownerKind: "meeting", ownerId: live.id, kind: "topic", body: "Programmatic", indent: 0, position: 2, done: false, folded: false },
      { id: "preview-note-3", ownerKind: "meeting", ownerId: inventory.id, kind: "note", body: "The revised forecast is within the agreed range.", indent: 0, position: 1, done: false, folded: false },
      { id: "preview-topic-5", ownerKind: "meeting", ownerId: inventory.id, kind: "topic", body: "Inventory", indent: 0, position: 1, done: false, folded: false },
    ],
    sections: [],
    lifeDates: [],
    gifts: [],
    asks: [],
    logs: [],
    captureEntries: [
      {
        id: "preview-capture-note",
        body: "Ask whether the new inventory report includes PMP deals.",
        createdAt: `${today}T08:42:00.000Z`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMin: -new Date().getTimezoneOffset(),
        kind: "note",
        actorId: "",
        meetingId: programmatic.id,
        taskId: "",
      },
      {
        id: "preview-capture-task",
        body: "Sofia will confirm the updated rates tomorrow.",
        createdAt: `${today}T08:55:00.000Z`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMin: -new Date().getTimezoneOffset(),
        kind: "theirs",
        actorId: people[1].id,
        meetingId: live.id,
        taskId: "preview-task-4",
      },
    ],
  };
}

function titleFor(action: TaskAction): string {
  if (action.type === "status") return action.status === "done" ? "Task marked complete." : `Task moved to ${action.status.replace("_", " ")}.`;
  if (action.type === "due") return action.dueOn ? "Task date updated." : "Task date cleared.";
  if (action.type === "title") return "Task title updated.";
  return "Preview task updated.";
}

function previewTaskFromCapture(entry: CaptureEntry, kind: CaptureKind, actorId: string, dueOn: string | null): Task {
  return task(entry.taskId, entry.body.trim(), actorId, entry.meetingId, dueOn, {
    requestedOn: todayISO(new Date(entry.createdAt)),
    createdAt: entry.createdAt,
    owner: kind === "theirs" ? "theirs" : "mine",
    sourceLine: "Quick capture",
  });
}

function meetingTask(input: NewTaskInput, meetingId: string, personId: string): Task {
  const owner = input.owner === "theirs" ? "theirs" : "mine";
  return task(`preview-${crypto.randomUUID()}`, input.title.trim(), input.requesterId || personId, meetingId, input.dueOn, {
    evening: input.evening,
    repeatRule: input.repeatRule,
    repeatAnchorDay: input.repeatAnchorDay,
    owner,
    indent: input.indent,
    doOn: input.doOn,
    durationMin: input.durationMin,
    clockTime: input.clockTime,
    sourceLine: input.sourceLine,
  });
}

export function DevPreview() {
  const today = todayISO();
  const [events] = useState(() => createEvents(today));
  const [data, setData] = useState<PreviewData>(() => fixtureData(today, events));
  const [page, setPage] = useState<WorkspacePage>("today");
  const [failSaves, setFailSaves] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetEvent, setSheetEvent] = useState<CalEvent | null>(null);
  const [inspectedTaskId, setInspectedTaskId] = useState("");
  const [message, setMessage] = useState("Fictional sample data is loaded in memory.");
  const [counter, setCounter] = useState(0);
  const previewEvent = events[1];

  function openMeetingForm(event: CalEvent | undefined) {
    setSheetEvent(event ?? null);
    setSheetOpen(true);
  }

  async function saveMeeting(input: SaveMeetingInput): Promise<void> {
    await wait();
    if (failSaves) throw new Error("Preview save failed on purpose. Your meeting draft is still here; switch off the error toggle and retry.");

    let personId = input.personId;
    let newPerson: Person | undefined;
    if (!personId && input.newPersonName) {
      const matching = data.people.find((person) => person.name.trim().toLocaleLowerCase() === input.newPersonName?.trim().toLocaleLowerCase());
      personId = matching?.id ?? `preview-person-${crypto.randomUUID()}`;
      if (!matching) newPerson = person(personId, input.newPersonName.trim(), "#8AA0B4");
    }
    if (!personId) throw new Error("Choose a person for the preview meeting.");

    const existing = input.calendarUid ? data.meetings.find((item) => item.calendarUid === input.calendarUid) : undefined;
    const meetingId = existing?.id ?? `preview-meeting-${crypto.randomUUID()}`;
    const previewMeeting = existing ?? {
      id: meetingId,
      personId,
      title: input.title.trim(),
      meetingDate: input.meetingDate,
      note: input.note,
      createdAt: new Date().toISOString(),
      guestIds: [...new Set(input.guestIds)],
      privateNote: input.privateNote,
      nextOn: input.nextOn,
      nextFocus: input.nextFocus,
      spanEnd: input.spanEnd,
      sourceUrl: input.sourceUrl,
      calendarUid: input.calendarUid,
    };
    const addedTasks = input.tasks.filter((item) => item.title.trim()).map((item) => meetingTask(item, meetingId, personId!));
    const addedDecisions = input.decisions.map((body, index) => ({
      id: `preview-decision-${crypto.randomUUID()}`,
      meetingId,
      body: body.trim(),
      createdAt: new Date().toISOString(),
      why: input.decisionWhys?.[index]?.trim() ?? "",
    })).filter((decision) => decision.body);
    const addedBullets = [
      ...(input.noteLines ?? []).map((line) => ({ ...line, kind: "note" })),
      ...(input.topics ?? []).map((line) => ({ ...line, kind: "topic" })),
      ...(input.questions ?? []).map((line) => ({ ...line, kind: "question" })),
    ].filter((line) => line.text.trim()).map((line, index) => ({
      id: `preview-bullet-${crypto.randomUUID()}`,
      ownerKind: "meeting",
      ownerId: meetingId,
      kind: line.kind,
      body: line.text.trim(),
      indent: line.indent,
      position: index + 1,
      done: Boolean("done" in line && line.done),
      folded: Boolean("folded" in line && line.folded),
    }));
    setData((current) => ({
      ...current,
      people: newPerson ? [...current.people, newPerson] : current.people,
      meetings: existing ? current.meetings : [...current.meetings, previewMeeting],
      tasks: [...current.tasks, ...addedTasks],
      decisions: [...current.decisions, ...addedDecisions],
      bullets: [...current.bullets, ...addedBullets],
      meetingSaveReceipts: [
        ...(current.meetingSaveReceipts ?? []),
        { saveId: input.saveId ?? `preview-save-${crypto.randomUUID()}`, meetingId, personId: personId!, taskCount: addedTasks.length },
      ],
    }));
    setCounter((value) => value + 1);
    setMessage("Preview meeting saved to fictional in-memory data.");
    setPage("meetings");
  }

  async function saveCapture(entry: Pick<CaptureEntry, "id" | "body" | "createdAt" | "timezone" | "offsetMin" | "meetingId">): Promise<void> {
    await wait(180);
    if (failSaves) throw new Error("Preview save failed on purpose. Your bullet is still here; switch off the error toggle and retry.");
    const duplicate = data.captureEntries.some((item) => item.id === entry.id);
    if (duplicate) throw new Error("This preview bullet was already saved. Refresh the fixture to retry from scratch.");
    const inferred = inferCapture(entry.body, data.people);
    const saved: CaptureEntry = {
      ...entry,
      ...inferred,
      body: entry.body.trim(),
      taskId: inferred.kind === "note" ? "" : `preview-capture-task-${crypto.randomUUID()}`,
    };
    const dueOn = captureDue(saved.body, saved.createdAt);
    const createdTask = saved.taskId ? previewTaskFromCapture(saved, saved.kind, saved.actorId, dueOn) : null;
    setData((current) => ({
      ...current,
      captureEntries: [saved, ...current.captureEntries],
      tasks: createdTask ? [...current.tasks, createdTask] : current.tasks,
    }));
    setCounter((value) => value + 1);
    setMessage(saved.kind === "note" ? "Preview note added." : `${saved.kind === "mine" ? "My task" : "Waiting task"} inferred and added in memory.`);
  }

  async function correctCapture(entry: CaptureEntry, patch: { kind?: CaptureKind; actorId?: string; meetingId?: string }): Promise<void> {
    await wait(140);
    if (failSaves) throw new Error("Preview update failed on purpose. Switch off the error toggle and retry.");
    const kind = patch.kind ?? entry.kind;
    const actorId = kind === "theirs" ? patch.actorId ?? entry.actorId : "";
    const meetingId = patch.meetingId ?? entry.meetingId;
    const taskId = kind === "note" ? entry.taskId : entry.taskId || `preview-capture-task-${crypto.randomUUID()}`;
    const updated: CaptureEntry = { ...entry, ...patch, kind, actorId, meetingId, taskId };
    setData((current) => {
      let tasks = current.tasks;
      const existingTask = tasks.find((item) => item.id === entry.taskId);
      if (kind === "note" && entry.taskId) {
        tasks = tasks.map((item) => item.id === entry.taskId ? { ...item, status: "void", updatedAt: today } : item);
      } else if (existingTask) {
        tasks = tasks.map((item) => item.id === entry.taskId ? {
          ...item,
          owner: kind === "theirs" ? "theirs" : "mine",
          requesterId: actorId,
          meetingId,
          status: item.status === "void" ? "open" : item.status,
          updatedAt: today,
        } : item);
      } else if (kind !== "note") {
        tasks = [...tasks, previewTaskFromCapture(updated, kind, actorId, captureDue(entry.body, entry.createdAt))];
      }
      return {
        ...current,
        captureEntries: current.captureEntries.map((item) => item.id === entry.id ? updated : item),
        tasks,
      };
    });
    setCounter((value) => value + 1);
    setMessage("Preview interpretation updated in memory.");
  }

  function applyTaskAction(selected: Task, action: TaskAction): void {
    setData((current) => {
      let tasks = current.tasks;
      let checks = current.checks;
      let attachments = current.attachments;
      let tags = current.tags;
      switch (action.type) {
        case "status":
          tasks = tasks.map((item) => item.id === selected.id ? { ...item, status: action.status, completedAt: action.status === "done" ? today : null, updatedAt: today } : item);
          break;
        case "title":
          tasks = tasks.map((item) => item.id === selected.id ? { ...item, title: action.title, updatedAt: today } : item);
          break;
        case "due":
          tasks = tasks.map((item) => item.id === selected.id ? { ...item, dueOn: action.dueOn, updatedAt: today } : item);
          break;
        case "patch": {
          const patch = action.patch;
          let tagIds: string[] | undefined;
          if (patch.tagNames) {
            const names = [...new Set(patch.tagNames.map((name) => name.trim()).filter(Boolean))];
            tagIds = names.map((name) => {
              const existing = tags.find((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase());
              if (existing) return existing.id;
              const id = `preview-tag-${crypto.randomUUID()}`;
              tags = [...tags, { id, name }];
              return id;
            });
          }
          const taskPatch = { ...patch };
          delete taskPatch.tagNames;
          tasks = tasks.map((item) => item.id === selected.id ? { ...item, ...taskPatch, ...(tagIds ? { tagIds } : {}), updatedAt: today } : item);
          break;
        }
        case "check-add": {
          const position = checks.filter((item) => item.taskId === selected.id).reduce((max, item) => Math.max(max, item.position), 0) + 1;
          checks = [...checks, { id: `preview-check-${crypto.randomUUID()}`, taskId: selected.id, title: action.title, done: false, position }];
          break;
        }
        case "check-toggle":
          checks = checks.map((item) => item.id === action.id ? { ...item, done: action.done } : item);
          break;
        case "check-delete":
          checks = checks.filter((item) => item.id !== action.id);
          break;
        case "subtask":
          tasks = [...tasks, task(`preview-subtask-${crypto.randomUUID()}`, action.title, selected.requesterId, selected.meetingId, null, { parentId: selected.id })];
          break;
        case "ask":
          tasks = [...tasks, task(`preview-task-${crypto.randomUUID()}`, action.title, action.personId ?? "", "", null)];
          break;
        case "attach":
          setMessage("File access is disabled in the synthetic preview.");
          break;
        case "detach":
          attachments = attachments.filter((item) => item.id !== action.id);
          break;
      }
      return { ...current, tasks, checks, attachments, tags };
    });
    setMessage(titleFor(action));
  }

  function reset(): void {
    setData(fixtureData(today, events));
    setPage("today");
    setSheetOpen(false);
    setInspectedTaskId("");
    setCounter(0);
    setMessage("Fictional sample data reset in memory.");
  }

  return (
    <div className="app workspace-app dp-shell">
      <aside className="sidebar no-print dp-sidebar">
        <div className="brand">To-Do Tracker</div>
        <label className="search"><span className="sr-only">Search sample data</span><input placeholder="Search" readOnly /></label>
        <nav className="nav" aria-label="Main navigation">
          {(["today", "capture", "meetings", "knowledge"] as const).map((item) => {
            const label = item === "today" ? "Today" : item === "capture" ? "Capture" : item === "meetings" ? "Meetings" : "Knowledge";
            const icon = item === "today" ? "sun" : item === "capture" ? "plus" : item === "meetings" ? "calendar" : "link";
            return <button key={item} className={page === item ? "nav-button active" : "nav-button"} aria-current={page === item ? "page" : undefined} onClick={() => setPage(item)}><Icon name={icon} />{label}</button>;
          })}
        </nav>
        <button className="primary sidebar-action" type="button" onClick={() => setPage("capture")}><span className="with-icon"><Icon name="plus" />Quick capture</span><kbd className="kbd">⌘N</kbd></button>
        <div className="dp-demo-status"><span className="dp-status-dot" />Fictional data<br />No database connection</div>
      </aside>
      <main className="main">
        <div className="main-inner workspace-page">
          <header className="dp-toolbar">
            <div className="dp-toolbar-top">
              <div className="dp-preview-title"><span>Development preview</span><strong>My Tasks · Waiting · Meetings · Knowledge</strong></div>
              <label className="dp-error-toggle"><input type="checkbox" checked={failSaves} onChange={(event) => setFailSaves(event.target.checked)} /><span>Simulate save errors</span></label>
              <button className="dp-form-link" type="button" onClick={() => openMeetingForm(previewEvent)}>Try meeting save</button>
              <button className="dp-reset" type="button" onClick={reset}>Reset sample</button>
            </div>
            <div className="dp-status-line" aria-live="polite"><span>In-memory changes: {counter}</span><span>{message}</span></div>
          </header>
          <Workspace
            data={data}
            page={page}
            today={today}
            events={events}
            agendaError=""
            onRefreshAgenda={() => setMessage("Calendar refresh is simulated in this preview.")}
            onOpenTask={(selected) => { setInspectedTaskId(selected.id); setMessage(`Selected: ${selected.title}`); }}
            onAction={applyTaskAction}
            onOpenMeeting={(selected) => { setPage("meetings"); setMessage(`Selected: ${selected.title}`); }}
            onLog={(event) => openMeetingForm(event ?? events[1])}
            onCapture={saveCapture}
            onCorrect={correctCapture}
            onGoCapture={() => setPage("capture")}
            draftNamespace="preview"
          />
        </div>
      </main>
      {inspectedTaskId && data.tasks.find((item) => item.id === inspectedTaskId) && <TaskInspector
        key={inspectedTaskId}
        task={data.tasks.find((item) => item.id === inspectedTaskId)!}
        data={data}
        today={today}
        onAction={(action) => applyTaskAction(data.tasks.find((item) => item.id === inspectedTaskId)!, action)}
        onClose={() => setInspectedTaskId("")}
      />}
      {sheetOpen && <MeetingSheet
        data={data}
        presetPersonId="preview-maya"
        presetDate={today}
        presetEvent={sheetEvent}
        agenda={events}
        busy={false}
        stayOpen={false}
        onDirty={() => undefined}
        onClose={() => setSheetOpen(false)}
        onSave={saveMeeting}
        onSaveTemplate={(name, lines) => setData((current) => ({ ...current, templates: [...current.templates, { id: `preview-template-${crypto.randomUUID()}`, name, lines }] }))}
        onDeleteTemplate={(id) => setData((current) => ({ ...current, templates: current.templates.filter((item) => item.id !== id) }))}
        draftStorageKey="todo-tracker.dev-preview.meeting-draft.v1"
      />}
    </div>
  );
}
