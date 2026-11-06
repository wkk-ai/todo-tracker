import assert from "node:assert/strict";
import test from "node:test";
import { mergeCalendarEvents, SingleFlight } from "../src/calendarSync.ts";

test("same-title meetings survive merge; only exact provider occurrences deduplicate", () => {
  const one = { id: "google:one", date: "2026-11-06", time: "10:00", title: "Review", url: "" };
  const two = { ...one, id: "mac:two", time: "14:00" };
  assert.equal(mergeCalendarEvents([one, one], [two]).length, 2);
});

test("focus and interval share one fetch; failure permits the next retry", async () => {
  const flight = new SingleFlight<string>();
  let calls = 0, finish!: (value: string) => void;
  const work = () => { calls++; return new Promise<string>((resolve) => { finish = resolve; }); };
  const one = flight.run("calendar", work), two = flight.run("calendar", work);
  assert.equal(calls, 1);
  finish("ready");
  assert.deepEqual(await Promise.all([one, two]), ["ready", "ready"]);
  await assert.rejects(flight.run("calendar", async () => { throw Error("offline"); }));
  assert.equal(await flight.run("calendar", async () => "retried"), "retried");
});
