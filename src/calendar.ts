import type { AgendaEvent } from "./logic.ts";

type ClockParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function basicDateTime(value: string): string {
  return value.replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function wallClockParts(time: any): ClockParts {
  return {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
  };
}

function localDateString(parts: Pick<ClockParts, "year" | "month" | "day">): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function datePartsInZone(date: Date, timeZone?: string): ClockParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function ianaWallClockToDate(time: any, timeZone: string): Date {
  const wall = wallClockParts(time);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let guess = wallAsUtc;

  // IANA timezones vary with daylight-saving rules. Recalculate the offset at
  // the candidate instant so the same wall time resolves correctly year-round.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const zoned = datePartsInZone(new Date(guess), timeZone);
    const representedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
    const nextGuess = wallAsUtc - (representedAsUtc - guess);
    if (nextGuess === guess) break;
    guess = nextGuess;
  }
  return new Date(guess);
}

function timeZoneForProperty(property: any): string | null {
  const tzid = property?.getFirstParameter("tzid");
  return typeof tzid === "string" ? tzid : null;
}

function instantFor(time: any, property: any, calendar: any): Date {
  const tzid = timeZoneForProperty(property);
  if (tzid && !calendar.getTimeZoneByID(tzid)) {
    try {
      return ianaWallClockToDate(time, tzid);
    } catch {
      // Unknown proprietary TZIDs have no portable conversion data. Preserve
      // their wall time as floating local time rather than failing the feed.
    }
  }
  return time.toJSDate();
}

function eventDateTime(event: any, startTime: any, endTime: any, calendar: any, displayTimeZone?: string) {
  if (startTime.isDate) {
    const date = wallClockParts(startTime);
    return { date: localDateString(date), time: "", allDay: true, start: undefined, end: undefined };
  }

  const startProperty = event.component.getFirstProperty("dtstart");
  const start = instantFor(startTime, startProperty, calendar);
  const display = datePartsInZone(start, displayTimeZone);
  const date = localDateString(display);
  const time = `${String(display.hour).padStart(2, "0")}:${String(display.minute).padStart(2, "0")}`;

  const hasEnd = event.component.hasProperty("dtend") || event.component.hasProperty("duration");
  const endProperty = event.component.getFirstProperty("dtend") ?? startProperty;
  const end = hasEnd && endTime ? instantFor(endTime, endProperty, calendar).toISOString() : undefined;
  return { date, time, allDay: false, start: start.toISOString(), end };
}

function stringValue(component: any, propertyName: string, fallback = ""): string {
  const value = component.getFirstPropertyValue(propertyName);
  return typeof value === "string" ? value.trim() : fallback;
}

function makeAgendaEvent(
  event: any,
  calendar: any,
  originalStart: any,
  effectiveStart: any,
  effectiveEnd: any,
  recurring: boolean,
  displayTimeZone?: string,
): AgendaEvent | null {
  const status = stringValue(event.component, "status").toUpperCase();
  if (status === "CANCELLED") return null;

  const when = eventDateTime(event, effectiveStart, effectiveEnd, calendar, displayTimeZone);
  const uid = event.uid || `${when.date}:${stringValue(event.component, "summary", "Meeting")}`;
  const id = recurring ? `${uid}::${basicDateTime(originalStart.toICALString())}` : uid;
  return {
    id,
    date: when.date,
    time: when.time,
    title: stringValue(event.component, "summary", "Meeting") || "Meeting",
    url: stringValue(event.component, "url"),
    ...(when.start ? { start: when.start } : {}),
    ...(when.end ? { end: when.end } : {}),
    ...(when.allDay ? { allDay: true } : {}),
  };
}

function isoFromTime(time: any, property: any, calendar: any, displayTimeZone?: string): string {
  if (time.isDate) return localDateString(wallClockParts(time));
  return localDateString(datePartsInZone(instantFor(time, property, calendar), displayTimeZone));
}

export async function parseAgendaFromIcs(text: string, today: string, displayTimeZone?: string): Promise<AgendaEvent[]> {
  const { default: ICAL } = await import("ical.js");
  const parsed = ICAL.parse(text);
  const calendar = new ICAL.Component(parsed);
  const components = calendar.getAllSubcomponents("vevent");
  const exceptionsByUid = new Map<string, any[]>();
  const cancelledOccurrencesByUid = new Map<string, Set<string>>();
  for (const candidate of components) {
    if (!candidate.hasProperty("recurrence-id")) continue;
    const uid = stringValue(candidate, "uid");
    if (stringValue(candidate, "status").toUpperCase() === "CANCELLED") {
      const recurrenceId: any = candidate.getFirstPropertyValue("recurrence-id");
      if (recurrenceId) {
        const cancelled = cancelledOccurrencesByUid.get(uid) ?? new Set<string>();
        cancelled.add(recurrenceId.toString());
        cancelled.add(recurrenceId.convertToZone(ICAL.Timezone.utcTimezone).toString());
        cancelledOccurrencesByUid.set(uid, cancelled);
      }
      continue;
    }
    const related = exceptionsByUid.get(uid) ?? [];
    related.push(candidate);
    exceptionsByUid.set(uid, related);
  }
  const todayDate = new Date(`${today}T00:00:00`);
  const endDate = new Date(todayDate);
  endDate.setDate(endDate.getDate() + 6);
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
  const events: AgendaEvent[] = [];

  for (const component of components) {
    const uid = stringValue(component, "uid");
    const isException = component.hasProperty("recurrence-id");
    const event = isException
      ? new ICAL.Event(component)
      : new ICAL.Event(component, {
          // ICAL.js otherwise relates every recurrence exception from the parent,
          // including exceptions from unrelated series with matching dates.
          exceptions: exceptionsByUid.get(uid) ?? [],
        });
    const cancelled = stringValue(component, "status").toUpperCase() === "CANCELLED";
    if (cancelled && event.isRecurrenceException()) continue;

    if (event.isRecurrenceException()) {
      // Master expansion handles in-range instances. Including the explicit
      // exception here also catches an override moved into this week from a
      // recurrence whose original date is outside the expansion window.
      const recurrenceId = event.recurrenceId;
      const start = event.startDate;
      const date = isoFromTime(start, component.getFirstProperty("dtstart"), calendar, displayTimeZone);
      if (date >= today && date <= end) {
        const emitted = makeAgendaEvent(event, calendar, recurrenceId, start, event.endDate, true, displayTimeZone);
        if (emitted) events.push(emitted);
      }
      continue;
    }

    if (cancelled || !component.hasProperty("dtstart")) continue;

    if (!event.isRecurring()) {
      const start = event.startDate;
      const date = isoFromTime(start, component.getFirstProperty("dtstart"), calendar, displayTimeZone);
      if (date >= today && date <= end) {
        const emitted = makeAgendaEvent(event, calendar, start, start, event.endDate, false, displayTimeZone);
        if (emitted) events.push(emitted);
      }
      continue;
    }

    const iterator = event.iterator();
    let tries = 0;
    let occurrence = iterator.next();
    while (occurrence && tries < 200_000) {
      tries += 1;
      const originalDate = isoFromTime(occurrence, component.getFirstProperty("dtstart"), calendar, displayTimeZone);
      const cancelledIds = cancelledOccurrencesByUid.get(uid);
      const occurrenceIsCancelled = cancelledIds?.has(occurrence.toString())
        || cancelledIds?.has(occurrence.convertToZone(ICAL.Timezone.utcTimezone).toString());
      let date = originalDate;
      if (!occurrenceIsCancelled) {
        const details = event.getOccurrenceDetails(occurrence);
        const effectiveStart = details.startDate;
        date = effectiveStart
          ? isoFromTime(effectiveStart, details.item.component.getFirstProperty("dtstart"), calendar, displayTimeZone)
          : originalDate;
        const cancelledOccurrence = stringValue(details.item.component, "status").toUpperCase() === "CANCELLED";
        if (!cancelledOccurrence && effectiveStart && date >= today && date <= end) {
          const emitted = makeAgendaEvent(details.item, calendar, occurrence, effectiveStart, details.endDate, true, displayTimeZone);
          if (emitted) events.push(emitted);
        }
      }

      // Keep a small timezone margin because an event's original local date
      // can differ from its displayed date by a day.
      if (date > end && originalDate > end) break;
      occurrence = iterator.next();
    }
  }

  const seen = new Set<string>();
  return events
    .filter((event) => {
      const key = `${event.id}|${event.date}|${event.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
}
