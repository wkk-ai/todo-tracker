import type { Database } from "./database";
import { addDays, todayISO, type Data, type Person } from "./logic.ts";

export type CaptureKind = "note" | "mine" | "theirs";
export type CaptureEntry = {
  id: string;
  body: string;
  createdAt: string;
  timezone: string;
  offsetMin: number;
  kind: CaptureKind;
  actorId: string;
  meetingId: string;
  taskId: string;
};

export type MeetingSaveReceipt = {
  saveId: string;
  meetingId: string;
  personId: string;
  taskCount: number;
  /** Older receipts have no hash and cannot prove which draft was saved. */
  payloadHash?: string;
};

type CaptureRow = {
  id: string;
  body: string;
  created_at: string;
  timezone: string;
  offset_min: number;
  kind: string;
  actor_id: string;
  meeting_id: string;
  task_id: string;
};

const folded = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().trim();

function captureKind(value: string): CaptureKind {
  return value === "mine" || value === "theirs" ? value : "note";
}

function fromRow(row: CaptureRow): CaptureEntry {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    timezone: row.timezone,
    offsetMin: Number(row.offset_min),
    kind: captureKind(row.kind),
    actorId: row.actor_id ?? "",
    meetingId: row.meeting_id ?? "",
    taskId: row.task_id ?? "",
  };
}

function sameCapturePayload(row: CaptureRow, entry: Pick<CaptureEntry, "body" | "createdAt" | "timezone" | "offsetMin" | "meetingId">): boolean {
  return row.body === entry.body.trim() &&
    row.created_at === entry.createdAt &&
    row.timezone === entry.timezone &&
    Number(row.offset_min) === entry.offsetMin &&
    (row.meeting_id ?? "") === entry.meetingId;
}

async function validateMeeting(database: Database, meetingId: string): Promise<void> {
  if (!meetingId) return;
  const rows = await database.select<{ id: string }[]>("SELECT id FROM meetings WHERE id = $1", [meetingId]);
  if (!rows.length) throw new Error("That meeting is no longer available. Remove its link and try again.");
}

async function validateActor(database: Database, kind: CaptureKind, actorId: string): Promise<void> {
  if (kind !== "theirs") return;
  if (!actorId) throw new Error("Choose who owns this task, or keep it as a note.");
  const rows = await database.select<{ id: string }[]>("SELECT id FROM people WHERE id = $1", [actorId]);
  if (!rows.length) throw new Error("That person is no longer in your list. Choose someone else or keep this as a note.");
}

/** Conservative local rules: an uncertain commitment remains a note. */
export function inferCapture(body: string, people: Person[]): { kind: CaptureKind; actorId: string } {
  const text = folded(body);
  if (/^(i will\b|i['’]ll\b|todo:|\[ \]|eu vou\b|vou\b|preciso\b|tenho que\b|yo voy a\b|voy a\b|tengo que\b)/.test(text)) return { kind: "mine", actorId: "" };
  const actor = text.match(/^(.+?)\s+(will\b|vai\b|ira\b|va a\b)/)?.[1];
  if (!actor) return { kind: "note", actorId: "" };
  const exact = people.filter((person) => folded(person.name) === actor);
  const matches = exact.length ? exact : people.filter((person) => folded(person.name).split(/\s+/)[0] === actor);
  return matches.length === 1 ? { kind: "theirs", actorId: matches[0].id } : { kind: "note", actorId: "" };
}

export function captureDay(createdAt: string, offsetMin?: number): string {
  return offsetMin === undefined ? todayISO(new Date(createdAt)) : new Date(Date.parse(createdAt) + offsetMin * 60_000).toISOString().slice(0, 10);
}

export function captureDue(body: string, createdAt: string, offsetMin?: number): string | null {
  const day = captureDay(createdAt, offsetMin), text = folded(body);
  if (/\b(tomorrow|amanha|manana)\b/.test(text)) return addDays(day, 1);
  if (/\b(today|hoje|hoy)\b/.test(text)) return day;
  return null;
}

export async function saveCapture(database: Database, entry: Pick<CaptureEntry, "id" | "body" | "createdAt" | "timezone" | "offsetMin" | "meetingId">, data: Data): Promise<CaptureEntry> {
  const found = await database.select<CaptureRow[]>("SELECT id, body, created_at, timezone, offset_min, kind, actor_id, meeting_id, task_id FROM capture_entries WHERE id = $1", [entry.id]);
  if (found.length) {
    if (!sameCapturePayload(found[0], entry)) throw new Error("That capture ID already belongs to different content.");
    return fromRow(found[0]);
  }
  await validateMeeting(database, entry.meetingId);
  const inferred = inferCapture(entry.body, data.people);
  const saved: CaptureEntry = { ...entry, ...inferred, taskId: inferred.kind === "note" ? "" : crypto.randomUUID() };
  await validateActor(database, saved.kind, saved.actorId);
  await database.execute("INSERT INTO capture_entries (id, body, created_at, timezone, offset_min, kind, actor_id, meeting_id, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [saved.id, saved.body.trim(), saved.createdAt, saved.timezone, saved.offsetMin, saved.kind, saved.actorId, saved.meetingId, saved.taskId]);
  if (saved.taskId) await insertCaptureTask(database, saved);
  return saved;
}

async function insertCaptureTask(database: Database, entry: CaptureEntry): Promise<void> {
  await database.execute("INSERT INTO tasks (id, meeting_id, requester_id, title, requested_on, due_on, status, completed_at, created_at, updated_at, owner, source_line, unfiled) VALUES ($1,$2,$3,$4,$5,$6,'open',NULL,$7,$5,$8,$4,0)", [entry.taskId, entry.meetingId, entry.actorId, entry.body.trim(), captureDay(entry.createdAt, entry.offsetMin), captureDue(entry.body, entry.createdAt, entry.offsetMin), entry.createdAt, entry.kind]);
}

/** Correct the interpretation without rewriting the timestamp or original wording. */
export async function correctCapture(database: Database, entry: CaptureEntry, patch: { kind?: CaptureKind; actorId?: string; meetingId?: string }): Promise<void> {
  const rows = await database.select<CaptureRow[]>("SELECT id, body, created_at, timezone, offset_min, kind, actor_id, meeting_id, task_id FROM capture_entries WHERE id = $1", [entry.id]);
  if (!rows.length) throw new Error("That capture is no longer saved. Refresh the page and try again.");
  const changed = { ...fromRow(rows[0]), ...patch };
  if (changed.kind === "mine" || changed.kind === "note") changed.actorId = "";
  await validateMeeting(database, changed.meetingId);
  await validateActor(database, changed.kind, changed.actorId);
  if (changed.taskId) {
    const taskRows = await database.select<{ id: string }[]>("SELECT id FROM tasks WHERE id = $1", [changed.taskId]);
    if (!taskRows.length) changed.taskId = "";
  }
  if (changed.kind !== "note" && !changed.taskId) {
    changed.taskId = crypto.randomUUID();
    await insertCaptureTask(database, changed);
  } else if (changed.kind === "note" && changed.taskId) {
    // Keep the task and its history recoverable; it leaves active lists.
    await database.execute("UPDATE tasks SET status = 'void', updated_at = $1 WHERE id = $2", [todayISO(), changed.taskId]);
  } else if (changed.taskId) {
    await database.execute("UPDATE tasks SET owner = $1, requester_id = $2, meeting_id = $3, status = CASE WHEN status = 'void' THEN 'open' ELSE status END, updated_at = $4 WHERE id = $5", [changed.kind, changed.actorId, changed.meetingId, todayISO(), changed.taskId]);
  }
  await database.execute("UPDATE capture_entries SET kind = $1, actor_id = $2, meeting_id = $3, task_id = $4 WHERE id = $5", [changed.kind, changed.actorId, changed.meetingId, changed.taskId, changed.id]);
}

export function meetingSuggestions(entry: Pick<CaptureEntry, "createdAt">, meetings: { id: string; start?: string; end?: string }[]): string[] {
  const at = Date.parse(entry.createdAt);
  return meetings.filter((meeting) => meeting.start && meeting.end && at >= Date.parse(meeting.start) && at < Date.parse(meeting.end)).map((meeting) => meeting.id);
}
