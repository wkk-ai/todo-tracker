import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  bucketFor,
  boardCsv,
  DEFAULT_SETTINGS,
  duePresets,
  fridayThisWeek,
  isOnBoard,
  endOfWeek,
  agendaFromIcs,
  calendarEventMatches,
  fullestDayLine,
  groupOpen,
  lastMetMeeting,
  medianWait,
  meetingsForPerson,
  nextMeeting,
  nextMonday,
  nextSevenDays,
  nextDue,
  oldestOpen,
  openByPerson,
  openTasksForPerson,
  readDateInTitle,
  savedLine,
  searchAll,
  startOfWeek,
  tasksForHome,
  tasksForMeeting,
  waitingLine,
  weekFlow,
  weekTotals,
  type Data,
  type Meeting,
  type Person,
  type Task,
} from "../src/logic.ts";

const sunday = "2026-11-01";

function person(id: string, name: string): Person {
  return {
    id,
    name,
    note: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    color: "",
    companyId: null,
    checkInOn: null,
    cadenceDays: null,
  };
}

function meeting(partial: Partial<Meeting> & Pick<Meeting, "id" | "personId">): Meeting {
  return {
    title: "Review",
    meetingDate: sunday,
    note: "",
    createdAt: "2026-11-01T00:00:00.000Z",
    guestIds: [],
    ...partial,
  };
}

function task(partial: Partial<Task> & Pick<Task, "id">): Task {
  return {
    meetingId: "m1",
    requesterId: "mic",
    title: "Send the notes",
    requestedOn: "2026-10-20",
    dueOn: sunday,
    status: "open",
    completedAt: null,
    createdAt: "2026-10-20T00:00:00.000Z",
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
    ...partial,
  };
}

test("a week starts on Monday, including when today is Sunday", () => {
  assert.equal(startOfWeek(sunday), "2026-10-26");
  assert.equal(endOfWeek(sunday), "2026-11-01");
  assert.equal(startOfWeek("2026-11-04"), "2026-11-02");
  assert.equal(nextMonday(sunday), "2026-11-02");
  assert.equal(nextMonday("2026-11-04"), "2026-11-09");
});

test("open tasks fall into overdue, today, this week, later, or no date", () => {
  const groups = groupOpen(
    [
      task({ id: "late", dueOn: "2026-10-30" }),
      task({ id: "today", dueOn: sunday, createdAt: "2026-11-01T01:00:00.000Z" }),
      task({ id: "later-today", dueOn: sunday, createdAt: "2026-11-01T02:00:00.000Z" }),
      task({ id: "next", dueOn: "2026-11-04" }),
      task({ id: "far", dueOn: "2026-11-20" }),
      task({ id: "none", dueOn: null }),
      task({ id: "done", status: "done", completedAt: sunday }),
      task({ id: "aside", status: "set_aside" }),
    ],
    sunday,
  );
  assert.deepEqual(groups.overdue.map((item) => item.id), ["late"]);
  assert.deepEqual(groups.today.map((item) => item.id), ["today", "later-today"]);
  assert.deepEqual(groups.this_week.map((item) => item.id), []);
  assert.deepEqual(groups.later.map((item) => item.id), ["next", "far"]);
  assert.deepEqual(groups.none.map((item) => item.id), ["none"]);
  assert.equal(bucketFor(task({ id: "wed", dueOn: "2026-11-04" }), "2026-11-02"), "this_week");
});

test("the next seven days and the three week totals count open work", () => {
  const tasks = [
    task({ id: "a", dueOn: sunday }),
    task({ id: "b", dueOn: "2026-11-03" }),
    task({ id: "c", dueOn: "2026-11-10" }),
    task({ id: "d", dueOn: "2026-10-28", status: "done", completedAt: "2026-10-29" }),
  ];
  const days = nextSevenDays(tasks, [meeting({ id: "m1", personId: "mic", meetingDate: "2026-11-03" })], sunday);
  assert.equal(days[0].tasks, 1);
  assert.equal(days[2].date, "2026-11-03");
  assert.equal(days[2].tasks, 1);
  assert.equal(days[2].meetings, 1);
  assert.deepEqual(weekTotals(tasks, sunday), [
    { label: "This week", count: 1 },
    { label: "Next week", count: 1 },
    { label: "The week after", count: 1 },
  ]);
});

test("charts, oldest requests, and this week's in and out", () => {
  const mic = person("mic", "Mic");
  const ana = person("ana", "Ana");
  const tasks = [
    task({ id: "old", requesterId: "mic", requestedOn: "2026-10-01", dueOn: null, createdAt: "2026-10-01T00:00:00.000Z" }),
    task({ id: "newer", requesterId: "ana", requestedOn: "2026-10-20", createdAt: "2026-10-20T00:00:00.000Z" }),
    task({ id: "also", requesterId: "mic", requestedOn: "2026-10-28", dueOn: "2026-11-02", createdAt: "2026-10-28T00:00:00.000Z" }),
    task({ id: "finished", requesterId: "ana", requestedOn: "2026-10-27", status: "done", completedAt: "2026-10-29" }),
  ];
  assert.deepEqual(
    openByPerson(tasks, [ana, mic]).map((row) => [row.person.name, row.count]),
    [
      ["Mic", 2],
      ["Ana", 1],
    ],
  );
  assert.equal(waitingLine(openByPerson(tasks, [mic, ana])), "Mic has the most open tasks.");
  assert.deepEqual(oldestOpen(tasks).map((item) => item.id), ["old", "newer", "also"]);
  assert.deepEqual(weekFlow(tasks, sunday), { asked: 2, finished: 1 });
  assert.equal(
    fullestDayLine(
      [
        { date: sunday, count: 0 },
        { date: "2026-11-02", count: 2 },
        { date: "2026-11-03", count: 2 },
      ],
      sunday,
    ),
    "Mon and Tue are the fullest days.",
  );
  assert.equal(fullestDayLine([{ date: sunday, count: 0 }], sunday), "Nothing is due in the next seven days.");
});

test("a person's meetings keep open tasks above finished ones", () => {
  const meetings = [
    meeting({ id: "older", personId: "mic", meetingDate: "2026-10-01", title: "Intro" }),
    meeting({ id: "newer", personId: "mic", meetingDate: sunday, title: "Review" }),
    meeting({ id: "future", personId: "mic", meetingDate: "2026-11-12", title: "Planning" }),
  ];
  assert.deepEqual(meetingsForPerson(meetings, "mic").map((item) => item.id), ["future", "newer", "older"]);
  assert.equal(lastMetMeeting(meetings, "mic", sunday)?.title, "Review");
  assert.equal(nextMeeting(meetings, "mic", sunday)?.title, "Planning");
  const tasks = [
    task({ id: "done", meetingId: "newer", status: "done", completedAt: sunday, dueOn: "2026-10-02" }),
    task({ id: "open-late", meetingId: "newer", dueOn: "2026-11-08" }),
    task({ id: "open-soon", meetingId: "newer", dueOn: "2026-11-03" }),
    task({ id: "aside", meetingId: "newer", status: "set_aside", dueOn: "2026-11-01" }),
    task({ id: "other", meetingId: "other", requesterId: "mic" }),
  ];
  assert.deepEqual(tasksForMeeting(tasks, "newer").map((item) => item.id), [
    "open-soon",
    "open-late",
    "aside",
    "done",
  ]);
  assert.equal(openTasksForPerson(tasks, meetings, "mic").length, 2);
});

test("search matches people, meetings, and tasks", () => {
  const data = {
    people: [person("mic", "Mic")],
    meetings: [meeting({ id: "m1", personId: "mic", title: "Budget review", note: "bring the deck" })],
    tasks: [task({ id: "t1", title: "Send the deck" })],
  };
  assert.equal(searchAll(data, " deck ").tasks.length, 1);
  assert.equal(searchAll(data, "budget").meetings.length, 1);
  assert.equal(searchAll(data, "mi").people.length, 1);
  assert.equal(searchAll(data, "   ").people.length, 0);
  assert.equal(savedLine(0), "Saved: 1 meeting");
  assert.equal(savedLine(2), "Saved: 1 meeting, 2 tasks");
  assert.equal(addDays(sunday, 1), "2026-11-02");
});

test("a written day becomes a due date, and the median ignores one odd task", () => {
  const reading = readDateInTitle("Send the deck Friday", sunday);
  assert.equal(reading?.date, "2026-11-06");
  assert.equal(reading?.title, "Send the deck");
  assert.equal(readDateInTitle("Call tomorrow", sunday)?.date, "2026-11-02");
  assert.equal(readDateInTitle("Leave this evening", sunday)?.evening, true);
  const waits = [1, 2, 3, 4, 30].map((days, index) =>
    task({
      id: `done-${index}`,
      status: "done",
      requestedOn: "2026-10-01",
      completedAt: addDays("2026-10-01", days),
    }),
  );
  assert.equal(medianWait(waits), 3);
  assert.equal(medianWait(waits.slice(0, 4)), null);
  assert.equal(bucketFor(task({ id: "wait", status: "waiting" }), sunday), null);
  assert.equal(bucketFor(task({ id: "eve", evening: true, dueOn: sunday }), sunday), "evening");
});

test("due shortcuts on a Sunday land on today, Friday, and a week ahead", () => {
  assert.equal(fridayThisWeek(sunday), "2026-11-06");
  const presets = Object.fromEntries(duePresets(sunday).map((preset) => [preset.id, preset.date]));
  assert.equal(presets.eod, "2026-11-01");
  assert.equal(presets.tomorrow, "2026-11-02");
  assert.equal(presets.two, "2026-11-03");
  assert.equal(presets.eow, "2026-11-06");
  assert.equal(presets.next, "2026-11-08");
});

test("someday and the catch pile stay off the home list", () => {
  const data: Data = {
    people: [person("mic", "Mic")],
    companies: [],
    meetings: [meeting({ id: "m1", personId: "mic" })],
    tasks: [
      task({ id: "real" }),
      task({ id: "later", someday: true }),
      task({ id: "pile", unfiled: true, meetingId: "" }),
      task({ id: "gone", status: "void" }),
    ],
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
  };
  assert.equal(isOnBoard(task({ id: "later", someday: true }), sunday), false);
  assert.deepEqual(
    tasksForHome(data, sunday).map((item) => item.id),
    ["real"],
  );
});

test("a calendar week keeps this week's meetings and drops cancelled ones", async () => {
  const text = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:one@x",
    "DTSTART:20261103T150000",
    "SUMMARY:Gui sync",
    "URL:https://meet.example/one",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:gone@x",
    "STATUS:CANCELLED",
    "DTSTART:20261103T090000",
    "SUMMARY:Cancelled",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:later@x",
    "DTSTART:20261201T090000",
    "SUMMARY:Far away",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly@x",
    "DTSTART;VALUE=DATE:20261102",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "SUMMARY:Monday",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");
  const events = await agendaFromIcs(text, sunday);
  assert.equal(events.some((event) => event.title === "Cancelled"), false);
  assert.equal(events.some((event) => event.title === "Far away"), false);
  const gui = events.find((event) => event.title === "Gui sync");
  assert.equal(gui?.date, "2026-11-03");
  assert.equal(gui?.time, "15:00");
  assert.equal(gui?.id, "one@x");
  assert.equal(gui?.url, "https://meet.example/one");
  assert.equal(events.filter((event) => event.title === "Monday").map((event) => event.date).join(","), "2026-11-02");
});

test("monthly repeats keep their original day through short months and leap years", () => {
  assert.equal(nextDue("2027-01-31", "monthly", "2027-01-31", 31), "2027-02-28");
  assert.equal(nextDue("2027-02-28", "monthly", "2027-02-28", 31), "2027-03-31");
  assert.equal(nextDue("2024-01-31", "monthly", "2024-01-31", 31), "2024-02-29");
  assert.equal(nextDue("2024-02-29", "monthly", "2024-02-29", 31), "2024-03-31");
});

test("CSV exports quote line breaks and neutralize spreadsheet formulas", () => {
  const data = {
    people: [person("mic", "Mic")],
    meetings: [meeting({ id: "m1", personId: "mic", title: "Planning" })],
    tasks: [task({ id: "formula", title: '=HYPERLINK("https://bad.example","open")', notes: "first\r\nsecond" })],
  } as Data;
  const csv = boardCsv(data);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/bad\.example"",""open""\)"/);
  assert.match(csv, /"first\r\nsecond"/);
});

test("calendar meeting matching supports occurrence ids and legacy series ids", () => {
  const event = { id: "weekly@x::20261103T150000Z", date: "2026-11-03", time: "15:00", title: "Sync", url: "" };
  assert.equal(calendarEventMatches(meeting({ id: "linked", personId: "mic", meetingDate: event.date, calendarUid: event.id }), event), true);
  assert.equal(calendarEventMatches(meeting({ id: "legacy", personId: "mic", meetingDate: event.date, calendarUid: "weekly@x" }), event), true);
  assert.equal(calendarEventMatches(meeting({ id: "wrong-day", personId: "mic", meetingDate: "2026-11-04", calendarUid: "weekly@x" }), event), false);
});
