import assert from "node:assert/strict";
import test from "node:test";
import {
  createRetryablePromiseCache,
  deleteMeeting,
  deletePerson,
  loadAll,
  replaceAll,
  restoreRemoved,
  saveMeeting,
  snapshotPersonForRemoval,
  uniqueMeetingTaskInputs,
  type PersonSnapshot,
} from "../src/db.ts";
import { DEFAULT_SETTINGS, type Data, type Meeting, type Person, type Task } from "../src/logic.ts";

type Call = { query: string; values: unknown[] };
type SelectHandler = (query: string, values: unknown[]) => unknown[];

function fakeDatabase(select: SelectHandler = () => []) {
  const calls: Call[] = [];
  return {
    calls,
    async execute(query: string, values: unknown[] = []) {
      calls.push({ query, values });
      return { rowsAffected: 1 };
    },
    async select<T>(query: string, values: unknown[] = []): Promise<T> {
      return select(query, values) as T;
    },
  };
}

function person(id: string, name = id): Person {
  return {
    id,
    name,
    note: "",
    createdAt: "2026-11-01T10:00:00.000Z",
    color: "",
    companyId: null,
    checkInOn: null,
    cadenceDays: null,
  };
}

function meeting(id: string, personId: string): Meeting {
  return {
    id,
    personId,
    title: "Planning",
    meetingDate: "2026-11-06",
    note: "",
    createdAt: "2026-11-06T10:00:00.000Z",
    guestIds: [],
  };
}

function task(id: string, meetingId: string, requesterId: string, title = id): Task {
  return {
    id,
    meetingId,
    requesterId,
    title,
    requestedOn: "2026-11-06",
    dueOn: null,
    status: "open",
    completedAt: null,
    createdAt: "2026-11-06T10:00:00.000Z",
    priority: "none",
    pinned: false,
    evening: false,
    repeatRule: null,
    notes: "",
    movedCount: 0,
    parentId: null,
    remind: false,
    updatedAt: "",
    tagIds: [],
  };
}

function emptyData(overrides: Partial<Data> = {}): Data {
  return {
    people: [],
    companies: [],
    meetings: [],
    tasks: [],
    checks: [],
    tags: [],
    decisions: [],
    activity: [],
    attachments: [],
    templates: [],
    views: [],
    removed: [],
    settings: { ...DEFAULT_SETTINGS },
    bullets: [],
    sections: [],
    lifeDates: [],
    gifts: [],
    asks: [],
    logs: [],
    ...overrides,
  };
}

test("promise cache shares concurrent opens and retries after rejection", async () => {
  const cached = createRetryablePromiseCache<string>();
  let attempts = 0;
  const first = cached(() => {
    attempts += 1;
    return Promise.reject(new Error("temporary open failure"));
  });
  assert.equal(cached(() => Promise.resolve("unexpected")), first);
  await assert.rejects(first, /temporary open failure/);

  const second = cached(() => {
    attempts += 1;
    return Promise.resolve("opened");
  });
  assert.equal(await second, "opened");
  assert.equal(cached(() => Promise.resolve("unexpected")), second);
  assert.equal(attempts, 2);
});

test("same-save task dedup uses requester and normalized title", () => {
  const tasks = [
    { title: "  Send Plan ", requesterId: null, dueOn: null, evening: false, repeatRule: null },
    { title: "send plan", requesterId: "owner", dueOn: null, evening: false, repeatRule: null },
    { title: "Send Plan", requesterId: "another-person", dueOn: null, evening: false, repeatRule: null },
    { title: "  ", requesterId: null, dueOn: null, evening: false, repeatRule: null },
  ];
  const unique = uniqueMeetingTaskInputs(tasks, "owner");
  assert.deepEqual(unique.map((item) => [item.title, item.requesterId]), [
    ["Send Plan", "owner"],
    ["Send Plan", "another-person"],
  ]);
});

test("person snapshot keeps meeting bullets and records safe requester fallbacks", () => {
  const data = emptyData({
    people: [person("removed"), person("host")],
    meetings: [meeting("owned", "removed"), meeting("shared", "host")],
    tasks: [
      task("owned-task", "owned", "removed"),
      task("shared-task", "shared", "removed"),
      task("loose-task", "", "removed"),
    ],
    bullets: [
      { id: "meeting-note", ownerKind: "meeting", ownerId: "owned", kind: "note", body: "Context", indent: 1, position: 1, done: false, folded: true },
      { id: "person-note", ownerKind: "person", ownerId: "removed", kind: "note", body: "Still in its table", indent: 0, position: 1, done: false, folded: false },
    ],
  });

  const snapshot = snapshotPersonForRemoval({
    ...data,
    captureEntries: [
      { id: "capture", body: "Follow up", createdAt: "2026-11-06T10:30:00.000Z", timezone: "UTC", offsetMin: 0, kind: "mine", actorId: "", meetingId: "owned", taskId: "owned-task" },
      { id: "waiting-capture", body: "Removed person will respond", createdAt: "2026-11-06T10:31:00.000Z", timezone: "UTC", offsetMin: 0, kind: "theirs", actorId: "removed", meetingId: "shared", taskId: "shared-task" },
    ],
    meetingSaveReceipts: [
      { saveId: "owned-save", meetingId: "owned", personId: "removed", taskCount: 1, payloadHash: "a".repeat(64) },
      { saveId: "shared-save", meetingId: "shared", personId: "host", taskCount: 1 },
    ],
  }, "removed");
  assert.ok(snapshot);
  assert.deepEqual(snapshot.meetingBullets.map((item) => item.id), ["meeting-note"]);
  assert.deepEqual(snapshot.tasks.map((item) => item.id), ["owned-task"]);
  assert.deepEqual(snapshot.requesterAssignments, [
    { taskId: "loose-task", requesterId: "removed", fallbackRequesterId: "removed" },
  ]);
  assert.deepEqual(snapshot.captureAssignments, [{ captureId: "capture", meetingId: "owned", taskId: "owned-task" }]);
  assert.deepEqual(snapshot.captureActorAssignments, [{ captureId: "waiting-capture", actorId: "removed", taskId: "shared-task", taskRequesterId: "removed" }]);
  assert.deepEqual(snapshot.meetingSaveReceipts, [{ saveId: "owned-save", meetingId: "owned", personId: "removed", taskCount: 1, payloadHash: "a".repeat(64) }]);
});

test("delete person persists the snapshot before removing meetings and changes only known requester links", async () => {
  const people = [
    { id: "removed", name: "Removed", note: "", created_at: "2026-11-01", color: "", company_id: null, check_in_on: null, cadence_days: null, paused: 0, household: "", met_how: "", starred: 0, timezone: "", place: "", event_group: "", promise_on: null, sequential: 0 },
    { id: "host", name: "Host", note: "", created_at: "2026-11-01", color: "", company_id: null, check_in_on: null, cadence_days: null, paused: 0, household: "", met_how: "", starred: 0, timezone: "", place: "", event_group: "", promise_on: null, sequential: 0 },
  ];
  const meetings = [
    { id: "owned", person_id: "removed", title: "Planning", meeting_date: "2026-11-06", note: "", created_at: "2026-11-06", private_note: "", next_on: null, next_focus: "", span_end: null, source_url: "", calendar_uid: "", pinned: 0 },
    { id: "shared", person_id: "host", title: "Planning", meeting_date: "2026-11-06", note: "", created_at: "2026-11-06", private_note: "", next_on: null, next_focus: "", span_end: null, source_url: "", calendar_uid: "", pinned: 0 },
  ];
  const tasks = [
    { id: "owned-task", meeting_id: "owned", requester_id: "removed", title: "Owned task", requested_on: "2026-11-06", due_on: null, status: "open", completed_at: null, created_at: "2026-11-06", priority: "none", pinned: 0, evening: 0, repeat_rule: null, notes: "", moved_count: 0, parent_id: null, remind: 0, updated_at: "", do_on: null, hide_until: null, someday: 0, section_id: null, owner: "mine", clock_time: "", duration_min: 0, remind_time: "", count_done: 0, count_goal: 0, blocked_by: null, span_end: null, source_url: "", indent: 0, wake: "", folded: 0, source_line: "", unfiled: 0, returned: 0, spent_min: 0 },
    { id: "shared-task", meeting_id: "shared", requester_id: "removed", title: "Shared task", requested_on: "2026-11-06", due_on: null, status: "open", completed_at: null, created_at: "2026-11-06", priority: "none", pinned: 0, evening: 0, repeat_rule: null, notes: "", moved_count: 0, parent_id: null, remind: 0, updated_at: "", do_on: null, hide_until: null, someday: 0, section_id: null, owner: "mine", clock_time: "", duration_min: 0, remind_time: "", count_done: 0, count_goal: 0, blocked_by: null, span_end: null, source_url: "", indent: 0, wake: "", folded: 0, source_line: "", unfiled: 0, returned: 0, spent_min: 0 },
    { id: "loose-task", meeting_id: "", requester_id: "removed", title: "Loose task", requested_on: "2026-11-06", due_on: null, status: "open", completed_at: null, created_at: "2026-11-06", priority: "none", pinned: 0, evening: 0, repeat_rule: null, notes: "", moved_count: 0, parent_id: null, remind: 0, updated_at: "", do_on: null, hide_until: null, someday: 0, section_id: null, owner: "mine", clock_time: "", duration_min: 0, remind_time: "", count_done: 0, count_goal: 0, blocked_by: null, span_end: null, source_url: "", indent: 0, wake: "", folded: 0, source_line: "", unfiled: 0, returned: 0, spent_min: 0 },
  ];
  const db = fakeDatabase((query, values) => {
    if (query.includes("FROM people")) return people;
    if (query.includes("FROM meetings")) return meetings;
    if (query.includes("FROM tasks WHERE meeting_id")) return values[0] === "owned" ? [{ id: "owned-task" }] : [];
    if (query.includes("FROM tasks")) return tasks;
    if (query.includes("FROM bullets")) return [{ id: "meeting-note", owner_kind: "meeting", owner_id: "owned", kind: "note", body: "Context", indent: 0, position: 1, done: 0, folded: 0 }];
    return [];
  });

  await deletePerson(db as never, "removed");
  const storedSnapshot = JSON.parse(String(db.calls.find((call) => call.query.startsWith("INSERT INTO removed_people"))?.values[2])) as PersonSnapshot;
  assert.equal(storedSnapshot.meetingBullets[0]?.body, "Context");
  assert.deepEqual(
    storedSnapshot.requesterAssignments.map((item) => item.taskId).sort(),
    ["loose-task", "shared-task"],
  );
  assert.deepEqual(
    db.calls.find((call) => call.query.startsWith("UPDATE tasks SET requester_id"))?.values,
    ["host", "shared-task", "removed"],
  );
  assert.equal(db.calls.filter((call) => call.query.startsWith("UPDATE tasks SET requester_id")).length, 1);
});

test("deleting a Waiting actor shows the capture as unassigned and restores only untouched links", async () => {
  const people = [
    { id: "removed", name: "Removed", note: "", created_at: "2026-11-01", color: "", company_id: null, check_in_on: null, cadence_days: null, paused: 0, household: "", met_how: "", starred: 0, timezone: "", place: "", event_group: "", promise_on: null, sequential: 0 },
    { id: "host", name: "Host", note: "", created_at: "2026-11-01", color: "", company_id: null, check_in_on: null, cadence_days: null, paused: 0, household: "", met_how: "", starred: 0, timezone: "", place: "", event_group: "", promise_on: null, sequential: 0 },
  ];
  const meetings = [
    { id: "owned", person_id: "removed", title: "Planning", meeting_date: "2026-11-06", note: "", created_at: "2026-11-06", private_note: "", next_on: null, next_focus: "", span_end: null, source_url: "", calendar_uid: "", pinned: 0 },
    { id: "shared", person_id: "host", title: "Planning", meeting_date: "2026-11-06", note: "", created_at: "2026-11-06", private_note: "", next_on: null, next_focus: "", span_end: null, source_url: "", calendar_uid: "", pinned: 0 },
  ];
  const capture = { id: "capture", body: "Removed will confirm the plan", created_at: "2026-11-06T10:00:00.000Z", timezone: "UTC", offset_min: 0, kind: "theirs", actor_id: "removed", meeting_id: "shared", task_id: "waiting-task" };
  let storedSnapshot = "";
  const db = fakeDatabase((query, values) => {
    if (query.startsWith("SELECT id FROM people WHERE")) return [];
    if (query.startsWith("SELECT snapshot FROM removed_people")) return [{ snapshot: storedSnapshot }];
    if (query.includes("FROM people")) return people;
    if (query.includes("FROM meetings")) return meetings;
    if (query.includes("SELECT id FROM tasks WHERE meeting_id")) return [];
    if (query.includes("SELECT task_id FROM capture_entries WHERE meeting_id")) return values[0] === "owned" ? [] : [{ task_id: "waiting-task" }];
    if (query.includes("FROM tasks")) return [{ id: "waiting-task", meeting_id: "shared", requester_id: "removed", title: "Confirm the plan", requested_on: "2026-11-06", due_on: null, status: "open", repeat_rule: null }];
    if (query.includes("FROM capture_entries")) return [capture];
    return [];
  });

  await deletePerson(db as never, "removed");
  storedSnapshot = String(db.calls.find((call) => call.query.startsWith("INSERT INTO removed_people"))?.values[2] ?? "");
  const actorSnapshot = JSON.parse(storedSnapshot) as PersonSnapshot;
  assert.deepEqual(actorSnapshot.requesterAssignments, []);
  assert.deepEqual(actorSnapshot.captureActorAssignments, [{ captureId: "capture", actorId: "removed", taskId: "waiting-task", taskRequesterId: "removed" }]);
  assert.deepEqual(
    db.calls.find((call) => call.query.startsWith("UPDATE capture_entries SET actor_id = ''"))?.values,
    ["capture", "removed"],
  );
  assert.deepEqual(
    db.calls.find((call) => call.query.startsWith("UPDATE tasks SET requester_id = ''"))?.values,
    ["waiting-task", "removed"],
  );

  await restoreRemoved(db as never, "removed");
  assert.ok(db.calls.some((call) => call.query.includes("actor_id = '' AND kind = 'theirs'")));
  const taskRestore = db.calls.find((call) => call.query.startsWith("UPDATE tasks SET requester_id = $1 WHERE id = $2 AND requester_id = ''"));
  assert.ok(taskRestore?.query.includes("EXISTS (SELECT 1 FROM capture_entries"));
  assert.deepEqual(taskRestore?.values, ["removed", "waiting-task", "capture"]);
});

test("restore keeps meeting bullets, decision reasons, and guarded requester reassignment", async () => {
  const snapshot: PersonSnapshot = {
    version: 2,
    person: person("removed"),
    meetings: [meeting("owned", "removed")],
    tasks: [task("owned-task", "owned", "removed")],
    checks: [],
    decisions: [{ id: "decision", meetingId: "owned", body: "Use a small pilot", createdAt: "2026-11-06", why: "Lower risk" }],
    attachments: [],
    activity: [],
    meetingBullets: [{ id: "meeting-note", ownerKind: "meeting", ownerId: "owned", kind: "note", body: "Context", indent: 1, position: 1, done: false, folded: true }],
    requesterAssignments: [{ taskId: "shared-task", requesterId: "removed", fallbackRequesterId: "host" }],
    captureAssignments: [{ captureId: "capture", meetingId: "owned", taskId: "owned-task" }],
    meetingSaveReceipts: [{ saveId: "owned-save", meetingId: "owned", personId: "removed", taskCount: 1, payloadHash: "b".repeat(64) }],
  };
  const db = fakeDatabase((query, values) => {
    if (query.startsWith("SELECT snapshot FROM removed_people")) return [{ snapshot: JSON.stringify(snapshot) }];
    if (query === "SELECT id FROM tasks WHERE id = $1" && values[0] === "owned-task") return [{ id: "owned-task" }];
    return [];
  });

  await restoreRemoved(db as never, "removed");
  const decision = db.calls.find((call) => call.query.startsWith("INSERT INTO decisions"));
  assert.ok(decision?.query.includes("created_at, why"));
  assert.equal(decision?.values[4], "Lower risk");
  const bullet = db.calls.find((call) => call.query.startsWith("INSERT INTO bullets"));
  assert.deepEqual(bullet?.values, ["meeting-note", "meeting", "owned", "note", "Context", 1, 1, 0, 1]);
  const assignment = db.calls.find((call) => call.query.startsWith("UPDATE tasks SET requester_id"));
  assert.match(assignment?.query ?? "", /AND requester_id = \$3/);
  assert.deepEqual(assignment?.values, ["removed", "shared-task", "host"]);
  assert.equal(db.calls.some((call) => call.query.startsWith("INSERT INTO tasks")), false, "existing capture task is not duplicated");
  assert.ok(db.calls.some((call) => call.query === "UPDATE tasks SET meeting_id = $1 WHERE id = $2 AND meeting_id = ''"));
  assert.ok(db.calls.some((call) => call.query === "UPDATE capture_entries SET meeting_id = $1 WHERE id = $2 AND meeting_id = ''"));
  assert.deepEqual(db.calls.find((call) => call.query.startsWith("INSERT INTO meeting_save_receipts"))?.values,
    ["owned-save", "owned", "removed", 1, "b".repeat(64)]);
});

test("whole-data replacement writes decision reasons and structured bullets", async () => {
  const data = emptyData({
    decisions: [{ id: "decision", meetingId: "meeting", body: "Use a small pilot", createdAt: "2026-11-06", why: "Lower risk" }],
    bullets: [{ id: "bullet", ownerKind: "meeting", ownerId: "meeting", kind: "note", body: "Context", indent: 0, position: 1, done: false, folded: false }],
  });
  const db = fakeDatabase();

  await replaceAll(db as never, data);
  const decision = db.calls.find((call) => call.query.startsWith("INSERT INTO decisions"));
  assert.ok(decision?.query.includes("created_at, why"));
  assert.equal(decision?.values[4], "Lower risk");
  assert.deepEqual(db.calls.find((call) => call.query.startsWith("INSERT INTO bullets"))?.values,
    ["bullet", "meeting", "meeting", "note", "Context", 0, 1, 0, 0]);
});

test("appending to an existing calendar meeting preserves prior bullets and blank follow-up fields", async () => {
  const people = [{
    id: "host", name: "Host", note: "", created_at: "2026-11-01", color: "", company_id: null,
    check_in_on: null, cadence_days: null, paused: 0, household: "", met_how: "", starred: 0,
    timezone: "", place: "", event_group: "", promise_on: null, sequential: 0,
  }];
  const meetings = [{
    id: "meeting", person_id: "host", title: "Planning", meeting_date: "2026-11-06", note: "Existing note",
    created_at: "2026-11-06", private_note: "Keep this private", next_on: "2026-11-13", next_focus: "Launch review",
    span_end: "2026-11-06T11:00:00", source_url: "", calendar_uid: "series::20261106", pinned: 0,
  }];
  const bullets = [
    { id: "topic-old", owner_kind: "meeting", owner_id: "meeting", kind: "topic", body: "Pricing", indent: 1, position: 1, done: 1, folded: 0 },
    { id: "question-old", owner_kind: "meeting", owner_id: "meeting", kind: "question", body: "Who owns launch?", indent: 0, position: 1, done: 0, folded: 1 },
    { id: "note-old", owner_kind: "meeting", owner_id: "meeting", kind: "note", body: "Context", indent: 1, position: 1, done: 0, folded: 1 },
  ];
  const db = fakeDatabase((query) => {
    if (query.includes("FROM people")) return people;
    if (query.includes("FROM meetings")) return meetings;
    if (query.includes("FROM meeting_people")) return [{ meeting_id: "meeting", person_id: "guest-old" }];
    if (query.includes("FROM bullets")) return bullets;
    return [];
  });

  await saveMeeting(db as never, {
    personId: "host", newPersonName: null, title: "Planning", meetingDate: "2026-11-06", note: "",
    tasks: [], markDoneIds: [], guestIds: ["guest-old", "guest-new", "guest-new", "host"], decisions: [],
    noteLines: [], topics: [{ text: "Media plan", indent: 0 }], questions: [{ text: "When do we ship?", indent: 0 }],
    privateNote: "", nextOn: null, nextFocus: "", spanEnd: null, calendarUid: "series::20261106",
  });

  const guestInserts = db.calls.filter((call) => call.query.startsWith("INSERT INTO meeting_people"));
  assert.deepEqual(guestInserts.map((call) => call.values), [["meeting", "guest-new"]]);
  const topicInserts = db.calls.filter((call) => call.query.startsWith("INSERT INTO bullets") && call.values[3] === "topic");
  assert.deepEqual(topicInserts.map((call) => call.values[4]), ["Pricing", "Media plan"]);
  assert.equal(topicInserts[0]?.values[7], 1, "prior topic done state survives append");
  const questionInserts = db.calls.filter((call) => call.query.startsWith("INSERT INTO bullets") && call.values[3] === "question");
  assert.deepEqual(questionInserts.map((call) => call.values[4]), ["Who owns launch?", "When do we ship?"]);
  assert.equal(questionInserts[0]?.values[8], 1, "prior question folded state survives append");
  const noteInserts = db.calls.filter((call) => call.query.startsWith("INSERT INTO bullets") && call.values[3] === "note");
  assert.deepEqual(noteInserts.map((call) => call.values[4]), ["Context"]);
  const meetingUpdate = db.calls.find((call) => call.query.startsWith("UPDATE meetings SET private_note"));
  assert.deepEqual(meetingUpdate?.values.slice(0, 4), ["Keep this private", "2026-11-13", "Launch review", "2026-11-06T11:00:00"]);
});

test("meeting save receipts make retries idempotent and survive whole-data replacement", async () => {
  const people = [{
    id: "host", name: "Host", note: "", created_at: "2026-11-01", color: "", company_id: null,
    check_in_on: null, cadence_days: null, paused: 0, household: "", met_how: "", starred: 0,
    timezone: "", place: "", event_group: "", promise_on: null, sequential: 0,
  }];
  const input = {
    saveId: "meeting-save-attempt-1", personId: "host", newPersonName: null, title: "Offline discussion",
    meetingDate: "2026-11-06", note: "", tasks: [], markDoneIds: [], guestIds: [], decisions: [],
  };
  const firstDb = fakeDatabase((query) => query.includes("FROM people") ? people : []);
  const first = await saveMeeting(firstDb as never, input);
  assert.equal(first.meetingId.length > 0, true);
  const receiptInsert = firstDb.calls.find((call) => call.query.startsWith("INSERT INTO meeting_save_receipts"));
  const payloadHash = receiptInsert?.values[4];
  assert.match(String(payloadHash), /^[a-f0-9]{64}$/);
  assert.deepEqual(
    receiptInsert?.values,
    ["meeting-save-attempt-1", first.meetingId, "host", 0, payloadHash],
  );

  const retryDb = fakeDatabase((query) => {
    if (query.includes("FROM meeting_save_receipts")) return [{ save_id: "meeting-save-attempt-1", meeting_id: first.meetingId, person_id: "host", task_count: 0, payload_hash: payloadHash }];
    return [];
  });
  const reorderedInput = Object.fromEntries(Object.entries(input).reverse()) as typeof input;
  const retry = await saveMeeting(retryDb as never, reorderedInput);
  assert.deepEqual(retry, { meetingId: first.meetingId, personId: "host", createdPerson: false, taskCount: 0 });
  assert.equal(retryDb.calls.some((call) => /^(INSERT|UPDATE|DELETE)/.test(call.query.trim())), false);

  const replacement = emptyData({ meetingSaveReceipts: [{ saveId: "meeting-save-attempt-1", meetingId: first.meetingId, personId: "host", taskCount: 0, payloadHash: String(payloadHash) }] });
  const replaceDb = fakeDatabase();
  await replaceAll(replaceDb as never, replacement);
  assert.deepEqual(
    replaceDb.calls.find((call) => call.query.startsWith("INSERT INTO meeting_save_receipts"))?.values,
    ["meeting-save-attempt-1", first.meetingId, "host", 0, payloadHash],
  );
});

test("reusing a meeting save ID for changed content rejects without writing", async () => {
  const people = [{
    id: "host", name: "Host", note: "", created_at: "2026-11-01", color: "", company_id: null,
    check_in_on: null, cadence_days: null, paused: 0, household: "", met_how: "", starred: 0,
    timezone: "", place: "", event_group: "", promise_on: null, sequential: 0,
  }];
  const input = {
    saveId: "same-save-id", personId: "host", newPersonName: null, title: "Offline discussion",
    meetingDate: "2026-11-06", note: "Original note", tasks: [], markDoneIds: [], guestIds: [], decisions: [],
  };
  const firstDb = fakeDatabase((query) => query.includes("FROM people") ? people : []);
  const first = await saveMeeting(firstDb as never, input);
  const payloadHash = firstDb.calls.find((call) => call.query.startsWith("INSERT INTO meeting_save_receipts"))?.values[4];
  const retryDb = fakeDatabase((query) => query.includes("FROM meeting_save_receipts") ? [{
    save_id: "same-save-id", meeting_id: first.meetingId, person_id: "host", task_count: 0, payload_hash: payloadHash,
  }] : []);

  await assert.rejects(
    saveMeeting(retryDb as never, { ...input, note: "Edited after the first save" }),
    (error: unknown) => error instanceof Error && "recoveryKind" in error && error.recoveryKind === "payload-mismatch",
  );
  assert.equal(retryDb.calls.some((call) => /^(INSERT|UPDATE|DELETE)/.test(call.query.trim())), false);
});

test("legacy meeting receipts without a hash require an explicit recovery choice", async () => {
  const legacyDb = fakeDatabase((query) => query.includes("FROM meeting_save_receipts") ? [{
    save_id: "legacy-save", meeting_id: "old-meeting", person_id: "host", task_count: 1, payload_hash: null,
  }] : []);
  await assert.rejects(
    saveMeeting(legacyDb as never, {
      saveId: "legacy-save", personId: "host", newPersonName: null, title: "Recovered notes",
      meetingDate: "2026-11-06", note: "Keep these notes", tasks: [], markDoneIds: [], guestIds: [], decisions: [],
    }),
    (error: unknown) => error instanceof Error && "recoveryKind" in error && error.recoveryKind === "unverifiable-receipt",
  );
  assert.equal(legacyDb.calls.some((call) => /^(INSERT|UPDATE|DELETE)/.test(call.query.trim())), false);
});

test("capture entries and monthly repeat anchors survive load and whole-data replacement", async () => {
  const taskRow = {
    id: "capture-task", meeting_id: "meeting", requester_id: "", title: "Pay rent", requested_on: "2026-11-01",
    due_on: "2026-11-30", status: "void", completed_at: null, created_at: "2026-11-01", priority: "none",
    pinned: 0, evening: 0, repeat_rule: "monthly", repeat_anchor_day: 31, notes: "", moved_count: 0,
    parent_id: null, remind: 0, updated_at: "2026-11-01", do_on: null, hide_until: null, someday: 0,
    section_id: null, owner: "mine", clock_time: "", duration_min: 0, remind_time: "", count_done: 0,
    count_goal: 0, blocked_by: null, span_end: null, source_url: "", indent: 0, wake: "", folded: 0,
    source_line: "", unfiled: 0, returned: 0, spent_min: 0,
  };
  const captureRow = {
    id: "capture", body: "Pay rent", created_at: "2026-11-01T12:00:00.000Z", timezone: "America/Sao_Paulo",
    offset_min: -180, kind: "mine", actor_id: "", meeting_id: "meeting", task_id: "capture-task",
  };
  const receiptRow = { save_id: "capture-save", meeting_id: "meeting", person_id: "host", task_count: 1, payload_hash: "c".repeat(64) };
  const db = fakeDatabase((query) => {
    if (query.includes("FROM tasks")) return [taskRow];
    if (query.includes("FROM capture_entries")) return [captureRow];
    if (query.includes("FROM meeting_save_receipts")) return [receiptRow];
    return [];
  });
  const loaded = await loadAll(db as never);
  assert.equal(loaded.tasks[0]?.repeatAnchorDay, 31);
  assert.deepEqual(loaded.captureEntries, [{
    id: "capture", body: "Pay rent", createdAt: "2026-11-01T12:00:00.000Z", timezone: "America/Sao_Paulo",
    offsetMin: -180, kind: "mine", actorId: "", meetingId: "meeting", taskId: "capture-task",
  }]);
  assert.deepEqual(loaded.meetingSaveReceipts, [{ saveId: "capture-save", meetingId: "meeting", personId: "host", taskCount: 1, payloadHash: "c".repeat(64) }]);

  const replacement = emptyData({ tasks: [{ ...task("capture-task", "meeting", "", "Pay rent"), dueOn: "2026-11-30", status: "void", repeatRule: "monthly", repeatAnchorDay: 31 }] });
  const replaceDb = fakeDatabase();
  await replaceAll(replaceDb as never, { ...replacement, captureEntries: loaded.captureEntries, meetingSaveReceipts: loaded.meetingSaveReceipts });
  const taskInsert = replaceDb.calls.find((call) => call.query.startsWith("INSERT INTO tasks"));
  assert.ok(taskInsert?.query.includes("repeat_anchor_day"));
  assert.equal(taskInsert?.values[6], "void");
  assert.equal(taskInsert?.values[13], 31);
  assert.deepEqual(replaceDb.calls.find((call) => call.query.startsWith("INSERT INTO capture_entries"))?.values,
    ["capture", "Pay rent", "2026-11-01T12:00:00.000Z", "America/Sao_Paulo", -180, "mine", "", "meeting", "capture-task"]);
  assert.deepEqual(replaceDb.calls.find((call) => call.query.startsWith("INSERT INTO meeting_save_receipts"))?.values,
    ["capture-save", "meeting", "host", 1, "c".repeat(64)]);
  assert.ok(replaceDb.calls.some((call) => call.query === "DELETE FROM capture_entries"));
  assert.ok(replaceDb.calls.some((call) => call.query === "DELETE FROM meeting_save_receipts"));
});

test("deleting a meeting detaches capture tasks and retains their source entries", async () => {
  const db = fakeDatabase((query) => {
    if (query.includes("SELECT id FROM tasks WHERE meeting_id")) return [{ id: "capture-task" }, { id: "plain-task" }];
    if (query.includes("SELECT task_id FROM capture_entries")) return [{ task_id: "capture-task" }];
    return [];
  });

  await deleteMeeting(db as never, "meeting");
  assert.ok(db.calls.some((call) => call.query.startsWith("UPDATE tasks SET meeting_id = ''")));
  assert.deepEqual(db.calls.find((call) => call.query.startsWith("UPDATE capture_entries SET meeting_id"))?.values, ["meeting"]);
  assert.equal(db.calls.filter((call) => call.query.startsWith("DELETE FROM task_tags")).length, 1);
  assert.equal(db.calls.find((call) => call.query.startsWith("DELETE FROM task_tags"))?.values[0], "plain-task");
  assert.ok(db.calls.some((call) => call.query.startsWith("DELETE FROM tasks WHERE meeting_id")));
  assert.ok(db.calls.some((call) => call.query.startsWith("DELETE FROM meeting_save_receipts WHERE meeting_id")));
});
