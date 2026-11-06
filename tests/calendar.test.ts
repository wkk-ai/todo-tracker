import assert from "node:assert/strict";
import test from "node:test";
import { agendaFromIcs } from "../src/logic.ts";

function calendar(...events: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Todo Tracker//EN", ...events, "END:VCALENDAR"].join("\r\n");
}

function event(lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

test("RRULE count, UNTIL, EXDATE, and RDATE all affect the expanded agenda", async () => {
  const input = calendar(event([
    "UID:daily@x",
    "DTSTART:20261102T150000Z",
    "DTEND:20261102T153000Z",
    "RRULE:FREQ=DAILY;COUNT=5;UNTIL=20261106T150000Z",
    "EXDATE:20261103T150000Z",
    "RDATE:20261108T150000Z",
    "SUMMARY:Daily sync",
  ]));

  const agenda = await agendaFromIcs(input, "2026-11-02", "UTC");
  assert.deepEqual(agenda.map((item) => [item.date, item.id]), [
    ["2026-11-02", "daily@x::20261102T150000Z"],
    ["2026-11-04", "daily@x::20261104T150000Z"],
    ["2026-11-05", "daily@x::20261105T150000Z"],
    ["2026-11-06", "daily@x::20261106T150000Z"],
    ["2026-11-08", "daily@x::20261108T150000Z"],
  ]);
  assert.equal(agenda[0].start, "2026-11-02T15:00:00.000Z");
  assert.equal(agenda[0].end, "2026-11-02T15:30:00.000Z");
  const laterOccurrence = agenda.find((item) => item.date === "2026-11-04");
  assert.equal(laterOccurrence?.start, "2026-11-04T15:00:00.000Z");
  assert.equal(laterOccurrence?.end, "2026-11-04T15:30:00.000Z");
});

test("a moved recurrence keeps the original occurrence in its stable id", async () => {
  const input = calendar(
    event([
      "UID:weekly@x",
      "DTSTART:20261102T150000Z",
      "DTEND:20261102T153000Z",
      "RRULE:FREQ=DAILY;COUNT=5",
      "SUMMARY:Planning",
    ]),
    event([
      "UID:weekly@x",
      "RECURRENCE-ID:20261103T150000Z",
      "DTSTART:20261106T160000Z",
      "DTEND:20261106T163000Z",
      "SUMMARY:Planning moved",
    ]),
  );

  const agenda = await agendaFromIcs(input, "2026-11-02", "UTC");
  const moved = agenda.find((item) => item.title === "Planning moved");
  assert.deepEqual([moved?.id, moved?.date, moved?.time, moved?.start, moved?.end], [
    "weekly@x::20261103T150000Z",
    "2026-11-06",
    "16:00",
    "2026-11-06T16:00:00.000Z",
    "2026-11-06T16:30:00.000Z",
  ]);
});

test("canceled overrides are removed and all-day events remain date-only", async () => {
  const input = calendar(
    event([
      "UID:daily@x",
      "DTSTART:20261102T150000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Daily",
    ]),
    event([
      "UID:daily@x",
      "RECURRENCE-ID:20261103T150000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Cancelled instance",
    ]),
    event(["UID:all-day@x", "DTSTART;VALUE=DATE:20261104", "SUMMARY:Team day"]),
  );

  const agenda = await agendaFromIcs(input, "2026-11-02", "UTC");
  assert.equal(agenda.some((item) => item.title === "Cancelled instance"), false);
  const allDay = agenda.find((item) => item.title === "Team day");
  assert.equal(allDay?.date, "2026-11-04");
  assert.equal(allDay?.allDay, true);
  assert.equal(allDay?.start, undefined);
  assert.equal(allDay?.end, undefined);
});

test("events are filtered by the displayed calendar day at timezone boundaries", async () => {
  const input = calendar(event([
    "UID:tokyo@x",
    "DTSTART:20261101T153000Z",
    "DTEND:20261101T160000Z",
    "SUMMARY:Tokyo morning",
  ]));

  const agenda = await agendaFromIcs(input, "2026-11-02", "Asia/Tokyo");
  assert.deepEqual(agenda.map((item) => [item.date, item.time]), [["2026-11-02", "00:30"]]);
});

test("recurring instances on the last displayed day are not cut off by their UTC date", async () => {
  const input = calendar(event([
    "UID:pacific@x",
    "DTSTART;TZID=America/Los_Angeles:20261102T233000",
    "DTEND;TZID=America/Los_Angeles:20261103T003000",
    "RRULE:FREQ=DAILY",
    "SUMMARY:Late Pacific sync",
  ]));

  const agenda = await agendaFromIcs(input, "2026-11-02", "America/Los_Angeles");
  assert.ok(agenda.some((item) => item.date === "2026-11-08" && item.time === "23:30"));
});

test("recurrence overrides only apply to the series with the matching UID", async () => {
  const input = calendar(
    event([
      "UID:first@x",
      "DTSTART:20261102T150000Z",
      "DTEND:20261102T153000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:First series",
    ]),
    event([
      "UID:second@x",
      "DTSTART:20261102T150000Z",
      "DTEND:20261102T153000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Second series",
    ]),
    event([
      "UID:first@x",
      "RECURRENCE-ID:20261103T150000Z",
      "DTSTART:20261103T170000Z",
      "DTEND:20261103T173000Z",
      "SUMMARY:First series moved",
    ]),
  );

  const agenda = await agendaFromIcs(input, "2026-11-02", "UTC");
  assert.ok(agenda.some((item) => item.title === "Second series" && item.date === "2026-11-03" && item.time === "15:00"));
  assert.ok(agenda.some((item) => item.title === "First series moved" && item.date === "2026-11-03" && item.time === "17:00"));
});

test("IANA timezone events without embedded VTIMEZONE convert to the display timezone", async () => {
  const input = calendar(event([
    "UID:tzid@x",
    "DTSTART;TZID=America/Los_Angeles:20261102T090000",
    "DTEND;TZID=America/Los_Angeles:20261102T100000",
    "SUMMARY:Pacific sync",
  ]));

  const agenda = await agendaFromIcs(input, "2026-11-02", "UTC");
  assert.deepEqual([agenda[0].date, agenda[0].time, agenda[0].start, agenda[0].end], [
    "2026-11-02",
    "17:00",
    "2026-11-02T17:00:00.000Z",
    "2026-11-02T18:00:00.000Z",
  ]);
});

test("monthly and yearly rules expand within the requested week", async () => {
  const input = calendar(
    event([
      "UID:monthly@x",
      "DTSTART:20261102T150000Z",
      "RRULE:FREQ=MONTHLY;COUNT=3;BYDAY=1MO",
      "SUMMARY:First Monday",
    ]),
    event([
      "UID:yearly@x",
      "DTSTART:20240229T150000Z",
      "RRULE:FREQ=YEARLY;COUNT=3;BYMONTH=2;BYMONTHDAY=29",
      "SUMMARY:Leap day",
    ]),
  );

  const monthly = await agendaFromIcs(input, "2026-12-01", "UTC");
  assert.deepEqual(monthly.filter((item) => item.title === "First Monday").map((item) => item.date), ["2026-12-07"]);

  const yearly = await agendaFromIcs(input, "2028-02-27", "UTC");
  assert.deepEqual(yearly.filter((item) => item.title === "Leap day").map((item) => item.date), ["2028-02-29"]);
});
