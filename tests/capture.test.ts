import test from "node:test";
import assert from "node:assert/strict";
import { correctCapture, inferCapture, captureDue, meetingSuggestions, saveCapture, type CaptureEntry } from "../src/capture.ts";
import type { Database } from "../src/database.ts";
import { shortcutList, type Data } from "../src/logic.ts";
const people = [{ id: "a", name: "Avery Cole" }, { id: "b", name: "Sam Lee" }] as any;

type CaptureRow = {
  id: string; body: string; created_at: string; timezone: string; offset_min: number;
  kind: string; actor_id: string; meeting_id: string; task_id: string;
};

function memoryDatabase(options: { captures?: CaptureRow[]; people?: { id: string }[]; meetings?: { id: string }[]; tasks?: { id: string; owner?: string; requester_id?: string; meeting_id?: string; status?: string }[] } = {}) {
  const captures = options.captures ?? [];
  const knownPeople = options.people ?? [];
  const meetings = options.meetings ?? [];
  const tasks = options.tasks ?? [];
  const calls: { query: string; values: unknown[] }[] = [];
  const db: Database = {
    async select<T>(query: string, values: unknown[] = []): Promise<T> {
      const id = String(values[0] ?? "");
      if (query.includes("FROM capture_entries")) return captures.filter((row) => row.id === id) as T;
      if (query.includes("FROM meetings")) return meetings.filter((row) => row.id === id) as T;
      if (query.includes("FROM people")) return knownPeople.filter((row) => row.id === id) as T;
      if (query.includes("FROM tasks")) return tasks.filter((row) => row.id === id) as T;
      return [] as T;
    },
    async execute(query: string, values: unknown[] = []) {
      calls.push({ query, values });
      if (query.startsWith("INSERT INTO capture_entries")) {
        const [id, body, created_at, timezone, offset_min, kind, actor_id, meeting_id, task_id] = values;
        captures.push({ id: String(id), body: String(body), created_at: String(created_at), timezone: String(timezone), offset_min: Number(offset_min), kind: String(kind), actor_id: String(actor_id), meeting_id: String(meeting_id), task_id: String(task_id) });
      } else if (query.startsWith("INSERT INTO tasks")) {
        tasks.push({ id: String(values[0]), meeting_id: String(values[1]), requester_id: String(values[2]), owner: String(values[7]), status: "open" });
      } else if (query.startsWith("UPDATE capture_entries")) {
        const row = captures.find((item) => item.id === values[4]);
        if (row) {
          row.kind = String(values[0]);
          row.actor_id = String(values[1]);
          row.meeting_id = String(values[2]);
          row.task_id = String(values[3]);
        }
      } else if (query.startsWith("UPDATE tasks SET status = 'void'")) {
        const row = tasks.find((item) => item.id === values[1]);
        if (row) row.status = "void";
      } else if (query.startsWith("UPDATE tasks SET owner =")) {
        const row = tasks.find((item) => item.id === values[4]);
        if (row) {
          row.owner = String(values[0]);
          row.requester_id = String(values[1]);
          row.meeting_id = String(values[2]);
          if (row.status === "void") row.status = "open";
        }
      }
      return { rowsAffected: 1 };
    },
  };
  return { db, captures, tasks, calls };
}

test("clear personal actions route to My tasks; another known actor routes to Waiting", () => {
  assert.equal(inferCapture("I will send the outline tomorrow", people).kind, "mine");
  assert.equal(inferCapture("Eu vou enviar amanhã", people).kind, "mine");
  assert.deepEqual(inferCapture("Avery will confirm the plan", people), { kind: "theirs", actorId: "a" });
  assert.equal(inferCapture("A smaller pilot may help", people).kind, "note");
  assert.equal(inferCapture("Unknown person will confirm", people).kind, "note");
  assert.equal(inferCapture("Sam will send", [...people, { id: "s2", name: "Sam Smith" }]).kind, "note");
});

test("capture deadlines use the entry's day and leave unspecified dates empty", () => {
  assert.equal(captureDue("I will send tomorrow", "2026-11-06T12:00:00-03:00"), "2026-11-07");
  assert.equal(captureDue("Vou enviar", "2026-11-06T12:00:00-03:00"), null);
});

test("meeting suggestions use timed overlap and keep multiple candidates", () => {
  const entries = [{ id: "a", start: "2026-11-06T10:00:00-03:00", end: "2026-11-06T10:30:00-03:00" }, { id: "b", start: "2026-11-06T10:10:00-03:00", end: "2026-11-06T11:00:00-03:00" }, { id: "all-day" }];
  assert.deepEqual(meetingSuggestions({ createdAt: "2026-11-06T10:15:00-03:00" }, entries), ["a", "b"]);
  assert.deepEqual(meetingSuggestions({ createdAt: "2026-11-06T11:00:00-03:00" }, entries), []);
});

test("saving the same capture ID and payload twice returns the saved entry without duplicating its task", async () => {
  const store = memoryDatabase();
  const input = {
    id: "capture-1", body: "I will send the outline tomorrow", createdAt: "2026-11-06T12:00:00-03:00",
    timezone: "America/Sao_Paulo", offsetMin: 180, meetingId: "",
  };
  const data = { people: [] } as Data;
  const first = await saveCapture(store.db, input, data);
  const retry = await saveCapture(store.db, input, data);
  assert.equal(retry.id, first.id);
  assert.equal(retry.taskId, first.taskId);
  assert.equal(store.captures.length, 1);
  assert.equal(store.tasks.length, 1);
  await assert.rejects(saveCapture(store.db, { ...input, body: "Different content" }, data), /different content/);
});

test("saving a capture rejects a stale meeting link before creating its task", async () => {
  const store = memoryDatabase();
  const input = {
    id: "capture-stale", body: "I will send the outline", createdAt: "2026-11-06T12:00:00-03:00",
    timezone: "America/Sao_Paulo", offsetMin: 180, meetingId: "deleted-meeting",
  };
  await assert.rejects(saveCapture(store.db, input, { people: [] } as Data), /meeting is no longer available/);
  assert.equal(store.captures.length, 0);
  assert.equal(store.tasks.length, 0);
});

test("a stale correction is applied to the latest saved capture and keeps its existing task link", async () => {
  const current: CaptureRow = {
    id: "capture-2", body: "Avery will share the plan", created_at: "2026-11-06T12:00:00-03:00",
    timezone: "America/Sao_Paulo", offset_min: 180, kind: "theirs", actor_id: "a", meeting_id: "m1", task_id: "task-1",
  };
  const store = memoryDatabase({
    captures: [current],
    people: [{ id: "a" }],
    meetings: [{ id: "m1" }, { id: "m2" }],
    tasks: [{ id: "task-1", owner: "theirs", requester_id: "a", meeting_id: "m1", status: "open" }],
  });
  const stale: CaptureEntry = { ...current, kind: "note", actorId: "", meetingId: "", taskId: "" } as unknown as CaptureEntry;

  await correctCapture(store.db, stale, { meetingId: "m2" });
  assert.equal(store.captures[0].kind, "theirs");
  assert.equal(store.captures[0].actor_id, "a");
  assert.equal(store.captures[0].task_id, "task-1");
  assert.equal(store.captures[0].meeting_id, "m2");
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].meeting_id, "m2");
});

test("corrections reject deleted meetings and unknown task owners", async () => {
  const current: CaptureRow = {
    id: "capture-3", body: "Context", created_at: "2026-11-06T12:00:00-03:00",
    timezone: "America/Sao_Paulo", offset_min: 180, kind: "note", actor_id: "", meeting_id: "", task_id: "",
  };
  const store = memoryDatabase({ captures: [current], people: [{ id: "a" }], meetings: [{ id: "m1" }] });
  const stale = { ...current, createdAt: current.created_at, offsetMin: current.offset_min, actorId: "", meetingId: "", taskId: "" } as unknown as CaptureEntry;

  await assert.rejects(correctCapture(store.db, stale, { meetingId: "deleted" }), /meeting is no longer available/);
  await assert.rejects(correctCapture(store.db, stale, { kind: "theirs", actorId: "deleted-person" }), /no longer in your list/);
  assert.equal(store.calls.some((item) => item.query.startsWith("INSERT INTO tasks")), false);
});

test("shortcut help names quick capture for both local and global shortcuts", () => {
  const shortcuts = Object.fromEntries(shortcutList().map((item) => [item.keys, item.does]));
  assert.match(shortcuts["⌘N"], /Quick capture/);
  assert.match(shortcuts["⌘⇧N"], /Quick capture/);
});
