import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { TaskAction } from "./db";
import { meetingSuggestions, inferCapture, type CaptureEntry, type CaptureKind } from "./capture";
import { Icon } from "./icons";
import { calendarEventMatches, formatDay, parseISODate, tasksForHome, type Data, type Meeting, type Task } from "./logic";
import type { CalEvent } from "./native";
import "./workspace.css";

export type WorkspacePage = "today" | "capture" | "meetings" | "knowledge";

type CapturePayload = Pick<CaptureEntry, "id" | "body" | "createdAt" | "timezone" | "offsetMin" | "meetingId">;

type Props = {
  data: Data;
  page: WorkspacePage;
  today: string;
  events: CalEvent[];
  agendaError: string;
  onRefreshAgenda: () => void;
  onOpenTask: (task: Task) => void;
  onAction: (task: Task, action: TaskAction) => void;
  onOpenMeeting: (meeting: Meeting) => void;
  onLog: (event?: CalEvent) => void;
  onCapture: (entry: CapturePayload) => Promise<void>;
  onCorrect: (entry: CaptureEntry, patch: { kind?: CaptureKind; actorId?: string; meetingId?: string }) => Promise<void>;
  onGoCapture: () => void;
  draftNamespace?: string;
};

type MeetingRow = { key: string; meeting?: Meeting; event?: CalEvent; sortAt: number };
type KnowledgeHit = {
  id: string;
  kind: "meeting" | "decision" | "task" | "capture";
  date: string;
  title: string;
  context: string;
  text: string;
  meetingId: string;
  taskId?: string;
  captureId?: string;
};
type KnowledgeSelection = { kind: KnowledgeHit["kind"]; id: string };
type TodayFocus = { kind: "task"; id: string } | { kind: "meeting"; key: string };
type CaptureDraft = {
  id: string;
  body: string;
  createdAt: string;
  timezone: string;
  offsetMin: number;
  meetingId: string;
};

const DRAFT_KEY = "todo-tracker.quick-capture.draft.v1";
const MEETING_CONTEXT_KEY = "todo-tracker.quick-capture.meeting.v1";

function emptyDraft(meetingId = ""): CaptureDraft {
  return { id: "", body: "", createdAt: "", timezone: "", offsetMin: 0, meetingId };
}

function scopedKey(key: string, namespace?: string): string {
  return namespace?.trim() ? `${key}.${namespace.trim()}` : key;
}

function readDraft(namespace?: string): CaptureDraft {
  try {
    const parsed = JSON.parse(localStorage.getItem(scopedKey(DRAFT_KEY, namespace)) ?? "null") as Partial<CaptureDraft> | null;
    const savedContext = localStorage.getItem(scopedKey(MEETING_CONTEXT_KEY, namespace)) ?? "";
    if (parsed && typeof parsed.body === "string") {
      return {
        ...emptyDraft(),
        ...parsed,
        id: typeof parsed.id === "string" ? parsed.id : "",
        body: parsed.body,
        meetingId: typeof parsed.meetingId === "string" ? parsed.meetingId : savedContext,
      };
    }
    return emptyDraft(savedContext);
  } catch {
    // Keep the capture page available if a local draft is malformed.
  }
  return emptyDraft();
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function safeDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseISODate(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateLabel(value: string | undefined, today: string): string {
  if (!value) return "Date not set";
  const date = safeDate(value);
  if (!date) return value;
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return formatDay(iso, today);
}

function fullDate(value?: string | null): string {
  const date = safeDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date) : "Date not set";
}

function eventStart(event: CalEvent): number {
  const parsed = event.start ? Date.parse(event.start) : NaN;
  if (!Number.isNaN(parsed)) return parsed;
  const date = safeDate(event.date);
  return date?.getTime() ?? 0;
}

function eventTime(event?: CalEvent): string {
  if (!event) return "";
  if (event.time.trim()) return event.time;
  if (!event.start || event.allDay) return event.allDay ? "All day" : "";
  const start = safeDate(event.start);
  const end = safeDate(event.end);
  if (!start) return "";
  const time = (value: Date) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
  return end ? `${time(start)}–${time(end)}` : time(start);
}

function captureTime(entry: Pick<CaptureEntry, "createdAt" | "timezone">): string {
  const date = safeDate(entry.createdAt);
  if (!date) return "Time unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: entry.timezone || undefined,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function entryLabel(kind: CaptureKind): string {
  return kind === "mine" ? "My task" : kind === "theirs" ? "Waiting" : "Note";
}

function dueText(task: Task, today: string): { text: string; late: boolean } | null {
  if (!task.dueOn) return null;
  return { text: dateLabel(task.dueOn, today), late: task.dueOn < today };
}

function excerpt(value: string, query: string, limit = 240): string {
  const lines = value.split(/\n|(?<=[.!?])\s+/).map((line) => line.trim()).filter(Boolean);
  const match = lines.find((line) => fold(line).includes(fold(query)));
  const source = match ?? lines[0] ?? value;
  return source.length > limit ? `${source.slice(0, limit).trimEnd()}…` : source;
}

function meetingRows(data: Data, events: CalEvent[]): MeetingRow[] {
  const attached = new Set<string>();
  const saved = data.meetings.map((meeting): MeetingRow => {
    const event = events.find((item) => calendarEventMatches(meeting, item));
    if (event) attached.add(event.id);
    return {
      key: `meeting:${meeting.id}`,
      meeting,
      event,
      sortAt: event ? eventStart(event) : safeDate(meeting.meetingDate)?.getTime() ?? 0,
    };
  });
  const unsaved = events
    .filter((event) => !attached.has(event.id))
    .map((event): MeetingRow => ({ key: `event:${event.id}`, event, sortAt: eventStart(event) }));
  return [...saved, ...unsaved].sort((a, b) => b.sortAt - a.sortAt);
}

function savedMeetingForEvent(data: Data, event: CalEvent): Meeting | undefined {
  return data.meetings.find((meeting) => calendarEventMatches(meeting, event));
}

function captureKindHint(kind: CaptureKind, people: Data["people"], actorId: string): string {
  if (kind === "mine") return "Will add to My Tasks";
  if (kind === "theirs") {
    const actor = people.find((person) => person.id === actorId)?.name;
    return actor ? `Will add to Waiting · ${actor}` : "Will add to Waiting · owner unknown";
  }
  return "Will save as a note";
}

function buildKnowledgeHits(data: Data, captures: CaptureEntry[]): KnowledgeHit[] {
  const hits: KnowledgeHit[] = [];
  const bullets = data.bullets.filter((bullet) => bullet.ownerKind === "meeting");
  const captureTaskIds = new Set(captures.map((entry) => entry.taskId).filter(Boolean));
  for (const meeting of data.meetings) {
    const own = bullets.filter((bullet) => bullet.ownerId === meeting.id);
    const text = [meeting.note, ...own.map((bullet) => bullet.body)].filter(Boolean).join("\n");
    hits.push({
      id: meeting.id,
      kind: "meeting",
      date: meeting.meetingDate || meeting.createdAt,
      title: meeting.title,
      context: `${fullDate(meeting.meetingDate)} · ${data.people.find((person) => person.id === meeting.personId)?.name ?? "Person not set"}`,
      text: text || "No notes saved for this meeting.",
      meetingId: meeting.id,
    });
  }
  for (const decision of data.decisions) {
    const meeting = data.meetings.find((item) => item.id === decision.meetingId);
    hits.push({
      id: decision.id,
      kind: "decision",
      date: decision.createdAt || meeting?.meetingDate || "",
      title: decision.body,
      context: meeting ? `Decision · ${meeting.title} · ${fullDate(meeting.meetingDate)}` : "Decision · Meeting not found",
      text: decision.why ? `Why: ${decision.why}` : decision.body,
      meetingId: decision.meetingId,
    });
  }
  for (const task of data.tasks.filter((item) => item.status !== "void" && !captureTaskIds.has(item.id))) {
    const meeting = data.meetings.find((item) => item.id === task.meetingId);
    hits.push({
      id: task.id,
      kind: "task",
      date: task.createdAt,
      title: task.title,
      context: meeting ? `Task · ${meeting.title} · ${fullDate(meeting.meetingDate)}` : "Task · No meeting linked",
      text: task.notes || task.sourceLine || "",
      meetingId: task.meetingId,
      taskId: task.id,
    });
  }
  for (const entry of captures) {
    const meeting = data.meetings.find((item) => item.id === entry.meetingId);
    hits.push({
      id: entry.id,
      kind: "capture",
      date: entry.createdAt,
      title: entry.body,
      context: `${entryLabel(entry.kind)} · ${meeting?.title ?? "No meeting linked"} · ${captureTime(entry)}`,
      text: entry.body,
      meetingId: entry.meetingId,
      taskId: entry.taskId || undefined,
      captureId: entry.id,
    });
  }
  return hits.sort((a, b) => (safeDate(b.date)?.getTime() ?? 0) - (safeDate(a.date)?.getTime() ?? 0));
}

function topicLabels(data: Data, meetingId: string): string[] {
  return data.bullets
    .filter((bullet) => bullet.ownerKind === "meeting" && bullet.ownerId === meetingId && bullet.kind === "topic" && bullet.body.trim())
    .map((bullet) => bullet.body.trim());
}

export function Workspace({
  data,
  page,
  today,
  events,
  agendaError,
  onRefreshAgenda,
  onOpenTask,
  onAction,
  onOpenMeeting,
  onLog,
  onCapture,
  onCorrect,
  onGoCapture,
  draftNamespace,
}: Props) {
  const captures = (data as Data & { captureEntries?: CaptureEntry[] }).captureEntries ?? [];
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [todayFocus, setTodayFocus] = useState<TodayFocus>({ kind: "task", id: "" });
  const [selectedMeetingKey, setSelectedMeetingKey] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeSelection, setKnowledgeSelection] = useState<KnowledgeSelection | null>(null);
  const [draft, setDraft] = useState<CaptureDraft>(() => readDraft(draftNamespace));
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [correctionError, setCorrectionError] = useState("");
  const [pendingEventId, setPendingEventId] = useState("");
  const [pendingEntryEvent, setPendingEntryEvent] = useState<{ entryId: string; eventId: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const taskRows = useMemo(() => {
    const tasks = tasksForHome(data, today).slice().sort((a, b) => {
      const due = (a.dueOn ?? "9999-99-99").localeCompare(b.dueOn ?? "9999-99-99");
      if (due) return due;
      const status = (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1);
      return status || b.createdAt.localeCompare(a.createdAt);
    });
    return { mine: tasks.filter((task) => task.owner !== "theirs"), waiting: tasks.filter((task) => task.owner === "theirs") };
  }, [data, today]);
  const meetings = useMemo(() => meetingRows(data, events), [data, events]);
  const knowledgeHits = useMemo(() => buildKnowledgeHits(data, captures), [data, captures]);
  const activeMeetingId = draft.meetingId;
  const activeMeeting = data.meetings.find((meeting) => meeting.id === activeMeetingId);
  const currentTask = taskRows.mine.concat(taskRows.waiting).find((task) => task.id === selectedTaskId) ?? null;
  const taskCapture = currentTask ? captures.find((entry) => entry.taskId === currentTask.id) : undefined;
  const taskMeeting = currentTask?.meetingId ? data.meetings.find((meeting) => meeting.id === currentTask.meetingId) : undefined;
  const selectedMeetingRow = meetings.find((item) => item.key === selectedMeetingKey) ?? null;
  const selectedEntry = captures.find((entry) => entry.id === selectedEntryId) ?? null;
  const selectedKnowledgeHit = knowledgeSelection
    ? knowledgeHits.find((hit) => hit.id === knowledgeSelection.id && hit.kind === knowledgeSelection.kind) ?? null
    : null;
  useEffect(() => {
    const available = taskRows.mine.concat(taskRows.waiting);
    if (selectedTaskId && available.some((task) => task.id === selectedTaskId)) return;
    const nextId = taskRows.mine[0]?.id ?? taskRows.waiting[0]?.id ?? "";
    setSelectedTaskId(nextId);
    setTodayFocus((current) => current.kind === "meeting" ? current : { kind: "task", id: nextId });
  }, [selectedTaskId, taskRows]);

  useEffect(() => {
    if (!selectedMeetingKey || !meetings.some((item) => item.key === selectedMeetingKey)) {
      setSelectedMeetingKey(meetings[0]?.key ?? "");
    }
  }, [selectedMeetingKey, meetings]);

  useEffect(() => {
    if (!selectedEntryId || !captures.some((entry) => entry.id === selectedEntryId)) {
      setSelectedEntryId(captures[0]?.id ?? "");
    }
  }, [selectedEntryId, captures]);

  useEffect(() => {
    try {
      const key = scopedKey(DRAFT_KEY, draftNamespace);
      if (draft.body.trim()) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    } catch {
      // Saving to the database still works when local storage is unavailable.
    }
  }, [draft, draftNamespace]);

  useEffect(() => {
    try {
      const key = scopedKey(MEETING_CONTEXT_KEY, draftNamespace);
      if (draft.meetingId) localStorage.setItem(key, draft.meetingId);
      else localStorage.removeItem(key);
    } catch {
      // Meeting context is a convenience; the explicit picker remains available.
    }
  }, [draft.meetingId, draftNamespace]);

  useEffect(() => {
    if (page === "capture") window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [page]);

  useEffect(() => {
    if (!pendingEventId) return;
    const event = events.find((item) => item.id === pendingEventId);
    const linked = event ? savedMeetingForEvent(data, event) : undefined;
    if (!linked) return;
    setDraft((current) => ({ ...current, meetingId: linked.id }));
    setSelectedMeetingKey(`meeting:${linked.id}`);
    setTodayFocus({ kind: "meeting", key: `meeting:${linked.id}` });
    setPendingEventId("");
  }, [pendingEventId, data.meetings, events]);

  useEffect(() => {
    if (!pendingEntryEvent) return;
    const event = events.find((item) => item.id === pendingEntryEvent.eventId);
    const linked = event ? savedMeetingForEvent(data, event) : undefined;
    const entry = captures.find((item) => item.id === pendingEntryEvent.entryId);
    if (!linked || !entry) return;
    setCorrectionError("");
    void onCorrect(entry, { meetingId: linked.id })
      .catch((error: unknown) => setCorrectionError(error instanceof Error ? error.message : "Could not attach this note."))
      .finally(() => setPendingEntryEvent(null));
  }, [pendingEntryEvent, data.meetings, events, captures, onCorrect]);

  function setDraftText(body: string) {
    setCaptureError("");
    setDraft((current) => {
      if (!current.createdAt && body.trim()) {
        const now = new Date();
        return {
          ...current,
          id: crypto.randomUUID(),
          body,
          createdAt: now.toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          offsetMin: -now.getTimezoneOffset(),
        };
      }
      return { ...current, body };
    });
  }

  async function saveCapture(event?: FormEvent | KeyboardEvent<HTMLTextAreaElement>) {
    event?.preventDefault();
    const body = draft.body.trim();
    if (!body || captureBusy) return;
    const now = new Date();
    const payload: CapturePayload = {
      id: draft.id || crypto.randomUUID(),
      body,
      createdAt: draft.createdAt || now.toISOString(),
      timezone: draft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMin: draft.createdAt ? draft.offsetMin : -now.getTimezoneOffset(),
      meetingId: draft.meetingId,
    };
    setCaptureBusy(true);
    setCaptureError("");
    try {
      await onCapture(payload);
      setDraft(emptyDraft(draft.meetingId));
      setSelectedEntryId(payload.id);
      inputRef.current?.focus();
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "This bullet did not save. Your draft is still here.");
    } finally {
      setCaptureBusy(false);
    }
  }

  function beginEventContext(event: CalEvent) {
    const saved = savedMeetingForEvent(data, event);
    if (saved) {
      setDraft((current) => ({ ...current, meetingId: saved.id }));
      return;
    }
    setPendingEventId(event.id);
    onLog(event);
  }

  function requestEntryEvent(entry: CaptureEntry, event: CalEvent) {
    const saved = savedMeetingForEvent(data, event);
    if (saved) {
      void onCorrect(entry, { meetingId: saved.id }).catch((error: unknown) => setCorrectionError(error instanceof Error ? error.message : "Could not attach this note."));
      return;
    }
    setPendingEntryEvent({ entryId: entry.id, eventId: event.id });
    onLog(event);
  }

  function submitFromKeyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || captureBusy) return;
    event.preventDefault();
    void saveCapture(event);
  }

  const searchNeedle = fold(knowledgeQuery.trim());
  const filteredHits = searchNeedle
    ? knowledgeHits.filter((hit) => fold(`${hit.title} ${hit.context} ${hit.text}`).includes(searchNeedle))
    : knowledgeHits.slice(0, 12);
  const draftSuggestions = draft.createdAt
    ? events.filter((event) => !event.allDay && meetingSuggestions({ createdAt: draft.createdAt }, [event]).length > 0)
    : [];
  const inferred = draft.body.trim() ? inferCapture(draft.body, data.people) : null;

  const header = (title: string, subtitle: string, action?: { label: string; click: () => void }) => (
    <header className="ws-page-head">
      <div className="ws-page-copy">
        <p className="ws-eyebrow">To-Do Tracker</p>
        <h1 className="ws-page-title">{title}</h1>
        <p className="ws-page-subtitle">{subtitle}</p>
      </div>
      {action && <button type="button" className="ws-primary" onClick={action.click}><span aria-hidden="true">＋</span>{action.label}</button>}
    </header>
  );

  function renderTaskRow(task: Task, waiting = false) {
    const due = dueText(task, today);
    const taskMeeting = data.meetings.find((meeting) => meeting.id === task.meetingId);
    const source = captures.find((entry) => entry.taskId === task.id);
    const actor = waiting ? data.people.find((person) => person.id === task.requesterId)?.name ?? "Unassigned" : "";
    const active = task.id === selectedTaskId;
    return (
      <article className={`ws-task-row${active ? " is-selected" : ""}`} key={task.id}>
        <button
          type="button"
          className={`ws-task-check${task.status === "in_progress" ? " is-progress" : ""}`}
          aria-label={task.status === "in_progress" ? `Mark ${task.title} complete` : `Complete ${task.title}`}
          onClick={() => onAction(task, { type: "status", status: "done" })}
        ><Icon name="check" /></button>
        <div className="ws-task-copy">
          <button type="button" className="ws-task-title" onClick={() => { setSelectedTaskId(task.id); setTodayFocus({ kind: "task", id: task.id }); }} aria-pressed={active}>{task.title}</button>
          <div className="ws-task-meta">
            {waiting ? <span className="ws-task-person">Waiting on {actor}</span> : <span className="ws-task-person">My task</span>}
            {taskMeeting && <button type="button" className="ws-inline-link" onClick={() => { const key = `meeting:${taskMeeting.id}`; setSelectedMeetingKey(key); setTodayFocus({ kind: "meeting", key }); }}>{taskMeeting.title}</button>}
            {source && <span>Quick capture · {captureTime(source)}</span>}
            {!source && task.sourceLine && <span>{task.sourceLine}</span>}
          </div>
        </div>
        {due && <span className={`ws-due${due.late ? " is-late" : ""}`}>{due.late ? "Overdue · " : "Due "}{due.text}</span>}
      </article>
    );
  }

  function renderTaskGroup(title: string, tasks: Task[], waiting = false) {
    return (
      <section className="ws-task-group" aria-labelledby={`ws-group-${waiting ? "waiting" : "mine"}`}>
        <div className="ws-section-heading">
          <h2 id={`ws-group-${waiting ? "waiting" : "mine"}`}>{title}</h2>
          <span>{tasks.length}</span>
        </div>
        {tasks.length ? <div className="ws-task-list">{tasks.map((task) => renderTaskRow(task, waiting))}</div> : (
          <p className="ws-empty-inline">{waiting ? "Nothing is waiting on someone else." : "You’re clear. No open tasks for today."}</p>
        )}
      </section>
    );
  }

  function renderMeetingLink(meeting: Meeting) {
    const topics = topicLabels(data, meeting.id);
    const decisions = data.decisions.filter((item) => item.meetingId === meeting.id);
    const notes = data.bullets.filter((bullet) => bullet.ownerKind === "meeting" && bullet.ownerId === meeting.id && bullet.kind === "note");
    const linkedTasks = data.tasks.filter((task) => task.meetingId === meeting.id && task.status !== "void");
    return (
      <div className="ws-meeting-context">
        <div className="ws-context-label">Meeting context</div>
        <h3>{meeting.title}</h3>
        <p className="ws-context-meta">{fullDate(meeting.meetingDate)} · {data.people.find((person) => person.id === meeting.personId)?.name ?? "Person not set"}</p>
        {meeting.note.trim() || notes.length ? <div className="ws-context-block"><h4>Discussion</h4><p className="ws-preserve">{meeting.note.trim() || notes.map((item) => item.body).join("\n")}</p></div> : <p className="ws-muted">No notes saved for this meeting.</p>}
        {!!topics.length && <div className="ws-context-block"><h4>Topics</h4><ul>{topics.map((topic, index) => <li key={`${topic}-${index}`}>{topic}</li>)}</ul></div>}
        {!!decisions.length && <div className="ws-context-block"><h4>Decisions</h4><ul>{decisions.map((item) => <li key={item.id}>{item.body}</li>)}</ul></div>}
        <div className="ws-context-block">
          <h4>Linked tasks <span>{linkedTasks.length}</span></h4>
          {linkedTasks.length ? <ul className="ws-link-list">{linkedTasks.slice(0, 6).map((task) => <li key={task.id}><button type="button" onClick={() => { setSelectedTaskId(task.id); onOpenTask(task); }}>{task.title}<span>{task.status === "done" ? "Done" : task.owner === "theirs" ? "Waiting" : "Open"}</span></button></li>)}</ul> : <p className="ws-muted">No tasks linked to this meeting.</p>}
        </div>
        <div className="ws-context-actions">
          <button type="button" className="ws-text-button" onClick={() => { setDraft((current) => ({ ...current, meetingId: meeting.id })); onGoCapture(); }}>Write a quick note</button>
          <button type="button" className="ws-text-button" onClick={() => onOpenMeeting(meeting)}>Open full meeting</button>
        </div>
      </div>
    );
  }

  function renderTaskContext() {
    if (todayFocus.kind === "meeting") {
      const row = meetings.find((item) => item.key === todayFocus.key);
      if (row?.meeting) return renderMeetingLink(row.meeting);
      if (row?.event) return renderCalendarEventContext(row.event);
    }
    if (!currentTask) return (
      <div className="ws-context-empty">
        <div className="ws-context-mark"><Icon name="calendar" /></div>
        <h2>Your day, in context</h2>
        <p>Select a task to see where it came from, or choose a meeting below.</p>
      </div>
    );
    return (
      <div className="ws-task-context">
        <div className="ws-context-label">{currentTask.owner === "theirs" ? "Waiting" : "My task"}</div>
        <h2>{currentTask.title}</h2>
        <div className="ws-context-meta-row">
          <span className={`ws-status${currentTask.status === "in_progress" ? " is-progress" : ""}`}>{currentTask.status === "in_progress" ? "In progress" : "Open"}</span>
          {currentTask.dueOn && <span>{currentTask.dueOn < today ? "Overdue · " : "Due · "}{dateLabel(currentTask.dueOn, today)}</span>}
          {currentTask.owner === "theirs" && <span>Waiting on {data.people.find((person) => person.id === currentTask.requesterId)?.name ?? "Unassigned"}</span>}
        </div>
        <div className="ws-context-block ws-origin-block">
          <h3>Where this came from</h3>
          {taskCapture && <><p className="ws-preserve">{taskCapture.body}</p><p className="ws-context-meta">Quick capture · {captureTime(taskCapture)}</p></>}
          {!taskCapture && currentTask.sourceLine && <p className="ws-preserve">{currentTask.sourceLine}</p>}
          {taskMeeting ? <div className="ws-origin-meeting">{renderMeetingLink(taskMeeting)}</div> : <p className="ws-muted">No meeting is linked to this task.</p>}
        </div>
        <div className="ws-context-actions">
          <button type="button" className="ws-primary ws-small-primary" onClick={() => onOpenTask(currentTask)}>Open task details</button>
          <button type="button" className="ws-text-button" onClick={() => onAction(currentTask, { type: "status", status: "done" })}>Mark complete</button>
        </div>
      </div>
    );
  }

  function renderToday() {
    const todayEvents = meetings.filter((row) => row.event && (row.event.start
      ? new Intl.DateTimeFormat("en-CA").format(new Date(row.event.start)) === today
      : row.event.date.slice(0, 10) === today));
    return <>
      {header("Today", "Your tasks first. Their meeting context stays close by.", { label: "Quick capture", click: onGoCapture })}
      <div className="ws-split ws-today-split">
        <section className="ws-panel ws-task-panel" aria-label="Today's tasks">
          <div className="ws-panel-topline"><span>Today’s work</span><span>{taskRows.mine.length + taskRows.waiting.length} open</span></div>
          {renderTaskGroup("My tasks", taskRows.mine)}
          <div className="ws-separator" />
          {renderTaskGroup("Waiting", taskRows.waiting, true)}
        </section>
        <aside className="ws-panel ws-context-panel" aria-label="Task and meeting context">
          {renderTaskContext()}
          <section className="ws-agenda-section">
            <div className="ws-section-heading"><h2>On your calendar today</h2><button type="button" className="ws-icon-text" onClick={onRefreshAgenda} aria-label="Refresh calendar">Refresh</button></div>
            {agendaError && <p className="ws-inline-error">Calendar did not refresh. {agendaError}</p>}
            {todayEvents.length ? todayEvents.map((row) => {
              const meeting = row.meeting;
              const event = row.event!;
              return (
                <button type="button" className="ws-agenda-row" key={row.key} onClick={() => { setSelectedMeetingKey(row.key); setTodayFocus({ kind: "meeting", key: row.key }); if (!meeting) beginEventContext(event); }}>
                  <span className="ws-agenda-time">{eventTime(event) || "Today"}</span>
                  <span className="ws-agenda-copy"><strong>{meeting?.title ?? event.title}</strong><small>{meeting ? "Saved meeting" : "Calendar event · not yet logged"}</small></span>
                  <Icon name="arrow" />
                </button>
              );
            }) : <p className="ws-empty-inline">No calendar events for today.</p>}
          </section>
        </aside>
      </div>
    </>;
  }

  function renderCaptureEntry(entry: CaptureEntry) {
    const actor = data.people.find((person) => person.id === entry.actorId);
    const savedMeeting = data.meetings.find((meeting) => meeting.id === entry.meetingId);
    const entrySuggestions = events.filter((event) => !event.allDay && meetingSuggestions(entry, [event]).length > 0);
    const attachedSuggestion = entrySuggestions.find((event) => savedMeetingForEvent(data, event)?.id === savedMeeting?.id);
    return (
      <article className={`ws-capture-entry${selectedEntryId === entry.id ? " is-selected" : ""}`} key={entry.id}>
        <time className="ws-entry-time" dateTime={entry.createdAt}>{captureTime(entry)}</time>
        <div className="ws-entry-content">
          <button type="button" className="ws-entry-select" onClick={() => setSelectedEntryId(entry.id)} aria-pressed={selectedEntryId === entry.id}>{entry.body}</button>
          <div className="ws-entry-controls">
            <label className="ws-control-label">Type
              <select aria-label={`Correct type for ${entry.body}`} value={entry.kind} onChange={(event) => void onCorrect(entry, { kind: event.target.value as CaptureKind }).catch((error: unknown) => setCorrectionError(error instanceof Error ? error.message : "Could not update this note."))}>
                <option value="note">Note</option><option value="mine">My task</option><option value="theirs">Waiting</option>
              </select>
            </label>
            {entry.kind === "theirs" && <label className="ws-control-label">Owner
              <select aria-label={`Choose owner for ${entry.body}`} value={entry.actorId} onChange={(event) => void onCorrect(entry, { actorId: event.target.value }).catch((error: unknown) => setCorrectionError(error instanceof Error ? error.message : "Could not update the owner."))}>
                <option value="">Unassigned</option>{data.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </label>}
            <label className="ws-control-label ws-meeting-select">Meeting
              <select aria-label={`Choose meeting for ${entry.body}`} value={entry.meetingId} onChange={(event) => void onCorrect(entry, { meetingId: event.target.value }).catch((error: unknown) => setCorrectionError(error instanceof Error ? error.message : "Could not update the meeting."))}>
                <option value="">No meeting</option>{data.meetings.slice().sort((a, b) => b.meetingDate.localeCompare(a.meetingDate)).map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title} · {dateLabel(meeting.meetingDate, today)}</option>)}
              </select>
            </label>
          </div>
          {actor && entry.kind === "theirs" && <span className="ws-entry-owner">Waiting on {actor.name}</span>}
          {attachedSuggestion && <span className="ws-suggestion-label">Overlapped “{attachedSuggestion.title}”</span>}
          {entrySuggestions.filter((event) => event.id !== attachedSuggestion?.id).map((event) => {
            const matchedMeeting = savedMeetingForEvent(data, event);
            return <button type="button" className="ws-suggestion-link" key={event.id} onClick={() => requestEntryEvent(entry, event)}>{matchedMeeting ? `Also during “${event.title}” · attach` : `This was during “${event.title}” · log to attach`}</button>;
          })}
        </div>
      </article>
    );
  }

  function renderCapture() {
    return <>
      {header("Quick capture", "Write a thought as it happens. Each bullet keeps its original time.")}
      <div className="ws-split ws-capture-split">
        <section className="ws-panel ws-capture-panel" aria-label="Capture a note or task">
          <form onSubmit={(event) => void saveCapture(event)}>
            <div className="ws-capture-heading">
              <div><span className="ws-context-label">New bullet</span><p className="ws-capture-hint">Press Enter to save · Shift + Enter for a line break</p></div>
              {draft.createdAt && <time dateTime={draft.createdAt}>{captureTime({ createdAt: draft.createdAt, timezone: draft.timezone })}</time>}
            </div>
            <label className="ws-sr-only" htmlFor="ws-capture-input">Write one note or task</label>
            <div className="ws-compose-line"><span aria-hidden="true">•</span><textarea
              id="ws-capture-input"
              ref={inputRef}
              value={draft.body}
              onChange={(event) => setDraftText(event.target.value)}
              onKeyDown={submitFromKeyboard}
              placeholder="What do you want to remember?"
              rows={3}
              disabled={captureBusy}
              aria-describedby="ws-capture-helper"
            /></div>
            <div className="ws-compose-bottom">
              <div id="ws-capture-helper" className="ws-inference">
                {inferred ? <><span className={`ws-kind-dot is-${inferred.kind}`} />{captureKindHint(inferred.kind, data.people, inferred.actorId)}</> : "Notes stay notes. Clear commitments are saved as tasks."}
              </div>
              <button type="submit" className="ws-primary" disabled={!draft.body.trim() || captureBusy}>{captureBusy ? "Saving…" : "Save bullet"}</button>
            </div>
            {captureError && <p className="ws-inline-error" role="alert">{captureError}</p>}
            {draftSuggestions.length > 0 && <div className="ws-event-suggestion-list"><strong>Meetings at this time</strong>{draftSuggestions.map((event) => {
              const savedSuggestion = savedMeetingForEvent(data, event);
              return <div className="ws-event-suggestion" key={event.id}><span>{event.title} · {eventTime(event) || fullDate(event.date)}</span>
                {savedSuggestion
                  ? <button type="button" onClick={() => setDraft((current) => ({ ...current, meetingId: savedSuggestion.id }))}>{draft.meetingId === savedSuggestion.id ? "Selected" : "Attach"}</button>
                  : <button type="button" onClick={() => beginEventContext(event)}>Log to attach</button>}
              </div>;
            })}</div>}
            {activeMeeting && <div className="ws-context-selected"><span>New bullets will link to</span><strong>{activeMeeting.title}</strong><button type="button" aria-label="Clear selected meeting" onClick={() => setDraft((current) => ({ ...current, meetingId: "" }))}>Clear</button></div>}
            <label className="ws-context-picker">Attach new bullets to
              <select value={draft.meetingId} onChange={(event) => setDraft((current) => ({ ...current, meetingId: event.target.value }))}>
                <option value="">No meeting selected</option>{data.meetings.slice().sort((a, b) => b.meetingDate.localeCompare(a.meetingDate)).map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title} · {dateLabel(meeting.meetingDate, today)}</option>)}
              </select>
            </label>
          </form>
          <div className="ws-history-head"><div className="ws-section-heading"><h2>Recent bullets</h2><span>{captures.length}</span></div></div>
          {correctionError && <p className="ws-inline-error" role="alert">{correctionError}</p>}
          {captures.length ? <div className="ws-capture-list">{captures.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(renderCaptureEntry)}</div> : <div className="ws-empty-block"><p>Nothing captured yet.</p><span>Your saved notes and inferred tasks will appear here.</span></div>}
        </section>
        <aside className="ws-panel ws-context-panel ws-capture-context">
          {activeMeeting ? renderMeetingLink(activeMeeting) : <div className="ws-context-empty"><div className="ws-context-mark"><Icon name="clock" /></div><h2>Context stays attached</h2><p>Choose a saved meeting above to keep new bullets linked to it. Time overlap only suggests a match; you choose whether to attach.</p></div>}
          {selectedEntry && <section className="ws-selected-entry-context"><div className="ws-context-label">Selected bullet</div><p className="ws-preserve">{selectedEntry.body}</p><span>{entryLabel(selectedEntry.kind)} · {captureTime(selectedEntry)}</span>{selectedEntry.meetingId && data.meetings.find((meeting) => meeting.id === selectedEntry.meetingId) && <button type="button" className="ws-text-button" onClick={() => { setDraft((current) => ({ ...current, meetingId: selectedEntry.meetingId })); const linked = data.meetings.find((meeting) => meeting.id === selectedEntry.meetingId); if (linked) setSelectedMeetingKey(`meeting:${linked.id}`); }}>Use this meeting for new bullets</button>}</section>}
        </aside>
      </div>
    </>;
  }

  function renderCalendarEventContext(event: CalEvent) {
    return <div className="ws-event-context">
      <div className="ws-context-label">Calendar event · not yet logged</div>
      <h2>{event.title}</h2>
      <p className="ws-context-meta">{fullDate(event.start || event.date)}{eventTime(event) ? ` · ${eventTime(event)}` : ""}</p>
      <p className="ws-muted">This event has no saved discussion or tasks yet. Log it to add notes, topics, and follow-ups.</p>
      <div className="ws-context-actions"><button type="button" className="ws-primary ws-small-primary" onClick={() => beginEventContext(event)}>Log meeting to attach notes</button></div>
    </div>;
  }

  function renderMeetings() {
    const selectedMeeting = selectedMeetingRow?.meeting;
    return <>
      {header("Meetings", "A chronological record of conversations, notes, decisions, and follow-ups.", { label: "Log a meeting", click: () => onLog() })}
      <div className="ws-split ws-meetings-split">
        <section className="ws-panel ws-meeting-list-panel">
          <div className="ws-panel-topline"><span>Recent and upcoming</span><span>{meetings.length}</span></div>
          {meetings.length ? meetings.map((row) => {
            const title = row.meeting?.title ?? row.event?.title ?? "Calendar event";
            const date = row.meeting?.meetingDate ?? row.event?.start ?? row.event?.date;
            const key = row.key;
            return <button type="button" className={`ws-meeting-row${selectedMeetingKey === key ? " is-selected" : ""}`} key={key} onClick={() => setSelectedMeetingKey(key)} aria-pressed={selectedMeetingKey === key}>
              <span className="ws-meeting-date">{fullDate(date)}</span><span className="ws-meeting-title">{title}</span><span className="ws-meeting-meta">{row.event ? eventTime(row.event) || "Calendar" : "Saved meeting"}{row.meeting && ` · ${data.people.find((person) => person.id === row.meeting?.personId)?.name ?? "Person not set"}`}</span>
            </button>;
          }) : <div className="ws-empty-block"><p>No meetings yet.</p><span>Log a conversation or connect a calendar feed in Settings.</span></div>}
        </section>
        <aside className="ws-panel ws-context-panel ws-meeting-detail">
          {selectedMeeting ? renderMeetingLink(selectedMeeting) : selectedMeetingRow?.event ? renderCalendarEventContext(selectedMeetingRow.event) : <div className="ws-context-empty"><div className="ws-context-mark"><Icon name="calendar" /></div><h2>Choose a meeting</h2><p>Notes and linked actions appear here when you select a saved conversation.</p></div>}
        </aside>
      </div>
    </>;
  }

  function renderKnowledgeDetail(hit: KnowledgeHit | null) {
    if (!hit) return <div className="ws-context-empty"><div className="ws-context-mark"><Icon name="list" /></div><h2>Knowledge, kept simple</h2><p>Search meeting notes, topics, decisions, tasks, and quick captures. Every result keeps its source.</p></div>;
    const meeting = data.meetings.find((item) => item.id === hit.meetingId);
    const labels = meeting ? topicLabels(data, meeting.id) : [];
    const related = meeting && labels.length ? data.meetings.filter((item) => item.id !== meeting.id && topicLabels(data, item.id).some((label) => labels.some((topic) => fold(topic) === fold(label)))) : [];
    const task = hit.taskId ? data.tasks.find((item) => item.id === hit.taskId) : undefined;
    return <div className="ws-knowledge-detail">
      <div className="ws-context-label">{hit.kind === "meeting" ? "Meeting" : hit.kind === "decision" ? "Decision" : hit.kind === "task" ? "Task" : "Quick capture"}</div>
      <h2>{hit.title}</h2>
      <p className="ws-context-meta">{hit.context}</p>
      {hit.text && <div className="ws-context-block"><h3>Source</h3><p className="ws-preserve">{hit.text}</p></div>}
      {labels.length > 0 && <div className="ws-topic-links"><h3>Topics</h3>{labels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>}
      {meeting && <div className="ws-context-actions"><button type="button" className="ws-primary ws-small-primary" onClick={() => onOpenMeeting(meeting)}>Open meeting</button><button type="button" className="ws-text-button" onClick={() => { setDraft((current) => ({ ...current, meetingId: meeting.id })); onGoCapture(); }}>Add a quick note</button></div>}
      {task && <div className="ws-context-actions"><button type="button" className="ws-primary ws-small-primary" onClick={() => onOpenTask(task)}>Open task</button></div>}
      {!!related.length && <div className="ws-related-meetings"><h3>Related conversations</h3><p>These meetings share an explicit topic label.</p>{related.map((item) => <button type="button" key={item.id} onClick={() => { setKnowledgeSelection({ kind: "meeting", id: item.id }); setSelectedMeetingKey(`meeting:${item.id}`); }}><strong>{item.title}</strong><span>{fullDate(item.meetingDate)} · {topicLabels(data, item.id).filter((label) => labels.some((topic) => fold(topic) === fold(label))).join(", ")}</span></button>)}</div>}
    </div>;
  }

  function renderKnowledge() {
    return <>
      {header("Knowledge", "Find what was discussed and follow the thread back to its meeting.", { label: "Quick capture", click: onGoCapture })}
      <div className="ws-split ws-knowledge-split">
        <section className="ws-panel ws-knowledge-panel" aria-label="Search meeting history">
          <label className="ws-search-box"><span className="ws-search-icon" aria-hidden="true">⌕</span><span className="ws-sr-only">Search notes and meetings</span><input value={knowledgeQuery} onChange={(event) => setKnowledgeQuery(event.target.value)} placeholder="Search notes, topics, decisions…" /></label>
          <p className="ws-search-hint">Searches meeting notes, explicit topic labels, decisions, tasks, and quick captures.</p>
          {filteredHits.length ? <div className="ws-result-list">{filteredHits.map((hit) => <button type="button" key={`${hit.kind}:${hit.id}`} className={`ws-result-row${knowledgeSelection?.kind === hit.kind && knowledgeSelection.id === hit.id ? " is-selected" : ""}`} onClick={() => setKnowledgeSelection({ kind: hit.kind, id: hit.id })} aria-pressed={knowledgeSelection?.kind === hit.kind && knowledgeSelection.id === hit.id}>
            <span className="ws-result-kind">{hit.kind === "meeting" ? "Meeting" : hit.kind === "decision" ? "Decision" : hit.kind === "task" ? "Task" : "Quick capture"}</span><strong>{hit.title}</strong><span className="ws-result-context">{hit.context}</span><p>{excerpt(hit.text || hit.title, knowledgeQuery)}</p>
          </button>)}</div> : <div className="ws-empty-block"><p>{knowledgeQuery.trim() ? "No matching conversations." : "No saved history yet."}</p><span>{knowledgeQuery.trim() ? "Try another word or a shorter phrase." : "As you log meetings and capture notes, they become searchable here."}</span></div>}
        </section>
        <aside className="ws-panel ws-context-panel ws-knowledge-detail">{renderKnowledgeDetail(selectedKnowledgeHit)}</aside>
      </div>
    </>;
  }

  return <div className={`ws-root workspace-page ws-page-${page}`}>
    {page === "today" && renderToday()}
    {page === "capture" && renderCapture()}
    {page === "meetings" && renderMeetings()}
    {page === "knowledge" && renderKnowledge()}
  </div>;
}
