import type { CaptureEntry, MeetingSaveReceipt } from "./capture.ts";

export type TaskStatus = "open" | "in_progress" | "waiting" | "done" | "set_aside" | "void";
export type Owner = "mine" | "theirs";
export type Priority = "none" | "low" | "medium" | "high";
export type RepeatRule = "daily" | "weekly" | "monthly" | null;

export type Person = {
  id: string;
  name: string;
  note: string;
  createdAt: string;
  color: string;
  companyId: string | null;
  checkInOn: string | null;
  cadenceDays: number | null;
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

export type Company = { id: string; name: string };

export type Meeting = {
  id: string;
  personId: string;
  title: string;
  meetingDate: string;
  note: string;
  createdAt: string;
  guestIds: string[];
  privateNote?: string;
  nextOn?: string | null;
  nextFocus?: string;
  spanEnd?: string | null;
  sourceUrl?: string;
  calendarUid?: string;
  pinned?: boolean;
};

export type Task = {
  id: string;
  meetingId: string;
  requesterId: string;
  title: string;
  requestedOn: string;
  dueOn: string | null;
  status: TaskStatus;
  completedAt: string | null;
  createdAt: string;
  priority: Priority;
  pinned: boolean;
  evening: boolean;
  repeatRule: RepeatRule;
  repeatAnchorDay?: number | null;
  notes: string;
  movedCount: number;
  parentId: string | null;
  remind: boolean;
  updatedAt: string;
  tagIds: string[];
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
  folded?: boolean;
  sourceLine?: string;
  unfiled?: boolean;
  returned?: boolean;
  spentMin?: number;
};

export type CheckItem = { id: string; taskId: string; title: string; done: boolean; position: number };
export type Tag = { id: string; name: string };
export type Decision = { id: string; meetingId: string; body: string; createdAt: string; why?: string };
export type Bullet = {
  id: string;
  ownerKind: string;
  ownerId: string;
  kind: string;
  body: string;
  indent: number;
  position: number;
  done: boolean;
  folded: boolean;
};
export type Section = { id: string; personId: string; name: string; position: number };
export type LifeDate = { id: string; personId: string; label: string; onDate: string };
export type Gift = { id: string; personId: string; body: string; given: boolean };
export type AskLater = { id: string; personId: string; body: string; onDate: string; done: boolean };
export type DayLog = { id: string; onDate: string; kind: string; body: string };
export type Activity = { id: string; taskId: string | null; kind: string; detail: string; createdAt: string };
export type Attachment = {
  id: string;
  taskId: string | null;
  meetingId: string | null;
  name: string;
  path: string;
  createdAt: string;
};
export type Template = { id: string; name: string; lines: string[] };
export type SavedView = { id: string; name: string; stale: boolean; tagId: string | null; personId: string | null };
export type RemovedPerson = { id: string; name: string; snapshot: string; removedAt: string };

export type Settings = {
  theme: "light" | "dark";
  typeSize: "normal" | "large";
  keepSheetOpen: boolean;
  lastPersonId: string | null;
  hideFinished: boolean;
  morningDate: string | null;
  backupPath: string;
  sortClosest: boolean;
  awayFrom: string | null;
  awayUntil: string | null;
  pingHour: string;
  weekHours: number;
  contrast: boolean;
  readyHour: string;
  weekdayOnly: boolean;
  onlyPersonId: string | null;
  googleIcal: string;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  typeSize: "normal",
  keepSheetOpen: false,
  lastPersonId: null,
  hideFinished: false,
  morningDate: null,
  backupPath: "",
  sortClosest: false,
  awayFrom: null,
  awayUntil: null,
  pingHour: "09:00",
  weekHours: 0,
  contrast: false,
  readyHour: "09:00",
  weekdayOnly: false,
  onlyPersonId: null,
  googleIcal: "",
};

export type Data = {
  people: Person[];
  companies: Company[];
  meetings: Meeting[];
  tasks: Task[];
  checks: CheckItem[];
  tags: Tag[];
  decisions: Decision[];
  activity: Activity[];
  attachments: Attachment[];
  templates: Template[];
  views: SavedView[];
  removed: RemovedPerson[];
  settings: Settings;
  bullets: Bullet[];
  sections: Section[];
  lifeDates: LifeDate[];
  gifts: Gift[];
  asks: AskLater[];
  logs: DayLog[];
  captureEntries?: CaptureEntry[];
  meetingSaveReceipts?: MeetingSaveReceipt[];
};

export type Bucket = "overdue" | "today" | "evening" | "this_week" | "later" | "none";

export const PERSON_COLORS = ["#C4A484", "#7D9A84", "#8AA0B4", "#C4B07A", "#B48A9A", "#9A8AB4", "#8AB4A8", "#A89880"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseISODate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayISO(now = new Date()): string {
  return formatISODate(now);
}

export function addDays(iso: string, days: number): string {
  const date = parseISODate(iso);
  date.setDate(date.getDate() + days);
  return formatISODate(date);
}

export function startOfWeek(iso: string): string {
  const date = parseISODate(iso);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return formatISODate(date);
}

export function endOfWeek(iso: string): string {
  return addDays(startOfWeek(iso), 6);
}

export function daysBetween(from: string, to: string): number {
  const start = parseISODate(from).getTime();
  const end = parseISODate(to).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function nextMonday(today: string): string {
  const day = parseISODate(today).getDay();
  const delta = day === 0 ? 1 : 8 - day;
  return addDays(today, delta);
}

export function formatDay(iso: string, today: string): string {
  if (iso === today) return "Today";
  if (iso === addDays(today, -1)) return "Yesterday";
  if (iso === addDays(today, 1)) return "Tomorrow";
  const date = parseISODate(iso);
  const sameYear = date.getFullYear() === parseISODate(today).getFullYear();
  const base = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return sameYear ? base : `${base} ${date.getFullYear()}`;
}

export function weekdayShort(iso: string): string {
  return WEEKDAYS[parseISODate(iso).getDay()];
}

export function dayNumber(iso: string): number {
  return parseISODate(iso).getDate();
}

export function isActive(task: Task): boolean {
  return task.status === "open" || task.status === "in_progress";
}

export function isOnBoard(task: Task, today = todayISO()): boolean {
  if (task.status === "void" || task.someday || task.unfiled || task.returned) return false;
  if (task.wake === "meeting" || task.wake === "open") return false;
  if (task.hideUntil && task.hideUntil > today) return false;
  return isActive(task) && !task.parentId;
}

export function fridayThisWeek(today: string): string {
  const friday = addDays(startOfWeek(today), 4);
  return friday < today ? addDays(friday, 7) : friday;
}

export function duePresets(today: string): { id: string; label: string; date: string }[] {
  return [
    { id: "eod", label: "EOD", date: today },
    { id: "tomorrow", label: "Tomorrow", date: addDays(today, 1) },
    { id: "two", label: "In 2 Days", date: addDays(today, 2) },
    { id: "eow", label: "EOW", date: fridayThisWeek(today) },
    { id: "next", label: "Next Week", date: addDays(today, 7) },
  ];
}

export function tasksForHome(data: Data, today: string): Task[] {
  const paused = new Set(data.people.filter((person) => person.paused).map((person) => person.id));
  const away =
    Boolean(data.settings.awayFrom && data.settings.awayUntil) &&
    today >= (data.settings.awayFrom ?? "") &&
    today <= (data.settings.awayUntil ?? "");
  let tasks = data.tasks.filter((task) => isOnBoard(task, today) && !paused.has(task.requesterId));
  if (data.settings.onlyPersonId) tasks = tasks.filter((task) => task.requesterId === data.settings.onlyPersonId);
  if (away) tasks = tasks.filter((task) => !task.dueOn || task.dueOn >= today);
  const sequential = new Set(data.people.filter((person) => person.sequential).map((person) => person.id));
  const keep = new Set<string>();
  for (const personId of sequential) {
    const next = tasks
      .filter((task) => task.requesterId === personId)
      .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || a.createdAt.localeCompare(b.createdAt))[0];
    if (next) keep.add(next.id);
  }
  tasks = tasks.filter((task) => !sequential.has(task.requesterId) || keep.has(task.id));
  if (data.settings.weekdayOnly) {
    tasks = tasks.map((task) => {
      if (!task.dueOn) return task;
      const day = parseISODate(task.dueOn).getDay();
      if (day === 0 || day === 6) return { ...task, dueOn: nextMonday(task.dueOn === today ? today : task.dueOn) };
      return task;
    });
  }
  return tasks;
}

export function statusBars(tasks: Task[]): { label: string; count: number }[] {
  const count = (status: TaskStatus) => tasks.filter((task) => task.status === status).length;
  return [
    { label: "Open", count: count("open") },
    { label: "Doing", count: count("in_progress") },
    { label: "Waiting", count: count("waiting") },
    { label: "Done", count: count("done") },
  ];
}

export function boxOf(task: Task, today: string, nextMeet: string | null): number {
  const soon = Boolean((task.dueOn && task.dueOn <= addDays(today, 2)) || (nextMeet && nextMeet <= addDays(today, 3)));
  const cares = task.priority === "high" || task.priority === "medium";
  if (cares && soon) return 0;
  if (cares) return 1;
  if (soon) return 2;
  return 3;
}

export function bucketFor(task: Task, today: string): Bucket | null {
  if (!isOnBoard(task, today)) return null;
  if (task.dueOn && task.dueOn < today) return "overdue";
  if (task.evening && (task.dueOn === today || !task.dueOn)) return "evening";
  if (!task.dueOn) return "none";
  if (task.dueOn === today) return "today";
  if (task.dueOn <= endOfWeek(today)) return "this_week";
  return "later";
}

export function groupOpen(tasks: Task[], today: string): Record<Bucket, Task[]> {
  const groups: Record<Bucket, Task[]> = {
    overdue: [],
    today: [],
    evening: [],
    this_week: [],
    later: [],
    none: [],
  };
  for (const task of tasks) {
    const bucket = bucketFor(task, today);
    if (bucket) groups[bucket].push(task);
  }
  const pin = (a: Task, b: Task) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  const byDue = (a: Task, b: Task) =>
    pin(a, b) || (a.dueOn ?? "").localeCompare(b.dueOn ?? "") || a.createdAt.localeCompare(b.createdAt);
  groups.overdue.sort(byDue);
  groups.today.sort((a, b) => pin(a, b) || a.createdAt.localeCompare(b.createdAt));
  groups.evening.sort((a, b) => pin(a, b) || a.createdAt.localeCompare(b.createdAt));
  groups.this_week.sort(byDue);
  groups.later.sort(byDue);
  groups.none.sort(
    (a, b) => pin(a, b) || a.requestedOn.localeCompare(b.requestedOn) || a.createdAt.localeCompare(b.createdAt),
  );
  return groups;
}

export type DayMark = {
  date: string;
  tasks: number;
  meetings: number;
};

export function nextSevenDays(tasks: Task[], meetings: Meeting[], today: string): DayMark[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index);
    return {
      date,
      tasks: tasks.filter((task) => isOnBoard(task) && task.dueOn === date).length,
      meetings: meetings.filter((meeting) => meeting.meetingDate === date).length,
    };
  });
}

export function weekTotals(tasks: Task[], today: string): { label: string; count: number }[] {
  const start = startOfWeek(today);
  return [0, 1, 2].map((index) => {
    const from = addDays(start, index * 7);
    const to = addDays(from, 6);
    const count = tasks.filter(
      (task) => isOnBoard(task) && task.dueOn !== null && task.dueOn >= from && task.dueOn <= to,
    ).length;
    const label = index === 0 ? "This week" : index === 1 ? "Next week" : "The week after";
    return { label, count };
  });
}

export function openByPerson(tasks: Task[], people: Person[]): { person: Person; count: number }[] {
  return people
    .map((person) => ({
      person,
      count: tasks.filter((task) => isOnBoard(task) && task.requesterId === person.id).length,
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name));
}

export function fullestDayLine(days: { date: string; count: number }[], today: string): string {
  const max = Math.max(0, ...days.map((day) => day.count));
  if (max === 0) return "Nothing is due in the next seven days.";
  const names = days
    .filter((day) => day.count === max)
    .map((day) => (day.date === today ? "Today" : weekdayShort(day.date)));
  if (names.length === 1) return `${names[0]} is the fullest day.`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are the fullest days.`;
}

export function waitingLine(rows: { person: Person; count: number }[]): string {
  if (rows.length === 0) return "No one is waiting.";
  const top = rows[0];
  if (rows.length === 1) {
    return top.count === 1
      ? `${top.person.name} is waiting on one task.`
      : `${top.person.name} is waiting on ${top.count} tasks.`;
  }
  return `${top.person.name} has the most open tasks.`;
}

export function oldestOpen(tasks: Task[], limit = 3): Task[] {
  return tasks
    .filter((task) => isOnBoard(task))
    .sort(
      (a, b) => a.requestedOn.localeCompare(b.requestedOn) || a.createdAt.localeCompare(b.createdAt),
    )
    .slice(0, limit);
}

export function weekFlow(tasks: Task[], today: string): { asked: number; finished: number } {
  const from = startOfWeek(today);
  const to = endOfWeek(today);
  return {
    asked: tasks.filter((task) => task.requestedOn >= from && task.requestedOn <= to).length,
    finished: tasks.filter(
      (task) =>
        task.status === "done" &&
        task.completedAt !== null &&
        task.completedAt >= from &&
        task.completedAt <= to,
    ).length,
  };
}

export function personInMeeting(meeting: Meeting, personId: string): boolean {
  return meeting.personId === personId || (meeting.guestIds ?? []).includes(personId);
}

export function meetingsForPerson(meetings: Meeting[], personId: string): Meeting[] {
  return meetings
    .filter((meeting) => personInMeeting(meeting, personId))
    .sort(
      (a, b) => b.meetingDate.localeCompare(a.meetingDate) || b.createdAt.localeCompare(a.createdAt),
    );
}

export function lastMetMeeting(meetings: Meeting[], personId: string, today: string): Meeting | null {
  const past = meetingsForPerson(meetings, personId).filter((meeting) => meeting.meetingDate <= today);
  return past[0] ?? null;
}

export function nextMeeting(meetings: Meeting[], personId: string, today: string): Meeting | null {
  const future = meetingsForPerson(meetings, personId)
    .filter((meeting) => meeting.meetingDate > today)
    .sort((a, b) => a.meetingDate.localeCompare(b.meetingDate) || a.createdAt.localeCompare(b.createdAt));
  return future[0] ?? null;
}

export function meetingIdsForPerson(meetings: Meeting[], personId: string): Set<string> {
  return new Set(meetings.filter((meeting) => personInMeeting(meeting, personId)).map((meeting) => meeting.id));
}

export function openTasksForPerson(tasks: Task[], meetings: Meeting[], personId: string): Task[] {
  const ids = meetingIdsForPerson(meetings, personId);
  return tasks.filter((task) => isActive(task) && ids.has(task.meetingId));
}

export function tasksForMeeting(
  tasks: Task[],
  meetingId: string,
  options?: { closest?: boolean; checks?: CheckItem[] },
): Task[] {
  const rank: Record<TaskStatus, number> = {
    in_progress: 0,
    open: 1,
    waiting: 2,
    set_aside: 3,
    done: 4,
    void: 5,
  };
  const doneRatio = (task: Task) => {
    const rows = (options?.checks ?? []).filter((item) => item.taskId === task.id);
    if (rows.length === 0) return task.status === "in_progress" ? 0.5 : 0;
    return rows.filter((item) => item.done).length / rows.length;
  };
  return tasks
    .filter((task) => task.meetingId === meetingId)
    .sort((a, b) => {
      if (options?.closest) {
        const ratio = doneRatio(b) - doneRatio(a);
        if (ratio !== 0) return ratio;
      }
      const status = rank[a.status] - rank[b.status];
      if (status !== 0) return status;
      const dueA = a.dueOn ?? "9999-99-99";
      const dueB = b.dueOn ?? "9999-99-99";
      return dueA.localeCompare(dueB) || a.createdAt.localeCompare(b.createdAt);
    });
}

export function tasksAskedElsewhere(tasks: Task[], meetings: Meeting[], personId: string): Task[] {
  const ids = meetingIdsForPerson(meetings, personId);
  return tasks
    .filter((task) => task.requesterId === personId && !ids.has(task.meetingId))
    .sort((a, b) => b.requestedOn.localeCompare(a.requestedOn) || b.createdAt.localeCompare(a.createdAt));
}

export function personName(people: Person[], id: string): string {
  return people.find((person) => person.id === id)?.name ?? "Someone";
}

export function findPersonByName(people: Person[], name: string): Person | undefined {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return undefined;
  return people.find((person) => person.name.trim().toLowerCase() === trimmed);
}

export type SearchHits = {
  people: Person[];
  meetings: Meeting[];
  tasks: Task[];
};

export function searchAll(data: Data, query: string): SearchHits {
  const needle = query.trim().toLowerCase();
  if (!needle) return { people: [], meetings: [], tasks: [] };
  return {
    people: data.people.filter((person) => person.name.toLowerCase().includes(needle)),
    meetings: data.meetings.filter(
      (meeting) =>
        meeting.title.toLowerCase().includes(needle) || meeting.note.toLowerCase().includes(needle),
    ),
    tasks: data.tasks.filter((task) =>
        `${task.title} ${task.notes ?? ""}`.toLowerCase().includes(needle),
      ),
  };
}

export function lateLabel(dueOn: string, today: string): string {
  const days = daysBetween(dueOn, today);
  return days === 1 ? "1 day late" : `${days} days late`;
}

export function waitingAge(requestedOn: string, today: string): string {
  const days = daysBetween(requestedOn, today);
  if (days <= 0) return "Asked today";
  if (days === 1) return "Waiting 1 day";
  return `Waiting ${days} days`;
}

export function savedLine(taskCount: number): string {
  if (taskCount === 0) return "Saved: 1 meeting";
  if (taskCount === 1) return "Saved: 1 meeting, 1 task";
  return `Saved: 1 meeting, ${taskCount} tasks`;
}

export function sortPeople(people: Person[]): Person[] {
  return [...people].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function swatch(person: Person, people: Person[]): string {
  if (person.color) return person.color;
  const index = Math.max(0, people.findIndex((item) => item.id === person.id));
  return PERSON_COLORS[index % PERSON_COLORS.length];
}

export function companyName(companies: Company[], id: string | null): string {
  if (!id) return "";
  return companies.find((company) => company.id === id)?.name ?? "";
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type DateReading = { date: string; phrase: string; title: string; evening: boolean };

function upcomingWeekday(today: string, name: string, forceNext: boolean): string {
  const target = WEEKDAY_NAMES.indexOf(name.toLowerCase());
  const current = parseISODate(today).getDay();
  let delta = (target - current + 7) % 7;
  if (forceNext && delta === 0) delta = 7;
  return addDays(today, delta);
}

export function readDateInTitle(title: string, today: string): DateReading | null {
  const rules: { re: RegExp; date: (match: RegExpMatchArray) => string; evening?: boolean }[] = [
    { re: /\bnext week\b/i, date: () => addDays(startOfWeek(today), 7) },
    { re: /\bthis evening\b/i, date: () => today, evening: true },
    { re: /\btomorrow\b/i, date: () => addDays(today, 1) },
    { re: /\btoday\b/i, date: () => today },
    { re: /\bin (\d+) days?\b/i, date: (match) => addDays(today, Number(match[1])) },
    {
      re: /\bnext (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      date: (match) => upcomingWeekday(today, match[1], true),
    },
    {
      re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      date: (match) => upcomingWeekday(today, match[1], false),
    },
    { re: /\b(\d{4}-\d{2}-\d{2})\b/, date: (match) => match[1] },
  ];
  for (const rule of rules) {
    const match = title.match(rule.re);
    if (!match || match.index === undefined) continue;
    const date = rule.date(match);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const phrase = match[0];
    const rest = `${title.slice(0, match.index)} ${title.slice(match.index + phrase.length)}`.replace(/\s+/g, " ").trim();
    return { date, phrase, title: rest || title, evening: Boolean(rule.evening) };
  }
  return null;
}

export function nextDue(dueOn: string | null, rule: RepeatRule, today: string, anchorDay?: number | null): string {
  const base = dueOn && dueOn > today ? dueOn : today;
  if (rule === "weekly") return addDays(base, 7);
  if (rule === "monthly") {
    const date = parseISODate(base);
    const originalDay = anchorDay ?? parseISODate(dueOn ?? today).getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(originalDay, daysInMonth));
    return formatISODate(date);
  }
  return addDays(base, 1);
}

export function isStale(task: Task, today: string): boolean {
  if (!isOnBoard(task)) return false;
  const stamp = (task.updatedAt || task.createdAt || today).slice(0, 10);
  return daysBetween(stamp, today) >= 14;
}

export function isLongWait(task: Task, today: string): boolean {
  if (!isOnBoard(task)) return false;
  if (daysBetween(task.requestedOn, today) < 14) return false;
  return !task.dueOn || task.dueOn >= today;
}

export function spanPercent(task: Task, today: string): number | null {
  if (!task.dueOn) return null;
  const total = Math.max(1, daysBetween(task.requestedOn, task.dueOn));
  const elapsed = daysBetween(task.requestedOn, today);
  return Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
}

export function medianWait(tasks: Task[]): number | null {
  const samples = tasks
    .filter((task) => task.status === "done" && task.completedAt)
    .map((task) => daysBetween(task.requestedOn, task.completedAt as string))
    .filter((days) => days >= 0)
    .sort((a, b) => a - b);
  if (samples.length < 5) return null;
  const mid = Math.floor(samples.length / 2);
  if (samples.length % 2 === 1) return samples[mid];
  return Math.round((samples[mid - 1] + samples[mid]) / 2);
}

export function fiveWeeks(tasks: Task[], today: string): { date: string; count: number }[] {
  const start = startOfWeek(today);
  return Array.from({ length: 35 }, (_, index) => {
    const date = addDays(start, index);
    return { date, count: tasks.filter((task) => isOnBoard(task) && task.dueOn === date).length };
  });
}

export function openSparkline(tasks: Task[], today: string): number[] {
  const end = endOfWeek(today);
  return Array.from({ length: 12 }, (_, index) => {
    const weekEnd = addDays(end, (index - 11) * 7);
    return tasks.filter((task) => {
      const created = (task.createdAt || "").slice(0, 10);
      if (!created || created > weekEnd) return false;
      if (task.completedAt && task.completedAt <= weekEnd) return false;
      if (task.parentId) return false;
      return true;
    }).length;
  });
}

export function heavyDayLine(days: { date: string; count: number }[], today: string): string | null {
  if (days.length === 0) return null;
  const sorted = days.map((day) => day.count).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const heavy = days.find((day) => day.count >= 3 && day.count >= mid + 2);
  if (!heavy) return null;
  const name = heavy.date === today ? "Today" : weekdayShort(heavy.date);
  return `${name} is heavier than your usual day.`;
}

export function checkInsDue(people: Person[], today: string): Person[] {
  return people.filter((person) => person.checkInOn !== null && person.checkInOn <= today);
}

export function meetingIsFinished(tasks: Task[], meetingId: string): boolean {
  const rows = tasks.filter((task) => task.meetingId === meetingId && !task.parentId);
  if (rows.length === 0) return false;
  return rows.every((task) => task.status === "done" || task.status === "set_aside");
}

export function tasksForView(
  tasks: Task[],
  today: string,
  view: { stale: boolean; tagId: string | null; personId: string | null },
): Task[] {
  return tasks.filter((task) => {
    if (view.stale && !isStale(task, today)) return false;
    if (view.tagId && !(task.tagIds ?? []).includes(view.tagId)) return false;
    if (view.personId && task.requesterId !== view.personId) return false;
    return true;
  });
}

export type Prep = {
  open: Task[];
  finishedSince: Task[];
  note: string;
  decisions: Decision[];
  questions: string[];
  nextFocus: string;
};

export function prepFor(data: Data, personId: string, today: string): Prep | null {
  const person = data.people.find((item) => item.id === personId);
  if (!person) return null;
  const last = lastMetMeeting(data.meetings, personId, today);
  const since = last?.meetingDate ?? "0000-00-00";
  const ids = meetingIdsForPerson(data.meetings, personId);
  return {
    open: data.tasks.filter((task) => isActive(task) && (ids.has(task.meetingId) || task.requesterId === personId)),
    finishedSince: data.tasks.filter(
      (task) =>
        task.status === "done" &&
        task.completedAt !== null &&
        task.completedAt >= since &&
        (ids.has(task.meetingId) || task.requesterId === personId),
    ),
    note: person.note,
    decisions: data.decisions.filter((item) => last && item.meetingId === last.id),
    questions: data.bullets
      .filter((bullet) => bullet.kind === "question" && last && bullet.ownerId === last.id && !bullet.done)
      .map((bullet) => bullet.body),
    nextFocus: last?.nextFocus ?? "",
  };
}

export function bucketLabel(bucket: Bucket): string {
  if (bucket === "overdue") return "Overdue";
  if (bucket === "today") return "Due today";
  if (bucket === "evening") return "This evening";
  if (bucket === "this_week") return "Due this week";
  if (bucket === "later") return "Later";
  return "No due date";
}

function csvCell(value: string): string {
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function boardText(data: Data, today: string): string {
  const groups = groupOpen(data.tasks, today);
  const lines = ["To-Do Tracker", today, ""];
  for (const bucket of ["overdue", "today", "evening", "this_week", "later", "none"] as Bucket[]) {
    const tasks = groups[bucket];
    if (tasks.length === 0) continue;
    lines.push(bucketLabel(bucket));
    for (const task of tasks) {
      lines.push(`- ${task.title} (${personName(data.people, task.requesterId)})`);
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

export function boardCsv(data: Data): string {
  const lines = ["Task,Person,Meeting,Asked,Due,Status,Priority,Notes"];
  for (const task of data.tasks) {
    const meeting = data.meetings.find((item) => item.id === task.meetingId);
    lines.push(
      [
        task.title,
        personName(data.people, task.requesterId),
        meeting?.title ?? "",
        task.requestedOn,
        task.dueOn ?? "",
        task.status,
        task.priority,
        task.notes,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function personOpenText(data: Data, personId: string, today: string): string {
  const person = data.people.find((item) => item.id === personId);
  const lines = [`Open tasks for ${person?.name ?? "someone"}`, today, ""];
  for (const task of data.tasks.filter((item) => isActive(item) && item.requesterId === personId)) {
    lines.push(`- ${task.title}${task.dueOn ? ` · due ${formatDay(task.dueOn, today)}` : ""}`);
  }
  return lines.join("\n").trim() + "\n";
}

export function meetingText(data: Data, meetingId: string, today: string): string {
  const meeting = data.meetings.find((item) => item.id === meetingId);
  if (!meeting) return "";
  const lines = [
    meeting.title,
    `${formatDay(meeting.meetingDate, today)} · ${personName(data.people, meeting.personId)}`,
    "",
  ];
  if (meeting.note) lines.push(meeting.note, "");
  for (const decision of data.decisions.filter((item) => item.meetingId === meetingId)) {
    lines.push(`Decision: ${decision.body}`);
  }
  for (const task of tasksForMeeting(data.tasks, meetingId)) {
    lines.push(`- ${task.title}${task.dueOn ? ` · due ${formatDay(task.dueOn, today)}` : ""}`);
  }
  return lines.join("\n").trim() + "\n";
}

export type AgendaEvent = {
  id: string;
  date: string;
  time: string;
  title: string;
  url: string;
  start?: string;
  end?: string;
  allDay?: boolean;
};

export async function agendaFromIcs(text: string, today: string, displayTimeZone?: string): Promise<AgendaEvent[]> {
  const { parseAgendaFromIcs } = await import("./calendar.ts");
  return parseAgendaFromIcs(text, today, displayTimeZone);
}

export function calendarEventMatches(meeting: Meeting, event: AgendaEvent): boolean {
  if (!meeting.calendarUid) return false;
  if (meeting.calendarUid === event.id) return true;
  const separator = event.id.lastIndexOf("::");
  if (separator < 0 || meeting.calendarUid !== event.id.slice(0, separator)) return false;
  return meeting.meetingDate === event.date;
}

export function personInTitle(people: Person[], title: string): Person | null {
  const hay = title.toLowerCase();
  return (
    people
      .filter((person) => person.name.trim().length > 1 && hay.includes(person.name.trim().toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

export function shortcutList(): { keys: string; does: string }[] {
  return [
    { keys: "⌘N", does: "Quick capture a note or task" },
    { keys: "⌘⇧N", does: "Quick capture from anywhere on this Mac" },
    { keys: "⌘⇧Y", does: "Hear what is due" },
    { keys: "⌘⇧V", does: "Save a copied line for the last person" },
    { keys: "⌘K", does: "Command menu" },
    { keys: "⌘F", does: "Search" },
    { keys: "⌘1", does: "Home" },
    { keys: "⌘2", does: "People" },
    { keys: "⌘3", does: "Review" },
    { keys: "⌘Z", does: "Undo" },
    { keys: "⌘⇧Z", does: "Redo" },
    { keys: "⌘P", does: "Print" },
    { keys: "J / K", does: "Move through the home list" },
    { keys: "[ / ]", does: "Move between home groups" },
  ];
}
