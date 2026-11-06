import SqlDatabase from "@tauri-apps/plugin-sql";
import type { Database } from "./database.ts";
import type { CaptureEntry, CaptureKind, MeetingSaveReceipt } from "./capture.ts";
import {
  addDays,
  findPersonByName,
  nextDue,
  sortPeople,
  todayISO,
  type Activity,
  type AskLater,
  type Attachment,
  type Bullet,
  type CheckItem,
  type Company,
  type Data,
  type DayLog,
  type Decision,
  type Gift,
  type LifeDate,
  type Meeting,
  type Owner,
  type Person,
  type Priority,
  type RepeatRule,
  type SavedView,
  type Section,
  type Settings,
  type Tag,
  type Task,
  type TaskStatus,
  type Template,
  DEFAULT_SETTINGS,
} from "./logic.ts";

type DataWithCaptures = Data;

type MeetingSaveRecoveryKind = "payload-mismatch" | "unverifiable-receipt";

export class MeetingSaveRecoveryError extends Error {
  readonly recoveryKind: MeetingSaveRecoveryKind;

  constructor(recoveryKind: MeetingSaveRecoveryKind, message: string) {
    super(message);
    this.name = "MeetingSaveRecoveryError";
    this.recoveryKind = recoveryKind;
  }
}

const DATABASE = "sqlite:todo-tracker.db";

type PromiseSlot<T> = { current: Promise<T> | null };

export function createRetryablePromiseCache<T>(): (load: () => Promise<T>) => Promise<T> {
  const slot: PromiseSlot<T> = { current: null };
  return (load) => {
    if (!slot.current) {
      const pending = load().catch((error: unknown) => {
        if (slot.current === pending) slot.current = null;
        throw error;
      });
      slot.current = pending;
    }
    return slot.current;
  };
}

const cachedDatabaseLoad = createRetryablePromiseCache<Database>();

export function openDatabase(): Promise<Database> {
  return cachedDatabaseLoad(() => SqlDatabase.load(DATABASE));
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function bit(value: number | boolean | null | undefined): boolean {
  return value === true || Number(value) === 1;
}

function priorityOf(value: string | null | undefined): Priority {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "none";
}

function repeatOf(value: string | null | undefined): RepeatRule {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  return null;
}

function captureKindOf(value: string | null | undefined): CaptureKind {
  return value === "mine" || value === "theirs" ? value : "note";
}

function repeatAnchor(rule: RepeatRule, dueOn: string | null | undefined, anchorDay?: number | null): number | null {
  if (anchorDay != null && Number.isInteger(anchorDay) && anchorDay >= 1 && anchorDay <= 31) return anchorDay;
  if (rule !== "monthly" || !dueOn) return null;
  const day = Number(dueOn.slice(8, 10));
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

function statusOf(value: string): TaskStatus {
  if (value === "in_progress" || value === "waiting" || value === "done" || value === "set_aside" || value === "void") return value;
  return "open";
}

function ownerOf(value: string | null | undefined): Owner {
  return value === "theirs" ? "theirs" : "mine";
}

function wakeOf(value: string | null | undefined): "" | "open" | "meeting" | "weekday" {
  if (value === "open" || value === "meeting" || value === "weekday") return value;
  return "";
}

type PersonRow = {
  id: string;
  name: string;
  note: string;
  created_at: string;
  color: string;
  company_id: string | null;
  check_in_on: string | null;
  cadence_days: number | null;
  paused: number;
  household: string;
  met_how: string;
  starred: number;
  timezone: string;
  place: string;
  event_group: string;
  promise_on: string | null;
  sequential: number;
};
type MeetingRow = {
  id: string;
  person_id: string;
  title: string;
  meeting_date: string;
  note: string;
  created_at: string;
  private_note: string;
  next_on: string | null;
  next_focus: string;
  span_end: string | null;
  source_url: string;
  calendar_uid: string;
  pinned: number;
};
type TaskRow = {
  id: string;
  meeting_id: string;
  requester_id: string;
  title: string;
  requested_on: string;
  due_on: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
  priority: string;
  pinned: number;
  evening: number;
  repeat_rule: string | null;
  notes: string;
  moved_count: number;
  parent_id: string | null;
  remind: number;
  updated_at: string;
  repeat_anchor_day?: number | null;
  do_on: string | null;
  hide_until: string | null;
  someday: number;
  section_id: string | null;
  owner: string;
  clock_time: string;
  duration_min: number;
  remind_time: string;
  count_done: number;
  count_goal: number;
  blocked_by: string | null;
  span_end: string | null;
  source_url: string;
  indent: number;
  wake: string;
  folded: number;
  source_line: string;
  unfiled: number;
  returned: number;
  spent_min: number;
};

function mapPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.created_at,
    color: row.color ?? "",
    companyId: row.company_id,
    checkInOn: row.check_in_on,
    cadenceDays: row.cadence_days === null || row.cadence_days === undefined ? null : Number(row.cadence_days),
    paused: bit(row.paused),
    household: row.household ?? "",
    metHow: row.met_how ?? "",
    starred: bit(row.starred),
    timezone: row.timezone ?? "",
    place: row.place ?? "",
    eventGroup: row.event_group ?? "",
    promiseOn: row.promise_on,
    sequential: bit(row.sequential),
  };
}

function mapTask(row: TaskRow, tagIds: string[]): Task {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    requesterId: row.requester_id,
    title: row.title,
    requestedOn: row.requested_on,
    dueOn: row.due_on,
    status: statusOf(row.status),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    priority: priorityOf(row.priority),
    pinned: bit(row.pinned),
    evening: bit(row.evening),
    repeatRule: repeatOf(row.repeat_rule),
    repeatAnchorDay: row.repeat_anchor_day == null ? null : Number(row.repeat_anchor_day),
    notes: row.notes ?? "",
    movedCount: Number(row.moved_count ?? 0),
    parentId: row.parent_id,
    remind: bit(row.remind),
    updatedAt: row.updated_at ?? "",
    tagIds,
    doOn: row.do_on,
    hideUntil: row.hide_until,
    someday: bit(row.someday),
    sectionId: row.section_id,
    owner: ownerOf(row.owner),
    clockTime: row.clock_time ?? "",
    durationMin: Number(row.duration_min ?? 0),
    remindTime: row.remind_time ?? "",
    countDone: Number(row.count_done ?? 0),
    countGoal: Number(row.count_goal ?? 0),
    blockedBy: row.blocked_by,
    spanEnd: row.span_end,
    sourceUrl: row.source_url ?? "",
    indent: Number(row.indent ?? 0),
    wake: wakeOf(row.wake),
    folded: bit(row.folded),
    sourceLine: row.source_line ?? "",
    unfiled: bit(row.unfiled),
    returned: bit(row.returned),
    spentMin: Number(row.spent_min ?? 0),
  };
}

function readSettings(rows: { key: string; value: string }[]): Settings {
  const get = (key: string) => rows.find((row) => row.key === key)?.value;
  return {
    theme: get("theme") === "dark" ? "dark" : "light",
    typeSize: get("typeSize") === "large" ? "large" : "normal",
    keepSheetOpen: get("keepSheetOpen") === "1",
    lastPersonId: get("lastPersonId") || null,
    hideFinished: get("hideFinished") === "1",
    morningDate: get("morningDate") || null,
    backupPath: get("backupPath") || "",
    sortClosest: get("sortClosest") === "1",
    awayFrom: get("awayFrom") || null,
    awayUntil: get("awayUntil") || null,
    pingHour: get("pingHour") || "09:00",
    weekHours: Number(get("weekHours") || 0),
    contrast: get("contrast") === "1",
    readyHour: get("readyHour") || "09:00",
    weekdayOnly: get("weekdayOnly") === "1",
    onlyPersonId: get("onlyPersonId") || null,
    googleIcal: get("googleIcal") || "",
  };
}

const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));

export async function loadAll(db: Database): Promise<DataWithCaptures> {
  const [
    people,
    companies,
    meetings,
    guests,
    tasks,
    checks,
    tags,
    taskTags,
    decisions,
    activity,
    attachments,
    templates,
    views,
    removed,
    settings,
    captureEntries,
    meetingSaveReceipts,
  ] = await Promise.all([
    db.select<PersonRow[]>(
      "SELECT id, name, note, created_at, color, company_id, check_in_on, cadence_days, paused, household, met_how, starred, timezone, place, event_group, promise_on, sequential FROM people",
    ),
    db.select<Company[]>("SELECT id, name FROM companies"),
    db.select<MeetingRow[]>(
      "SELECT id, person_id, title, meeting_date, note, created_at, private_note, next_on, next_focus, span_end, source_url, calendar_uid, pinned FROM meetings",
    ),
    db.select<{ meeting_id: string; person_id: string }[]>("SELECT meeting_id, person_id FROM meeting_people"),
    db.select<TaskRow[]>(
      "SELECT id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, priority, pinned, evening, repeat_rule, repeat_anchor_day, notes, moved_count, parent_id, remind, updated_at, do_on, hide_until, someday, section_id, owner, clock_time, duration_min, remind_time, count_done, count_goal, blocked_by, span_end, source_url, indent, wake, folded, source_line, unfiled, returned, spent_min FROM tasks",
    ),
    db.select<{ id: string; task_id: string; title: string; done: number; position: number }[]>(
      "SELECT id, task_id, title, done, position FROM checks",
    ),
    db.select<Tag[]>("SELECT id, name FROM tags"),
    db.select<{ task_id: string; tag_id: string }[]>("SELECT task_id, tag_id FROM task_tags"),
    db.select<{ id: string; meeting_id: string; body: string; created_at: string; why: string }[]>(
      "SELECT id, meeting_id, body, created_at, why FROM decisions",
    ),
    db.select<{ id: string; task_id: string | null; kind: string; detail: string; created_at: string }[]>(
      "SELECT id, task_id, kind, detail, created_at FROM activity",
    ),
    db.select<{ id: string; task_id: string | null; meeting_id: string | null; name: string; path: string; created_at: string }[]>(
      "SELECT id, task_id, meeting_id, name, path, created_at FROM attachments",
    ),
    db.select<{ id: string; name: string; lines: string }[]>("SELECT id, name, lines FROM templates"),
    db.select<{ id: string; name: string; stale: number; tag_id: string | null; person_id: string | null }[]>(
      "SELECT id, name, stale, tag_id, person_id FROM saved_views",
    ),
    db.select<{ id: string; name: string; snapshot: string; removed_at: string }[]>(
      "SELECT id, name, snapshot, removed_at FROM removed_people",
    ),
    db.select<{ key: string; value: string }[]>("SELECT key, value FROM settings"),
    db.select<{ id: string; body: string; created_at: string; timezone: string; offset_min: number; kind: string; actor_id: string; meeting_id: string; task_id: string }[]>(
      "SELECT id, body, created_at, timezone, offset_min, kind, actor_id, meeting_id, task_id FROM capture_entries ORDER BY created_at, id",
    ),
    db.select<{ save_id: string; meeting_id: string; person_id: string; task_count: number; payload_hash: string | null }[]>(
      "SELECT save_id, meeting_id, person_id, task_count, payload_hash FROM meeting_save_receipts ORDER BY save_id",
    ),
  ]);

  const tagsByTask = new Map<string, string[]>();
  for (const link of taskTags) {
    const list = tagsByTask.get(link.task_id) ?? [];
    list.push(link.tag_id);
    tagsByTask.set(link.task_id, list);
  }
  const guestsByMeeting = new Map<string, string[]>();
  for (const link of guests) {
    const list = guestsByMeeting.get(link.meeting_id) ?? [];
    list.push(link.person_id);
    guestsByMeeting.set(link.meeting_id, list);
  }

  const mappedMeetings: Meeting[] = meetings.map((row) => ({
    id: row.id,
    personId: row.person_id,
    title: row.title,
    meetingDate: row.meeting_date,
    note: row.note,
    createdAt: row.created_at,
    guestIds: (guestsByMeeting.get(row.id) ?? []).sort(),
    privateNote: row.private_note ?? "",
    nextOn: row.next_on,
    nextFocus: row.next_focus ?? "",
    spanEnd: row.span_end,
    sourceUrl: row.source_url ?? "",
    calendarUid: row.calendar_uid ?? "",
    pinned: bit(row.pinned),
  }));

  const mappedChecks: CheckItem[] = checks.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    done: bit(row.done),
    position: Number(row.position ?? 0),
  }));
  const mappedDecisions: Decision[] = decisions.map((row) => ({
    id: row.id,
    meetingId: row.meeting_id,
    body: row.body,
    createdAt: row.created_at,
    why: row.why ?? "",
  }));
  const mappedActivity: Activity[] = activity.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    detail: row.detail,
    createdAt: row.created_at,
  }));
  const mappedFiles: Attachment[] = attachments.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    meetingId: row.meeting_id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
  }));
  const mappedTemplates: Template[] = templates.map((row) => {
    let lines: string[] = [];
    try {
      const parsed = JSON.parse(row.lines) as unknown;
      if (Array.isArray(parsed)) lines = parsed.filter((item) => typeof item === "string");
    } catch {
      lines = [];
    }
    return { id: row.id, name: row.name, lines };
  });
  const mappedViews: SavedView[] = views.map((row) => ({
    id: row.id,
    name: row.name,
    stale: bit(row.stale),
    tagId: row.tag_id,
    personId: row.person_id,
  }));

  const [bullets, sections, lifeDates, gifts, asks, logs] = await Promise.all([
    db.select<{ id: string; owner_kind: string; owner_id: string; kind: string; body: string; indent: number; position: number; done: number; folded: number }[]>(
      "SELECT id, owner_kind, owner_id, kind, body, indent, position, done, folded FROM bullets",
    ),
    db.select<{ id: string; person_id: string; name: string; position: number }[]>(
      "SELECT id, person_id, name, position FROM sections",
    ),
    db.select<{ id: string; person_id: string; label: string; on_date: string }[]>(
      "SELECT id, person_id, label, on_date FROM life_dates",
    ),
    db.select<{ id: string; person_id: string; body: string; given: number }[]>("SELECT id, person_id, body, given FROM gifts"),
    db.select<{ id: string; person_id: string; body: string; on_date: string; done: number }[]>(
      "SELECT id, person_id, body, on_date, done FROM asks",
    ),
    db.select<{ id: string; on_date: string; kind: string; body: string }[]>("SELECT id, on_date, kind, body FROM day_logs"),
  ]);

  const mappedBullets: Bullet[] = bullets.map((row) => ({
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    kind: row.kind,
    body: row.body,
    indent: Number(row.indent ?? 0),
    position: Number(row.position ?? 0),
    done: bit(row.done),
    folded: bit(row.folded),
  }));
  const mappedSections: Section[] = sections.map((row) => ({
    id: row.id,
    personId: row.person_id,
    name: row.name,
    position: Number(row.position ?? 0),
  }));
  const mappedDates: LifeDate[] = lifeDates.map((row) => ({
    id: row.id,
    personId: row.person_id,
    label: row.label,
    onDate: row.on_date,
  }));
  const mappedGifts: Gift[] = gifts.map((row) => ({
    id: row.id,
    personId: row.person_id,
    body: row.body,
    given: bit(row.given),
  }));
  const mappedAsks: AskLater[] = asks.map((row) => ({
    id: row.id,
    personId: row.person_id,
    body: row.body,
    onDate: row.on_date,
    done: bit(row.done),
  }));
  const mappedLogs: DayLog[] = logs.map((row) => ({ id: row.id, onDate: row.on_date, kind: row.kind, body: row.body }));

  return {
    people: sortPeople(people.map(mapPerson)),
    companies: byId(companies),
    meetings: byId(mappedMeetings),
    tasks: byId(tasks.map((row) => mapTask(row, (tagsByTask.get(row.id) ?? []).sort()))),
    checks: byId(mappedChecks),
    tags: byId(tags),
    decisions: byId(mappedDecisions),
    activity: byId(mappedActivity),
    attachments: byId(mappedFiles),
    templates: byId(mappedTemplates),
    views: byId(mappedViews),
    removed: byId(
      removed.map((row) => ({ id: row.id, name: row.name, snapshot: row.snapshot, removedAt: row.removed_at })),
    ),
    settings: settings.length ? readSettings(settings) : { ...DEFAULT_SETTINGS },
    bullets: byId(mappedBullets),
    sections: byId(mappedSections),
    lifeDates: byId(mappedDates),
    gifts: byId(mappedGifts),
    asks: byId(mappedAsks),
    logs: byId(mappedLogs),
    captureEntries: captureEntries.map((row): CaptureEntry => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      timezone: row.timezone,
      offsetMin: Number(row.offset_min),
      kind: captureKindOf(row.kind),
      actorId: row.actor_id ?? "",
      meetingId: row.meeting_id ?? "",
      taskId: row.task_id ?? "",
    })),
    meetingSaveReceipts: meetingSaveReceipts.map((row): MeetingSaveReceipt => ({
      saveId: row.save_id,
      meetingId: row.meeting_id,
      personId: row.person_id,
      taskCount: Number(row.task_count ?? 0),
      ...(row.payload_hash ? { payloadHash: row.payload_hash } : {}),
    })),
  };
}

async function log(db: Database, taskId: string | null, kind: string, detail: string): Promise<void> {
  await db.execute("INSERT INTO activity (id, task_id, kind, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [
    uid(),
    taskId,
    kind,
    detail,
    now(),
  ]);
}

export async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export type NewTaskInput = {
  title: string;
  requesterId: string | null;
  dueOn: string | null;
  evening: boolean;
  repeatRule: RepeatRule;
  repeatAnchorDay?: number | null;
  indent?: number;
  owner?: Owner;
  doOn?: string | null;
  durationMin?: number;
  clockTime?: string;
  sourceLine?: string;
};

export type SaveMeetingInput = {
  saveId?: string;
  personId: string | null;
  newPersonName: string | null;
  title: string;
  meetingDate: string;
  note: string;
  tasks: NewTaskInput[];
  markDoneIds: string[];
  guestIds: string[];
  decisions: string[];
  decisionWhys?: string[];
  noteLines?: { text: string; indent: number; folded?: boolean }[];
  topics?: { text: string; indent: number; done?: boolean }[];
  questions?: { text: string; indent: number }[];
  privateNote?: string;
  nextOn?: string | null;
  nextFocus?: string;
  spanEnd?: string | null;
  sourceUrl?: string;
  calendarUid?: string;
};

export type SaveMeetingResult = {
  meetingId: string;
  personId: string;
  createdPerson: boolean;
  taskCount: number;
};

export type UniqueMeetingTaskInput = {
  task: NewTaskInput;
  title: string;
  requesterId: string;
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function meetingPayloadHash(input: SaveMeetingInput): Promise<string> {
  const { saveId: _saveId, ...payload } = input;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableSerialize(payload)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function taskIdentity(requesterId: string, title: string): string {
  return `${requesterId}\u0000${title.trim().toLocaleLowerCase()}`;
}

export function uniqueMeetingTaskInputs(tasks: NewTaskInput[], personId: string): UniqueMeetingTaskInput[] {
  const seen = new Set<string>();
  const unique: UniqueMeetingTaskInput[] = [];
  for (const task of tasks) {
    const title = task.title.trim();
    if (!title) continue;
    const requesterId = task.requesterId && task.requesterId !== personId ? task.requesterId : personId;
    const key = taskIdentity(requesterId, title);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ task, title, requesterId });
  }
  return unique;
}

export async function saveMeeting(db: Database, input: SaveMeetingInput): Promise<SaveMeetingResult> {
  const existing = await loadAll(db);
  const saveId = input.saveId?.trim() ?? "";
  const payloadHash = saveId ? await meetingPayloadHash(input) : "";
  const savedReceipt = saveId ? existing.meetingSaveReceipts?.find((receipt) => receipt.saveId === saveId) : undefined;
  if (savedReceipt) {
    if (!savedReceipt.payloadHash) {
      throw new MeetingSaveRecoveryError(
        "unverifiable-receipt",
        "This save predates content checks, so the original draft cannot be verified. Your draft is safe. Check the meeting for an earlier save, then prepare a new save attempt if you still need to save these changes.",
      );
    }
    if (savedReceipt.payloadHash !== payloadHash) {
      throw new MeetingSaveRecoveryError(
        "payload-mismatch",
        "This save ID was already used for different meeting content. Your edits are still in this draft. Prepare a new save attempt, then retry.",
      );
    }
    return {
      meetingId: savedReceipt.meetingId,
      personId: savedReceipt.personId,
      createdPerson: false,
      taskCount: savedReceipt.taskCount,
    };
  }
  let personId = input.personId;
  let createdPerson = false;
  if (!personId && input.newPersonName) {
    const match = findPersonByName(existing.people, input.newPersonName);
    if (match) personId = match.id;
    else {
      personId = uid();
      createdPerson = true;
      await db.execute("INSERT INTO people (id, name, note, created_at) VALUES ($1, $2, $3, $4)", [
        personId,
        input.newPersonName.trim(),
        "",
        now(),
      ]);
    }
  }
  if (!personId) throw new Error("Choose a person for this meeting.");

  const calendarId = (input.calendarUid ?? "").trim();
  const seriesId = calendarId.includes("::") ? calendarId.slice(0, calendarId.indexOf("::")) : "";
  const prior = calendarId
    ? existing.meetings.find((item) => item.calendarUid === calendarId) ??
      (seriesId
        ? existing.meetings.find((item) => item.calendarUid === seriesId && item.meetingDate === input.meetingDate)
        : undefined)
    : undefined;
  const meetingId = prior?.id ?? uid();
  if (!prior) {
    await db.execute(
      "INSERT INTO meetings (id, person_id, title, meeting_date, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [meetingId, personId, input.title.trim(), input.meetingDate, input.note.trim(), now()],
    );
  }
  const knownGuestIds = new Set(prior?.guestIds ?? []);
  for (const guestId of new Set(input.guestIds)) {
    if (guestId && guestId !== personId && !knownGuestIds.has(guestId)) {
      await db.execute("INSERT INTO meeting_people (meeting_id, person_id) VALUES ($1, $2)", [meetingId, guestId]);
    }
  }
  for (const [index, body] of input.decisions.entries()) {
    const text = body.trim();
    if (!text) continue;
    await db.execute("INSERT INTO decisions (id, meeting_id, body, created_at, why) VALUES ($1, $2, $3, $4, $5)", [
      uid(),
      meetingId,
      text,
      now(),
      (input.decisionWhys ?? [])[index]?.trim() ?? "",
    ]);
  }

  let taskCount = 0;
  const activeTasks = new Map<string, Task>();
  for (const item of existing.tasks) {
    if (item.status === "done" || item.status === "void") continue;
    const key = taskIdentity(item.requesterId, item.title);
    if (!activeTasks.has(key)) activeTasks.set(key, item);
  }
  for (const { task, title, requesterId } of uniqueMeetingTaskInputs(input.tasks, personId)) {
    const same = activeTasks.get(taskIdentity(requesterId, title));
    if (same) {
      await db.execute("UPDATE tasks SET notes = $1, source_line = $2, updated_at = $3 WHERE id = $4", [
        same.notes ? `${same.notes}\nAsked again ${input.meetingDate}` : `Asked again ${input.meetingDate}`,
        title,
        todayISO(),
        same.id,
      ]);
      await log(db, same.id, "merged", "Same ask, kept on the old card");
      continue;
    }
    const id = uid();
    await db.execute(
      "INSERT INTO tasks (id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, priority, pinned, evening, repeat_rule, repeat_anchor_day, notes, moved_count, parent_id, remind, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)",
      [
        id,
        meetingId,
        requesterId,
        title,
        input.meetingDate,
        task.dueOn,
        "open",
        null,
        now(),
        "none",
        0,
        task.evening ? 1 : 0,
        task.repeatRule,
        repeatAnchor(task.repeatRule, task.dueOn, task.repeatAnchorDay),
        "",
        0,
        null,
        0,
        todayISO(),
      ],
    );
    await db.execute(
      "UPDATE tasks SET indent = $1, owner = $2, do_on = $3, duration_min = $4, clock_time = $5, source_line = $6 WHERE id = $7",
      [task.indent ?? 0, task.owner === "theirs" ? "theirs" : "mine", task.doOn ?? null, task.durationMin ?? 0, task.clockTime ?? "", task.sourceLine ?? "", id],
    );
    await log(db, id, "created", "From the meeting");
    taskCount += 1;
  }

  const oldNoteLines = prior
    ? existing.bullets.filter((bullet) => bullet.ownerId === meetingId && bullet.kind === "note")
    : [];
  const oldTopics = prior
    ? existing.bullets.filter((bullet) => bullet.ownerId === meetingId && bullet.kind === "topic")
    : [];
  const oldQuestions = prior
    ? existing.bullets.filter((bullet) => bullet.ownerId === meetingId && bullet.kind === "question")
    : [];
  const noteText = (input.noteLines ?? [])
    .map((line) => `${"  ".repeat(line.indent)}${line.text.trim()}`)
    .filter((line) => line.trim())
    .join("\n");
  const joinedNote = [prior?.note ?? "", noteText].filter((line) => line.trim()).join("\n");
  if (joinedNote) {
    await db.execute("UPDATE meetings SET note = $1 WHERE id = $2", [joinedNote, meetingId]);
  }
  await replaceBullets(
    db,
    "meeting",
    meetingId,
    "note",
    [...oldNoteLines.map((bullet) => ({ text: bullet.body, indent: bullet.indent, done: bullet.done, folded: bullet.folded })), ...(input.noteLines ?? [])],
  );
  await replaceBullets(
    db,
    "meeting",
    meetingId,
    "topic",
    [...oldTopics.map((bullet) => ({ text: bullet.body, indent: bullet.indent, done: bullet.done, folded: bullet.folded })), ...(input.topics ?? [])],
  );
  await replaceBullets(
    db,
    "meeting",
    meetingId,
    "question",
    [...oldQuestions.map((bullet) => ({ text: bullet.body, indent: bullet.indent, done: bullet.done, folded: bullet.folded })), ...(input.questions ?? [])],
  );
  const privateNote = input.privateNote?.trim() ? input.privateNote : prior?.privateNote ?? "";
  const nextOn = input.nextOn?.trim() ? input.nextOn : prior?.nextOn ?? null;
  const nextFocus = input.nextFocus?.trim() ? input.nextFocus : prior?.nextFocus ?? "";
  const spanEnd = input.spanEnd?.trim() ? input.spanEnd : prior?.spanEnd ?? null;
  await db.execute(
    "UPDATE meetings SET private_note = $1, next_on = $2, next_focus = $3, span_end = $4, source_url = $5, calendar_uid = $6 WHERE id = $7",
    [
      privateNote,
      nextOn,
      nextFocus,
      spanEnd,
      input.sourceUrl ?? prior?.sourceUrl ?? "",
      input.calendarUid ?? prior?.calendarUid ?? "",
      meetingId,
    ],
  );
  await db.execute(
    "UPDATE tasks SET hide_until = NULL, wake = '', returned = 1 WHERE wake = 'meeting' AND requester_id = $1",
    [personId],
  );

  const today = todayISO();
  for (const id of input.markDoneIds) {
    await db.execute("UPDATE tasks SET status = $1, completed_at = $2, updated_at = $3 WHERE id = $4 AND status != 'done'", [
      "done",
      today,
      today,
      id,
    ]);
  }

  const cadence = existing.people.find((person) => person.id === personId)?.cadenceDays;
  if (cadence && cadence > 0) {
    await db.execute("UPDATE people SET check_in_on = $1 WHERE id = $2", [addDays(input.meetingDate, cadence), personId]);
  }
  await setSetting(db, "lastPersonId", personId);
  if (saveId) {
    await db.execute(
      "INSERT INTO meeting_save_receipts (save_id, meeting_id, person_id, task_count, payload_hash) VALUES ($1, $2, $3, $4, $5)",
      [saveId, meetingId, personId, taskCount, payloadHash],
    );
  }
  return { meetingId, personId, createdPerson, taskCount };
}

export async function addPerson(db: Database, name: string): Promise<string> {
  const existing = await loadAll(db);
  const match = findPersonByName(existing.people, name);
  if (match) return match.id;
  const id = uid();
  await db.execute("INSERT INTO people (id, name, note, created_at) VALUES ($1, $2, $3, $4)", [id, name.trim(), "", now()]);
  return id;
}

export type PersonPatch = {
  note?: string;
  color?: string;
  companyId?: string | null;
  checkInOn?: string | null;
  cadenceDays?: number | null;
  paused?: boolean;
  household?: string;
  metHow?: string;
  starred?: boolean;
  timezone?: string;
  place?: string;
  eventGroup?: string;
  promiseOn?: string | null;
  sequential?: boolean;
};

export async function updatePerson(db: Database, id: string, fields: PersonPatch): Promise<void> {
  if (fields.note !== undefined) await db.execute("UPDATE people SET note = $1 WHERE id = $2", [fields.note, id]);
  if (fields.color !== undefined) await db.execute("UPDATE people SET color = $1 WHERE id = $2", [fields.color, id]);
  if (fields.companyId !== undefined) await db.execute("UPDATE people SET company_id = $1 WHERE id = $2", [fields.companyId, id]);
  if (fields.checkInOn !== undefined) await db.execute("UPDATE people SET check_in_on = $1 WHERE id = $2", [fields.checkInOn, id]);
  if (fields.cadenceDays !== undefined) {
    await db.execute("UPDATE people SET cadence_days = $1 WHERE id = $2", [fields.cadenceDays, id]);
  }
  if (fields.paused !== undefined) await db.execute("UPDATE people SET paused = $1 WHERE id = $2", [fields.paused ? 1 : 0, id]);
  if (fields.household !== undefined) await db.execute("UPDATE people SET household = $1 WHERE id = $2", [fields.household, id]);
  if (fields.metHow !== undefined) await db.execute("UPDATE people SET met_how = $1 WHERE id = $2", [fields.metHow, id]);
  if (fields.starred !== undefined) await db.execute("UPDATE people SET starred = $1 WHERE id = $2", [fields.starred ? 1 : 0, id]);
  if (fields.timezone !== undefined) await db.execute("UPDATE people SET timezone = $1 WHERE id = $2", [fields.timezone, id]);
  if (fields.place !== undefined) await db.execute("UPDATE people SET place = $1 WHERE id = $2", [fields.place, id]);
  if (fields.eventGroup !== undefined) await db.execute("UPDATE people SET event_group = $1 WHERE id = $2", [fields.eventGroup, id]);
  if (fields.promiseOn !== undefined) await db.execute("UPDATE people SET promise_on = $1 WHERE id = $2", [fields.promiseOn, id]);
  if (fields.sequential !== undefined) await db.execute("UPDATE people SET sequential = $1 WHERE id = $2", [fields.sequential ? 1 : 0, id]);
}

export async function updatePersonNote(db: Database, id: string, note: string): Promise<void> {
  await updatePerson(db, id, { note });
}

export async function addCompany(db: Database, name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Add a company name.");
  const found = await db.select<{ id: string }[]>("SELECT id FROM companies WHERE lower(name) = lower($1)", [trimmed]);
  if (found[0]) return found[0].id;
  const id = uid();
  await db.execute("INSERT INTO companies (id, name) VALUES ($1, $2)", [id, trimmed]);
  return id;
}

export async function updateMeeting(
  db: Database,
  id: string,
  fields: { title?: string; meetingDate?: string; note?: string; pinned?: boolean },
): Promise<void> {
  if (fields.title !== undefined) await db.execute("UPDATE meetings SET title = $1 WHERE id = $2", [fields.title.trim(), id]);
  if (fields.meetingDate !== undefined) {
    const rows = await db.select<{ meeting_date: string }[]>("SELECT meeting_date FROM meetings WHERE id = $1", [id]);
    const previous = rows[0]?.meeting_date;
    await db.execute("UPDATE meetings SET meeting_date = $1 WHERE id = $2", [fields.meetingDate, id]);
    if (previous && previous !== fields.meetingDate) {
      await db.execute("UPDATE tasks SET requested_on = $1 WHERE meeting_id = $2 AND requested_on = $3", [
        fields.meetingDate,
        id,
        previous,
      ]);
    }
  }
  if (fields.note !== undefined) await db.execute("UPDATE meetings SET note = $1 WHERE id = $2", [fields.note, id]);
  if (fields.pinned !== undefined) await db.execute("UPDATE meetings SET pinned = $1 WHERE id = $2", [fields.pinned ? 1 : 0, id]);
}

export async function updateGuests(db: Database, meetingId: string, personIds: string[]): Promise<void> {
  await db.execute("DELETE FROM meeting_people WHERE meeting_id = $1", [meetingId]);
  for (const personId of personIds) {
    await db.execute("INSERT INTO meeting_people (meeting_id, person_id) VALUES ($1, $2)", [meetingId, personId]);
  }
}

export async function addDecision(db: Database, meetingId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) return;
  await db.execute("INSERT INTO decisions (id, meeting_id, body, created_at) VALUES ($1, $2, $3, $4)", [
    uid(),
    meetingId,
    text,
    now(),
  ]);
}

export async function deleteDecision(db: Database, id: string): Promise<void> {
  await db.execute("DELETE FROM decisions WHERE id = $1", [id]);
}

export async function saveTemplate(db: Database, name: string, lines: string[]): Promise<void> {
  const trimmed = name.trim();
  const tasks = lines.map((line) => line.trim()).filter(Boolean);
  if (!trimmed || tasks.length === 0) throw new Error("Add a name and at least one task.");
  await db.execute("INSERT INTO templates (id, name, lines) VALUES ($1, $2, $3)", [uid(), trimmed, JSON.stringify(tasks)]);
}

export async function deleteTemplate(db: Database, id: string): Promise<void> {
  await db.execute("DELETE FROM templates WHERE id = $1", [id]);
}

export async function saveView(
  db: Database,
  name: string,
  filter: { stale: boolean; tagId: string | null; personId: string | null },
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name this view.");
  await db.execute("INSERT INTO saved_views (id, name, stale, tag_id, person_id) VALUES ($1, $2, $3, $4, $5)", [
    uid(),
    trimmed,
    filter.stale ? 1 : 0,
    filter.tagId,
    filter.personId,
  ]);
}

export async function deleteView(db: Database, id: string): Promise<void> {
  await db.execute("DELETE FROM saved_views WHERE id = $1", [id]);
}

export async function updateTaskTitle(db: Database, id: string, title: string): Promise<void> {
  await db.execute("UPDATE tasks SET title = $1, updated_at = $2 WHERE id = $3", [title.trim(), todayISO(), id]);
  await log(db, id, "title", title.trim());
}

export async function updateTaskDue(db: Database, id: string, dueOn: string | null): Promise<void> {
  const rows = await db.select<{ due_on: string | null; repeat_rule?: string | null; repeat_anchor_day?: number | null }[]>(
    "SELECT due_on, repeat_rule, repeat_anchor_day FROM tasks WHERE id = $1",
    [id],
  );
  const current = rows[0];
  const previous = current?.due_on ?? null;
  const moved = previous !== dueOn ? 1 : 0;
  const anchorDay = repeatOf(current?.repeat_rule) === "monthly" && dueOn
    ? repeatAnchor("monthly", dueOn)
    : current?.repeat_anchor_day ?? null;
  await db.execute(
    "UPDATE tasks SET due_on = $1, repeat_anchor_day = $2, updated_at = $3, moved_count = moved_count + $4 WHERE id = $5",
    [dueOn, anchorDay, todayISO(), moved, id],
  );
  if (moved) await log(db, id, "due", dueOn ?? "No date");
}

export async function setTaskStatus(db: Database, id: string, status: TaskStatus): Promise<void> {
  const rows = await db.select<TaskRow[]>(
    "SELECT id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, priority, pinned, evening, repeat_rule, repeat_anchor_day, notes, moved_count, parent_id, remind, updated_at FROM tasks WHERE id = $1",
    [id],
  );
  const current = rows[0];
  if (!current) return;
  if (statusOf(current.status) === status) {
    await db.execute("UPDATE tasks SET updated_at = $1 WHERE id = $2", [todayISO(), id]);
    return;
  }
  const completedAt = status === "done" ? todayISO() : null;
  await db.execute("UPDATE tasks SET status = $1, completed_at = $2, updated_at = $3 WHERE id = $4", [
    status,
    completedAt,
    todayISO(),
    id,
  ]);
  await log(db, id, "status", status);
  const rule = repeatOf(current.repeat_rule);
  if (status === "done" && rule) {
    const newId = uid();
    await db.execute(
      "INSERT INTO tasks (id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, priority, pinned, evening, repeat_rule, repeat_anchor_day, notes, moved_count, parent_id, remind, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)",
      [
        newId,
        current.meeting_id,
        current.requester_id,
        current.title,
        todayISO(),
        nextDue(current.due_on, rule, todayISO(), repeatAnchor(rule, current.due_on, current.repeat_anchor_day)),
        "open",
        null,
        now(),
        current.priority || "none",
        0,
        bit(current.evening) ? 1 : 0,
        rule,
        repeatAnchor(rule, current.due_on, current.repeat_anchor_day),
        current.notes ?? "",
        0,
        current.parent_id,
        bit(current.remind) ? 1 : 0,
        todayISO(),
      ],
    );
    const links = await db.select<{ tag_id: string }[]>("SELECT tag_id FROM task_tags WHERE task_id = $1", [id]);
    for (const link of links) {
      await db.execute("INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)", [newId, link.tag_id]);
    }
    await log(db, newId, "created", "Next repeat");
  }
}

export type TaskPatch = {
  priority?: Priority;
  pinned?: boolean;
  evening?: boolean;
  repeatRule?: RepeatRule;
  notes?: string;
  remind?: boolean;
  tagNames?: string[];
  doOn?: string | null;
  hideUntil?: string | null;
  someday?: boolean;
  sectionId?: string | null;
  owner?: Owner;
  clockTime?: string;
  durationMin?: number;
  remindTime?: string;
  countDone?: number;
  countGoal?: number;
  blockedBy?: string | null;
  spanEnd?: string | null;
  sourceUrl?: string;
  indent?: number;
  wake?: "" | "open" | "meeting" | "weekday";
  returned?: boolean;
  spentMin?: number;
  unfiled?: boolean;
};

async function setTagNames(db: Database, taskId: string, names: string[]): Promise<void> {
  await db.execute("DELETE FROM task_tags WHERE task_id = $1", [taskId]);
  const cleaned = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  for (const name of cleaned) {
    const found = await db.select<{ id: string }[]>("SELECT id FROM tags WHERE lower(name) = lower($1)", [name]);
    let tagId = found[0]?.id;
    if (!tagId) {
      tagId = uid();
      await db.execute("INSERT INTO tags (id, name) VALUES ($1, $2)", [tagId, name]);
    }
    await db.execute("INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)", [taskId, tagId]);
  }
}

export async function patchTask(db: Database, id: string, patch: TaskPatch): Promise<void> {
  if (patch.priority !== undefined) {
    await db.execute("UPDATE tasks SET priority = $1, updated_at = $2 WHERE id = $3", [patch.priority, todayISO(), id]);
  }
  if (patch.pinned !== undefined) {
    await db.execute("UPDATE tasks SET pinned = $1, updated_at = $2 WHERE id = $3", [patch.pinned ? 1 : 0, todayISO(), id]);
  }
  if (patch.evening !== undefined) {
    await db.execute("UPDATE tasks SET evening = $1, updated_at = $2 WHERE id = $3", [patch.evening ? 1 : 0, todayISO(), id]);
  }
  if (patch.repeatRule !== undefined) {
    const rows = await db.select<{ due_on: string | null; repeat_anchor_day: number | null }[]>(
      "SELECT due_on, repeat_anchor_day FROM tasks WHERE id = $1",
      [id],
    );
    const anchorDay = repeatAnchor(patch.repeatRule, rows[0]?.due_on, rows[0]?.repeat_anchor_day);
    await db.execute("UPDATE tasks SET repeat_rule = $1, repeat_anchor_day = $2, updated_at = $3 WHERE id = $4", [
      patch.repeatRule,
      anchorDay,
      todayISO(),
      id,
    ]);
  }
  if (patch.notes !== undefined) {
    await db.execute("UPDATE tasks SET notes = $1, updated_at = $2 WHERE id = $3", [patch.notes, todayISO(), id]);
    await log(db, id, "note", "Note updated");
  }
  if (patch.remind !== undefined) {
    await db.execute("UPDATE tasks SET remind = $1, updated_at = $2 WHERE id = $3", [patch.remind ? 1 : 0, todayISO(), id]);
  }
  if (patch.tagNames !== undefined) await setTagNames(db, id, patch.tagNames);
  const sets: [string, string | number | null][] = [];
  const put = (column: string, value: string | number | null | undefined, present: boolean) => {
    if (present) sets.push([column, value ?? null]);
  };
  put("do_on", patch.doOn ?? null, patch.doOn !== undefined);
  put("hide_until", patch.hideUntil ?? null, patch.hideUntil !== undefined);
  put("someday", patch.someday ? 1 : 0, patch.someday !== undefined);
  put("section_id", patch.sectionId ?? null, patch.sectionId !== undefined);
  put("owner", patch.owner ?? "mine", patch.owner !== undefined);
  put("clock_time", patch.clockTime ?? "", patch.clockTime !== undefined);
  put("duration_min", patch.durationMin ?? 0, patch.durationMin !== undefined);
  put("remind_time", patch.remindTime ?? "", patch.remindTime !== undefined);
  put("count_done", patch.countDone ?? 0, patch.countDone !== undefined);
  put("count_goal", patch.countGoal ?? 0, patch.countGoal !== undefined);
  put("blocked_by", patch.blockedBy ?? null, patch.blockedBy !== undefined);
  put("span_end", patch.spanEnd ?? null, patch.spanEnd !== undefined);
  put("source_url", patch.sourceUrl ?? "", patch.sourceUrl !== undefined);
  put("indent", patch.indent ?? 0, patch.indent !== undefined);
  put("wake", patch.wake ?? "", patch.wake !== undefined);
  put("returned", patch.returned ? 1 : 0, patch.returned !== undefined);
  put("spent_min", patch.spentMin ?? 0, patch.spentMin !== undefined);
  put("unfiled", patch.unfiled ? 1 : 0, patch.unfiled !== undefined);
  for (const [column, value] of sets) {
    await db.execute(`UPDATE tasks SET ${column} = $1, updated_at = $2 WHERE id = $3`, [value, todayISO(), id]);
  }
}

export type TaskAction =
  | { type: "status"; status: TaskStatus }
  | { type: "title"; title: string }
  | { type: "due"; dueOn: string | null }
  | { type: "patch"; patch: TaskPatch }
  | { type: "check-add"; title: string }
  | { type: "check-toggle"; id: string; done: boolean }
  | { type: "check-delete"; id: string }
  | { type: "subtask"; title: string }
  | { type: "attach"; name: string; path: string }
  | { type: "ask"; title: string; personId: string | null }
  | { type: "detach"; id: string };

export async function applyTask(db: Database, taskId: string, action: TaskAction): Promise<void> {
  if (action.type === "status") return setTaskStatus(db, taskId, action.status);
  if (action.type === "title") return updateTaskTitle(db, taskId, action.title);
  if (action.type === "due") return updateTaskDue(db, taskId, action.dueOn);
  if (action.type === "patch") return patchTask(db, taskId, action.patch);
  if (action.type === "check-toggle") {
    await db.execute("UPDATE checks SET done = $1 WHERE id = $2", [action.done ? 1 : 0, action.id]);
    await db.execute("UPDATE tasks SET updated_at = $1 WHERE id = $2", [todayISO(), taskId]);
    return;
  }
  if (action.type === "check-delete") {
    await db.execute("DELETE FROM checks WHERE id = $1", [action.id]);
    return;
  }
  if (action.type === "detach") {
    await db.execute("DELETE FROM attachments WHERE id = $1", [action.id]);
    return;
  }
  if (action.type === "ask") return;
  if (action.type === "attach") {
    await db.execute(
      "INSERT INTO attachments (id, task_id, meeting_id, name, path, created_at) VALUES ($1, $2, NULL, $3, $4, $5)",
      [uid(), taskId, action.name, action.path, now()],
    );
    return;
  }
  const title = action.title.trim();
  if (!title) return;
  if (action.type === "check-add") {
    const rows = await db.select<{ position: number }[]>("SELECT position FROM checks WHERE task_id = $1", [taskId]);
    const position = rows.reduce((max, row) => Math.max(max, Number(row.position)), 0) + 1;
    await db.execute("INSERT INTO checks (id, task_id, title, done, position) VALUES ($1, $2, $3, 0, $4)", [
      uid(),
      taskId,
      title,
      position,
    ]);
    await db.execute("UPDATE tasks SET updated_at = $1 WHERE id = $2", [todayISO(), taskId]);
    return;
  }
  const parents = await db.select<{ meeting_id: string; requester_id: string }[]>(
    "SELECT meeting_id, requester_id FROM tasks WHERE id = $1",
    [taskId],
  );
  const parent = parents[0];
  if (!parent) return;
  const id = uid();
  await db.execute(
    "INSERT INTO tasks (id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, priority, pinned, evening, repeat_rule, repeat_anchor_day, notes, moved_count, parent_id, remind, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)",
    [id, parent.meeting_id, parent.requester_id, title, todayISO(), null, "open", null, now(), "none", 0, 0, null, null, "", 0, taskId, 0, todayISO()],
  );
  await log(db, id, "created", "Subtask");
}

export async function setManyStatus(db: Database, ids: string[], status: TaskStatus): Promise<void> {
  for (const id of ids) await setTaskStatus(db, id, status);
}

export async function setManyDue(db: Database, ids: string[], dueOn: string | null): Promise<void> {
  for (const id of ids) await updateTaskDue(db, id, dueOn);
}

export async function deleteMeeting(db: Database, id: string): Promise<void> {
  const tasks = await db.select<{ id: string }[]>("SELECT id FROM tasks WHERE meeting_id = $1", [id]);
  const captureTasks = await db.select<{ task_id: string }[]>(
    "SELECT task_id FROM capture_entries WHERE meeting_id = $1 AND task_id != ''",
    [id],
  );
  const retainedTaskIds = new Set(captureTasks.map((item) => item.task_id));
  for (const task of tasks) {
    if (retainedTaskIds.has(task.id)) continue;
    await db.execute("DELETE FROM task_tags WHERE task_id = $1", [task.id]);
    await db.execute("DELETE FROM checks WHERE task_id = $1", [task.id]);
    await db.execute("DELETE FROM activity WHERE task_id = $1", [task.id]);
    await db.execute("DELETE FROM attachments WHERE task_id = $1", [task.id]);
  }
  await db.execute(
    "UPDATE tasks SET meeting_id = '' WHERE meeting_id = $1 AND id IN (SELECT task_id FROM capture_entries WHERE meeting_id = $1 AND task_id != '')",
    [id],
  );
  await db.execute(
    "UPDATE attachments SET meeting_id = '' WHERE meeting_id = $1 AND task_id IN (SELECT task_id FROM capture_entries WHERE meeting_id = $1 AND task_id != '')",
    [id],
  );
  await db.execute("DELETE FROM attachments WHERE meeting_id = $1", [id]);
  await db.execute("UPDATE capture_entries SET meeting_id = '' WHERE meeting_id = $1", [id]);
  await db.execute("DELETE FROM decisions WHERE meeting_id = $1", [id]);
  await db.execute("DELETE FROM meeting_save_receipts WHERE meeting_id = $1", [id]);
  await db.execute("DELETE FROM bullets WHERE owner_kind = 'meeting' AND owner_id = $1", [id]);
  await db.execute("DELETE FROM meeting_people WHERE meeting_id = $1", [id]);
  await db.execute("DELETE FROM tasks WHERE meeting_id = $1", [id]);
  await db.execute("DELETE FROM meetings WHERE id = $1", [id]);
}

export type RequesterAssignmentSnapshot = {
  taskId: string;
  requesterId: string;
  fallbackRequesterId: string;
};

export type PersonSnapshot = {
  version: 2;
  person: Person;
  meetings: Meeting[];
  tasks: Task[];
  checks: CheckItem[];
  decisions: Decision[];
  attachments: Attachment[];
  activity: Activity[];
  meetingBullets: Bullet[];
  requesterAssignments: RequesterAssignmentSnapshot[];
  captureAssignments?: { captureId: string; meetingId: string; taskId: string }[];
  captureActorAssignments?: { captureId: string; actorId: string; taskId: string; taskRequesterId: string }[];
  meetingSaveReceipts?: MeetingSaveReceipt[];
};

export function snapshotPersonForRemoval(data: Data, personId: string): PersonSnapshot | null {
  const person = data.people.find((item) => item.id === personId);
  if (!person) return null;
  const meetings = data.meetings.filter((meeting) => meeting.personId === personId);
  const meetingIds = new Set(meetings.map((meeting) => meeting.id));
  const tasks = data.tasks.filter((task) => meetingIds.has(task.meetingId));
  const taskIds = new Set(tasks.map((task) => task.id));
  const hostByMeetingId = new Map(data.meetings.map((meeting) => [meeting.id, meeting.personId]));
  const captureActorEntries = (data.captureEntries ?? []).filter((entry) => entry.kind === "theirs" && entry.actorId === personId);
  const captureActorTaskIds = new Set(captureActorEntries.map((entry) => entry.taskId).filter(Boolean));
  const requesterAssignments = data.tasks
    .filter((task) => task.requesterId === personId && !meetingIds.has(task.meetingId) && !captureActorTaskIds.has(task.id))
    .map((task) => ({
      taskId: task.id,
      requesterId: task.requesterId,
      fallbackRequesterId: hostByMeetingId.get(task.meetingId) ?? task.requesterId,
    }));
  const captureAssignments = (data as DataWithCaptures).captureEntries
    ?.filter((entry) => meetingIds.has(entry.meetingId))
    .map((entry) => ({ captureId: entry.id, meetingId: entry.meetingId, taskId: entry.taskId })) ?? [];
  const taskById = new Map(data.tasks.map((task) => [task.id, task]));
  const captureActorAssignments = captureActorEntries.map((entry) => ({
      captureId: entry.id,
      actorId: entry.actorId,
      taskId: entry.taskId,
      taskRequesterId: taskById.get(entry.taskId)?.requesterId === personId ? personId : "",
    }));
  const meetingSaveReceipts = (data.meetingSaveReceipts ?? []).filter((receipt) => meetingIds.has(receipt.meetingId));

  return {
    version: 2,
    person,
    meetings,
    tasks,
    checks: data.checks.filter((item) => taskIds.has(item.taskId)),
    decisions: data.decisions.filter((item) => meetingIds.has(item.meetingId)),
    attachments: data.attachments.filter((item) => taskIds.has(item.taskId ?? "") || meetingIds.has(item.meetingId ?? "")),
    activity: data.activity.filter((item) => item.taskId !== null && taskIds.has(item.taskId)),
    meetingBullets: data.bullets.filter((item) => item.ownerKind === "meeting" && meetingIds.has(item.ownerId)),
    requesterAssignments,
    captureAssignments,
    captureActorAssignments,
    meetingSaveReceipts,
  };
}

export async function deletePerson(db: Database, personId: string): Promise<void> {
  const all = await loadAll(db);
  const snapshot = snapshotPersonForRemoval(all, personId);
  if (!snapshot) return;
  const { person, meetings } = snapshot;
  await db.execute("INSERT INTO removed_people (id, name, snapshot, removed_at) VALUES ($1, $2, $3, $4)", [
    personId,
    person.name,
    JSON.stringify(snapshot),
    now(),
  ]);
  for (const meeting of meetings) await deleteMeeting(db, meeting.id);
  for (const assignment of snapshot.requesterAssignments) {
    if (assignment.fallbackRequesterId === assignment.requesterId) continue;
    await db.execute(
      "UPDATE tasks SET requester_id = $1 WHERE id = $2 AND requester_id = $3",
      [assignment.fallbackRequesterId, assignment.taskId, assignment.requesterId],
    );
  }
  for (const assignment of snapshot.captureActorAssignments ?? []) {
    await db.execute(
      "UPDATE capture_entries SET actor_id = '' WHERE id = $1 AND actor_id = $2 AND kind = 'theirs'",
      [assignment.captureId, assignment.actorId],
    );
    if (assignment.taskId && assignment.taskRequesterId) {
      await db.execute(
        "UPDATE tasks SET requester_id = '' WHERE id = $1 AND requester_id = $2",
        [assignment.taskId, assignment.taskRequesterId],
      );
    }
  }
  await db.execute("DELETE FROM people WHERE id = $1", [personId]);
}

async function insertPerson(db: Database, person: Person): Promise<void> {
  await db.execute(
    "INSERT INTO people (id, name, note, created_at, color, company_id, check_in_on, cadence_days) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [person.id, person.name, person.note, person.createdAt, person.color, person.companyId, person.checkInOn, person.cadenceDays],
  );
  await db.execute(
    "UPDATE people SET paused=$1, household=$2, met_how=$3, starred=$4, timezone=$5, place=$6, event_group=$7, promise_on=$8, sequential=$9 WHERE id=$10",
    [
      person.paused ? 1 : 0,
      person.household ?? "",
      person.metHow ?? "",
      person.starred ? 1 : 0,
      person.timezone ?? "",
      person.place ?? "",
      person.eventGroup ?? "",
      person.promiseOn ?? null,
      person.sequential ? 1 : 0,
      person.id,
    ],
  );
}

async function insertMeeting(db: Database, meeting: Meeting): Promise<void> {
  await db.execute(
    "INSERT INTO meetings (id, person_id, title, meeting_date, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [meeting.id, meeting.personId, meeting.title, meeting.meetingDate, meeting.note, meeting.createdAt],
  );
  for (const guestId of meeting.guestIds ?? []) {
    await db.execute("INSERT INTO meeting_people (meeting_id, person_id) VALUES ($1, $2)", [meeting.id, guestId]);
  }
  await db.execute(
    "UPDATE meetings SET private_note=$1, next_on=$2, next_focus=$3, span_end=$4, source_url=$5, calendar_uid=$6, pinned=$7 WHERE id=$8",
    [
      meeting.privateNote ?? "",
      meeting.nextOn ?? null,
      meeting.nextFocus ?? "",
      meeting.spanEnd ?? null,
      meeting.sourceUrl ?? "",
      meeting.calendarUid ?? "",
      meeting.pinned ? 1 : 0,
      meeting.id,
    ],
  );
}

async function insertTask(db: Database, task: Task): Promise<void> {
  await db.execute(
    "INSERT INTO tasks (id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, priority, pinned, evening, repeat_rule, repeat_anchor_day, notes, moved_count, parent_id, remind, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)",
    [
      task.id,
      task.meetingId,
      task.requesterId,
      task.title,
      task.requestedOn,
      task.dueOn,
      task.status,
      task.completedAt,
      task.createdAt,
      task.priority,
      task.pinned ? 1 : 0,
      task.evening ? 1 : 0,
      task.repeatRule,
      repeatAnchor(task.repeatRule, task.dueOn, task.repeatAnchorDay),
      task.notes,
      task.movedCount,
      task.parentId,
      task.remind ? 1 : 0,
      task.updatedAt,
    ],
  );
  for (const tagId of task.tagIds ?? []) {
    await db.execute("INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)", [task.id, tagId]);
  }
  await db.execute(
    "UPDATE tasks SET do_on=$1, hide_until=$2, someday=$3, section_id=$4, owner=$5, clock_time=$6, duration_min=$7, remind_time=$8, count_done=$9, count_goal=$10, blocked_by=$11, span_end=$12, source_url=$13, indent=$14, wake=$15, folded=$16, source_line=$17, unfiled=$18, returned=$19, spent_min=$20 WHERE id=$21",
    [
      task.doOn ?? null,
      task.hideUntil ?? null,
      task.someday ? 1 : 0,
      task.sectionId ?? null,
      task.owner === "theirs" ? "theirs" : "mine",
      task.clockTime ?? "",
      task.durationMin ?? 0,
      task.remindTime ?? "",
      task.countDone ?? 0,
      task.countGoal ?? 0,
      task.blockedBy ?? null,
      task.spanEnd ?? null,
      task.sourceUrl ?? "",
      task.indent ?? 0,
      task.wake ?? "",
      task.folded ? 1 : 0,
      task.sourceLine ?? "",
      task.unfiled ? 1 : 0,
      task.returned ? 1 : 0,
      task.spentMin ?? 0,
      task.id,
    ],
  );
}

export async function restoreRemoved(db: Database, id: string): Promise<void> {
  const rows = await db.select<{ snapshot: string }[]>("SELECT snapshot FROM removed_people WHERE id = $1", [id]);
  const raw = rows[0]?.snapshot;
  if (!raw) throw new Error("That person is not in the backup.");
  const snap = JSON.parse(raw) as PersonSnapshot;
  const existing = await db.select<{ id: string }[]>("SELECT id FROM people WHERE id = $1", [snap.person.id]);
  if (existing.length > 0) throw new Error("That person is already here.");
  await insertPerson(db, snap.person);
  for (const meeting of snap.meetings) await insertMeeting(db, meeting);
  const existingTaskIds = new Set<string>();
  for (const task of snap.tasks) {
    const taskExists = await db.select<{ id: string }[]>("SELECT id FROM tasks WHERE id = $1", [task.id]);
    if (taskExists.length) existingTaskIds.add(task.id);
    else await insertTask(db, task);
  }
  for (const check of snap.checks) {
    if (existingTaskIds.has(check.taskId)) continue;
    await db.execute("INSERT INTO checks (id, task_id, title, done, position) VALUES ($1, $2, $3, $4, $5)", [
      check.id,
      check.taskId,
      check.title,
      check.done ? 1 : 0,
      check.position,
    ]);
  }
  for (const decision of snap.decisions) {
    await db.execute("INSERT INTO decisions (id, meeting_id, body, created_at, why) VALUES ($1, $2, $3, $4, $5)", [
      decision.id,
      decision.meetingId,
      decision.body,
      decision.createdAt,
      decision.why ?? "",
    ]);
  }
  for (const bullet of snap.meetingBullets ?? []) {
    await db.execute(
      "INSERT INTO bullets (id, owner_kind, owner_id, kind, body, indent, position, done, folded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [bullet.id, bullet.ownerKind, bullet.ownerId, bullet.kind, bullet.body, bullet.indent, bullet.position, bullet.done ? 1 : 0, bullet.folded ? 1 : 0],
    );
  }
  for (const file of snap.attachments) {
    if (file.taskId && existingTaskIds.has(file.taskId)) continue;
    await db.execute(
      "INSERT INTO attachments (id, task_id, meeting_id, name, path, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [file.id, file.taskId, file.meetingId, file.name, file.path, file.createdAt],
    );
  }
  for (const item of snap.activity) {
    if (item.taskId && existingTaskIds.has(item.taskId)) continue;
    await db.execute("INSERT INTO activity (id, task_id, kind, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [
      item.id,
      item.taskId,
      item.kind,
      item.detail,
      item.createdAt,
    ]);
  }
  for (const assignment of snap.captureAssignments ?? []) {
    if (assignment.taskId) {
      await db.execute("UPDATE tasks SET meeting_id = $1 WHERE id = $2 AND meeting_id = ''", [assignment.meetingId, assignment.taskId]);
    }
    await db.execute("UPDATE capture_entries SET meeting_id = $1 WHERE id = $2 AND meeting_id = ''", [
      assignment.meetingId,
      assignment.captureId,
    ]);
  }
  for (const assignment of snap.captureActorAssignments ?? []) {
    await db.execute(
      "UPDATE capture_entries SET actor_id = $1 WHERE id = $2 AND actor_id = '' AND kind = 'theirs'",
      [assignment.actorId, assignment.captureId],
    );
    if (assignment.taskId && assignment.taskRequesterId) {
      await db.execute(
        "UPDATE tasks SET requester_id = $1 WHERE id = $2 AND requester_id = '' AND EXISTS (SELECT 1 FROM capture_entries WHERE id = $3 AND actor_id = '' AND kind = 'theirs')",
        [assignment.taskRequesterId, assignment.taskId, assignment.captureId],
      );
    }
  }
  for (const receipt of snap.meetingSaveReceipts ?? []) {
    await db.execute(
      "INSERT INTO meeting_save_receipts (save_id, meeting_id, person_id, task_count, payload_hash) VALUES ($1, $2, $3, $4, $5)",
      [receipt.saveId, receipt.meetingId, receipt.personId, receipt.taskCount, receipt.payloadHash ?? null],
    );
  }
  for (const assignment of snap.requesterAssignments ?? []) {
    if (assignment.requesterId === assignment.fallbackRequesterId) continue;
    await db.execute(
      "UPDATE tasks SET requester_id = $1 WHERE id = $2 AND requester_id = $3",
      [assignment.requesterId, assignment.taskId, assignment.fallbackRequesterId],
    );
  }
  await db.execute("DELETE FROM removed_people WHERE id = $1", [id]);
}

async function clearAll(db: Database): Promise<void> {
  const tables = [
    "meeting_save_receipts",
    "capture_entries",
    "task_tags",
    "checks",
    "activity",
    "attachments",
    "decisions",
    "meeting_people",
    "tasks",
    "meetings",
    "people",
    "companies",
    "tags",
    "templates",
    "saved_views",
    "removed_people",
    "settings",
    "bullets",
    "sections",
    "life_dates",
    "gifts",
    "asks",
    "day_logs",
  ];
  for (const table of tables) await db.execute(`DELETE FROM ${table}`);
}

export async function replaceAll(db: Database, data: DataWithCaptures): Promise<void> {
  await clearAll(db);
  for (const company of data.companies) {
    await db.execute("INSERT INTO companies (id, name) VALUES ($1, $2)", [company.id, company.name]);
  }
  for (const tag of data.tags) await db.execute("INSERT INTO tags (id, name) VALUES ($1, $2)", [tag.id, tag.name]);
  for (const person of data.people) await insertPerson(db, person);
  for (const meeting of data.meetings) await insertMeeting(db, meeting);
  for (const task of data.tasks) await insertTask(db, task);
  for (const check of data.checks) {
    await db.execute("INSERT INTO checks (id, task_id, title, done, position) VALUES ($1, $2, $3, $4, $5)", [
      check.id,
      check.taskId,
      check.title,
      check.done ? 1 : 0,
      check.position,
    ]);
  }
  for (const decision of data.decisions) {
    await db.execute("INSERT INTO decisions (id, meeting_id, body, created_at, why) VALUES ($1, $2, $3, $4, $5)", [
      decision.id,
      decision.meetingId,
      decision.body,
      decision.createdAt,
      decision.why ?? "",
    ]);
  }
  for (const file of data.attachments) {
    await db.execute(
      "INSERT INTO attachments (id, task_id, meeting_id, name, path, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [file.id, file.taskId, file.meetingId, file.name, file.path, file.createdAt],
    );
  }
  for (const item of data.activity) {
    await db.execute("INSERT INTO activity (id, task_id, kind, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [
      item.id,
      item.taskId,
      item.kind,
      item.detail,
      item.createdAt,
    ]);
  }
  for (const template of data.templates) {
    await db.execute("INSERT INTO templates (id, name, lines) VALUES ($1, $2, $3)", [
      template.id,
      template.name,
      JSON.stringify(template.lines),
    ]);
  }
  for (const view of data.views) {
    await db.execute("INSERT INTO saved_views (id, name, stale, tag_id, person_id) VALUES ($1, $2, $3, $4, $5)", [
      view.id,
      view.name,
      view.stale ? 1 : 0,
      view.tagId,
      view.personId,
    ]);
  }
  for (const removed of data.removed) {
    await db.execute("INSERT INTO removed_people (id, name, snapshot, removed_at) VALUES ($1, $2, $3, $4)", [
      removed.id,
      removed.name,
      removed.snapshot,
      removed.removedAt,
    ]);
  }
  const settings: [string, string][] = [
    ["theme", data.settings.theme],
    ["typeSize", data.settings.typeSize],
    ["keepSheetOpen", data.settings.keepSheetOpen ? "1" : "0"],
    ["lastPersonId", data.settings.lastPersonId ?? ""],
    ["hideFinished", data.settings.hideFinished ? "1" : "0"],
    ["morningDate", data.settings.morningDate ?? ""],
    ["backupPath", data.settings.backupPath],
    ["sortClosest", data.settings.sortClosest ? "1" : "0"],
    ["awayFrom", data.settings.awayFrom ?? ""],
    ["awayUntil", data.settings.awayUntil ?? ""],
    ["pingHour", data.settings.pingHour],
    ["weekHours", String(data.settings.weekHours || "")],
    ["contrast", data.settings.contrast ? "1" : "0"],
    ["readyHour", data.settings.readyHour],
    ["weekdayOnly", data.settings.weekdayOnly ? "1" : "0"],
    ["onlyPersonId", data.settings.onlyPersonId ?? ""],
    ["googleIcal", data.settings.googleIcal ?? ""],
  ];
  for (const bullet of data.bullets ?? []) {
    await db.execute(
      "INSERT INTO bullets (id, owner_kind, owner_id, kind, body, indent, position, done, folded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [bullet.id, bullet.ownerKind, bullet.ownerId, bullet.kind, bullet.body, bullet.indent, bullet.position, bullet.done ? 1 : 0, bullet.folded ? 1 : 0],
    );
  }
  for (const section of data.sections ?? []) {
    await db.execute("INSERT INTO sections (id, person_id, name, position) VALUES ($1, $2, $3, $4)", [
      section.id,
      section.personId,
      section.name,
      section.position,
    ]);
  }
  for (const item of data.lifeDates ?? []) {
    await db.execute("INSERT INTO life_dates (id, person_id, label, on_date) VALUES ($1, $2, $3, $4)", [
      item.id,
      item.personId,
      item.label,
      item.onDate,
    ]);
  }
  for (const gift of data.gifts ?? []) {
    await db.execute("INSERT INTO gifts (id, person_id, body, given) VALUES ($1, $2, $3, $4)", [
      gift.id,
      gift.personId,
      gift.body,
      gift.given ? 1 : 0,
    ]);
  }
  for (const ask of data.asks ?? []) {
    await db.execute("INSERT INTO asks (id, person_id, body, on_date, done) VALUES ($1, $2, $3, $4, $5)", [
      ask.id,
      ask.personId,
      ask.body,
      ask.onDate,
      ask.done ? 1 : 0,
    ]);
  }
  for (const log of data.logs ?? []) {
    await db.execute("INSERT INTO day_logs (id, on_date, kind, body) VALUES ($1, $2, $3, $4)", [log.id, log.onDate, log.kind, log.body]);
  }
  for (const entry of data.captureEntries ?? []) {
    await db.execute(
      "INSERT INTO capture_entries (id, body, created_at, timezone, offset_min, kind, actor_id, meeting_id, task_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [entry.id, entry.body, entry.createdAt, entry.timezone, entry.offsetMin, entry.kind, entry.actorId, entry.meetingId, entry.taskId],
    );
  }
  for (const receipt of data.meetingSaveReceipts ?? []) {
    await db.execute(
      "INSERT INTO meeting_save_receipts (save_id, meeting_id, person_id, task_count, payload_hash) VALUES ($1, $2, $3, $4, $5)",
      [receipt.saveId, receipt.meetingId, receipt.personId, receipt.taskCount, receipt.payloadHash ?? null],
    );
  }
  for (const [key, value] of settings) {
    await setSetting(db, key, value);
  }
}

export async function replaceBullets(
  db: Database,
  ownerKind: string,
  ownerId: string,
  kind: string,
  lines: { text: string; indent: number; done?: boolean; folded?: boolean }[],
): Promise<void> {
  await db.execute("DELETE FROM bullets WHERE owner_kind = $1 AND owner_id = $2 AND kind = $3", [ownerKind, ownerId, kind]);
  let position = 0;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    position += 1;
    await db.execute(
      "INSERT INTO bullets (id, owner_kind, owner_id, kind, body, indent, position, done, folded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [uid(), ownerKind, ownerId, kind, text, line.indent, position, line.done ? 1 : 0, line.folded ? 1 : 0],
    );
  }
}

export async function addLooseTask(db: Database, personId: string | null, title: string, note: string): Promise<void> {
  const text = title.trim();
  if (!text) return;
  const id = uid();
  await db.execute(
    "INSERT INTO tasks (id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, priority, pinned, evening, repeat_rule, notes, moved_count, parent_id, remind, updated_at, unfiled) VALUES ($1, $2, $3, $4, $5, NULL, 'open', NULL, $6, 'none', 0, 0, NULL, $7, 0, NULL, 0, $8, $9)",
    [id, "", personId ?? "", text, todayISO(), now(), note, todayISO(), personId ? 0 : 1],
  );
}

export async function addSection(db: Database, personId: string, name: string): Promise<void> {
  const text = name.trim();
  if (!text) return;
  await db.execute("INSERT INTO sections (id, person_id, name, position) VALUES ($1, $2, $3, $4)", [uid(), personId, text, Date.now()]);
}

export async function addLifeDate(db: Database, personId: string, label: string, onDate: string): Promise<void> {
  if (!label.trim() || !onDate) return;
  await db.execute("INSERT INTO life_dates (id, person_id, label, on_date) VALUES ($1, $2, $3, $4)", [uid(), personId, label.trim(), onDate]);
}

export async function addGift(db: Database, personId: string, body: string): Promise<void> {
  if (!body.trim()) return;
  await db.execute("INSERT INTO gifts (id, person_id, body, given) VALUES ($1, $2, $3, 0)", [uid(), personId, body.trim()]);
}

export async function toggleGift(db: Database, id: string, given: boolean): Promise<void> {
  await db.execute("UPDATE gifts SET given = $1 WHERE id = $2", [given ? 1 : 0, id]);
}

export async function addAsk(db: Database, personId: string, body: string, onDate: string): Promise<void> {
  if (!body.trim() || !onDate) return;
  await db.execute("INSERT INTO asks (id, person_id, body, on_date, done) VALUES ($1, $2, $3, $4, 0)", [uid(), personId, body.trim(), onDate]);
}

export async function toggleAsk(db: Database, id: string, done: boolean): Promise<void> {
  await db.execute("UPDATE asks SET done = $1 WHERE id = $2", [done ? 1 : 0, id]);
}

export async function addDayLog(db: Database, onDate: string, kind: string, body: string): Promise<void> {
  if (!body.trim()) return;
  await db.execute("INSERT INTO day_logs (id, on_date, kind, body) VALUES ($1, $2, $3, $4)", [uid(), onDate, kind, body.trim()]);
}

export async function deleteDayLog(db: Database, id: string): Promise<void> {
  await db.execute("DELETE FROM day_logs WHERE id = $1", [id]);
}
