import { useEffect, useState, type DragEvent } from "react";
import type { TaskAction } from "./db";
import { TaskRow } from "./TaskRow";
import { ChipButton } from "./icons";
import { BarChart } from "./ui";
import type { CalEvent } from "./native";
import {
  bucketLabel,
  calendarEventMatches,
  checkInsDue,
  dayNumber,
  fiveWeeks,
  formatDay,
  groupOpen,
  heavyDayLine,
  isLongWait,
  isActive,
  addDays,
  isOnBoard,
  statusBars,
  tasksForHome,
  medianWait,
  nextSevenDays,
  oldestOpen,
  openByPerson,
  openSparkline,
  personName,
  swatch,
  tasksForView,
  waitingAge,
  weekdayShort,
  weekFlow,
  weekTotals,
  type Bucket,
  type Data,
  type Task,
} from "./logic";

function groupNote(bucket: Bucket): string {
  if (bucket === "overdue") return "The day for these has already passed.";
  if (bucket === "today") return "For today, before the day ends.";
  if (bucket === "evening") return "Still today, set for this evening.";
  if (bucket === "this_week") return "After today, and still this week.";
  if (bucket === "later") return "Further out than this week.";
  return "No day chosen yet. Drag one onto a day when you know it.";
}

type Props = {
  data: Data;
  today: string;
  events: CalEvent[];
  googleConnected: boolean;
  agendaError: string;
  onRefreshAgenda: () => void;
  onOpenAgenda: (event: CalEvent) => void;
  onOpenSettings: () => void;
  onOpenTask: (task: Task) => void;
  onOpenPerson: (personId: string) => void;
  onLog: (personId?: string) => void;
  onOpenDay?: (date: string) => void;
  onAction: (task: Task, action: TaskAction) => void;
  onCheckIn: (personId: string, kind: "snooze" | "dismiss") => void;
  onMorning: (keepIds: string[], moveIds: string[]) => void;
  onSaveView: (name: string, filter: { stale: boolean; tagId: string | null; personId: string | null }) => void;
  onDeleteView: (id: string) => void;
  onPrint: () => void;
  onExport: (kind: "text" | "csv") => void;
  onBulkDone: (ids: string[]) => void;
  onBulkDue: (ids: string[], dueOn: string) => void;
};

const GROUPS: { bucket: Bucket; id: string }[] = [
  { bucket: "overdue", id: "group-overdue" },
  { bucket: "today", id: "group-today" },
  { bucket: "this_week", id: "group-this-week" },
  { bucket: "later", id: "group-later" },
  { bucket: "none", id: "group-none" },
  { bucket: "evening", id: "group-evening" },
];

function dayMeta(tasks: number, meetings: number): string {
  const parts: string[] = [];
  if (tasks === 1) parts.push("1 task");
  else if (tasks > 1) parts.push(`${tasks} tasks`);
  if (meetings === 1) parts.push("1 meeting");
  else if (meetings > 1) parts.push(`${meetings} meetings`);
  return parts.join(" · ") || "—";
}

export function Dashboard({
  data,
  today,
  events,
  googleConnected,
  agendaError,
  onRefreshAgenda,
  onOpenAgenda,
  onOpenSettings,
  onOpenTask,
  onOpenPerson,
  onLog,
  onOpenDay,
  onAction,
  onCheckIn,
  onMorning,
  onSaveView,
  onDeleteView,
  onPrint,
  onExport,
  onBulkDone,
  onBulkDue,
}: Props) {
  const [filter, setFilter] = useState({ stale: false, tagId: null as string | null, personId: null as string | null });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkDate, setBulkDate] = useState(today);
  const [viewName, setViewName] = useState("");
  const [naming, setNaming] = useState(false);
  const [picks, setPicks] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [folded, setFolded] = useState<string[]>([]);

  const homeTasks = tasksForHome(data, today);
  const visible = tasksForView(homeTasks, today, filter);
  const groups = groupOpen(visible, today);
  const days = nextSevenDays(data.tasks, data.meetings, today);
  const totals = weekTotals(data.tasks, today);
  const peopleWaiting = openByPerson(data.tasks, data.people);
  const oldest = oldestOpen(data.tasks);
  const flow = weekFlow(data.tasks, today);
  const openCount = data.tasks.filter((task) => isOnBoard(task)).length;
  const median = medianWait(data.tasks);
  const spark = openSparkline(data.tasks, today);
  const sparkMax = Math.max(1, ...spark);
  const weeks = fiveWeeks(data.tasks, today);
  const weekMax = Math.max(1, ...weeks.map((day) => day.count));
  const heavy = heavyDayLine(days.map((day) => ({ date: day.date, count: day.tasks })), today);
  const checkIns = checkInsDue(data.people, today);
  const pinned = visible.filter((task) => task.pinned && isOnBoard(task));
  const longWait = visible.filter((task) => isLongWait(task, today));
  const morningPool = data.tasks.filter((task) => isOnBoard(task) && task.dueOn !== null && task.dueOn <= today);
  const showMorning = data.settings.morningDate !== today && morningPool.length > 3;
  const latest = [...data.meetings].sort(
    (a, b) => b.meetingDate.localeCompare(a.meetingDate) || b.createdAt.localeCompare(a.createdAt),
  )[0];
  const filtering = filter.stale || filter.tagId || filter.personId;

  const cards = [
    { id: "group-overdue", label: "Overdue", count: groups.overdue.length, late: groups.overdue.length > 0 },
    { id: "group-today", label: "Due today", count: groups.today.length, late: false },
    { id: "group-this-week", label: "Due this week", count: groups.this_week.length, late: false },
    { id: "group-none", label: "No due date", count: groups.none.length, late: false },
  ];

  function scrollTo(id: string, count: number) {
    if (count === 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  function dropDue(event: DragEvent, date: string) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/task-id");
    const task = data.tasks.find((item) => item.id === id);
    if (task) onAction(task, { type: "due", dueOn: date });
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-home-task]"));
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = Math.min(cursor + 1, Math.max(0, rows.length - 1));
        setCursor(next);
        rows[next]?.focus();
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = Math.max(cursor - 1, 0);
        setCursor(next);
        rows[next]?.focus();
      } else if (event.key === "]" || event.key === "[") {
        const ids = GROUPS.map((group) => group.id).filter((id) => document.getElementById(id));
        if (ids.length === 0) return;
        const current = ids.findIndex((id) => document.getElementById(id)?.contains(document.activeElement));
        const step = event.key === "]" ? 1 : -1;
        const next = ids[(current + step + ids.length) % ids.length];
        document.getElementById(next)?.scrollIntoView({ block: "start" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor]);

  function renderTask(task: Task) {
    return (
      <div
        key={task.id}
        className={
          task.blockedBy &&
          task.dueOn &&
          data.tasks.find((item) => item.id === task.blockedBy)?.dueOn &&
          task.dueOn < (data.tasks.find((item) => item.id === task.blockedBy)?.dueOn ?? "")
            ? "task-wrap clash"
            : data.meetings.some(
                  (meeting) =>
                    meeting.personId === task.requesterId && meeting.meetingDate > today && meeting.meetingDate <= addDays(today, 3),
                )
              ? "task-wrap soon"
              : "task-wrap"
        }
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("text/task-id", task.id);
          event.dataTransfer.effectAllowed = "move";
        }}
      >
        {selecting && (
          <label className="pick">
            <input
              type="checkbox"
              aria-label={`Select ${task.title}`}
              checked={selected.includes(task.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked ? [...current, task.id] : current.filter((id) => id !== task.id),
                )
              }
            />
          </label>
        )}
        <TaskRow
          task={task}
          people={data.people}
          meetings={data.meetings}
          today={today}
          editable={false}
          listed
          quick
          onDone={() => onAction(task, { type: "status", status: "done" })}
          onReopen={() => onAction(task, { type: "status", status: "open" })}
          onSetAside={() => onAction(task, { type: "status", status: "set_aside" })}
          onTitle={() => undefined}
          onDue={(dueOn) => onAction(task, { type: "due", dueOn })}
          onOpen={() => onOpenTask(task)}
          siblings={data.tasks}
          onAction={(action) => onAction(task, action)}
        />
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Home</h1>
          <p className="page-sub">Everything people have asked you to do.</p>
        </div>
        <div className="chips no-print">
          <ChipButton icon="print" tone="none" onClick={onPrint}>
            Print
          </ChipButton>
          <ChipButton icon="file" tone="day" onClick={() => onExport("text")}>
            Save as text
          </ChipButton>
          <ChipButton icon="sheet" tone="progress" onClick={() => onExport("csv")}>
            Spreadsheet
          </ChipButton>
        </div>
      </div>

      {checkIns.map((person) => (
        <section key={person.id} className="prompt">
          <p>
            Check in with {person.name}
            {person.checkInOn ? ` · ${formatDay(person.checkInOn, today)}` : ""}
          </p>
          <div className="chips">
            <ChipButton icon="plus" tone="progress" onClick={() => onLog(person.id)}>
              Log a meeting
            </ChipButton>
            <ChipButton icon="calendar" tone="week" onClick={() => onCheckIn(person.id, "snooze")}>
              Snooze a week
            </ChipButton>
            <ChipButton icon="check" tone="none" onClick={() => onCheckIn(person.id, "dismiss")}>
              Dismiss
            </ChipButton>
          </div>
        </section>
      ))}

      {showMorning && (
        <section className="prompt">
          <p>Pick three tasks for today. The rest of today’s list moves to tomorrow.</p>
          {morningPool.map((task) => (
            <label key={task.id} className="open-item">
              <input
                type="checkbox"
                checked={picks.includes(task.id)}
                onChange={(event) =>
                  setPicks((current) => {
                    if (!event.target.checked) return current.filter((id) => id !== task.id);
                    if (current.length >= 3) return current;
                    return [...current, task.id];
                  })
                }
              />
              <span>
                <span className="person-name">{task.title}</span>
                <span className="person-meta">Asked by {personName(data.people, task.requesterId)}</span>
              </span>
            </label>
          ))}
          <button
            type="button"
            className="primary"
            onClick={() => onMorning(picks, morningPool.map((task) => task.id).filter((id) => !picks.includes(id)))}
          >
            Keep these three
          </button>
        </section>
      )}

      <div className="counts">
        {cards.map((card) => (
          <button
            key={card.id}
            className={card.late ? "count-card late" : "count-card"}
            onClick={() => scrollTo(card.id, card.count)}
          >
            <span className="count-number">{card.count}</span>
            <span className="count-label">{card.late ? `Late · ${card.label}` : card.label}</span>
          </button>
        ))}
      </div>

      <div className="charts">
        <BarChart
          across
          title="Tasks due in the next seven days"
          rows={days.map((day) => ({ label: day.date === today ? "Today" : weekdayShort(day.date), count: day.tasks }))}
        />
        <BarChart title="How the work sits" rows={statusBars(data.tasks)} />
        <section className="card chart-card">
          <h2>Who is waiting</h2>
          <div className="hbars">
            {peopleWaiting.length === 0 && <p className="quiet">No open tasks are tied to a person yet.</p>}
            {peopleWaiting.map((row) => (
              <button key={row.person.id} className="hbar" onClick={() => onOpenPerson(row.person.id)}>
                <span className="hbar-name">{row.person.name}</span>
                <span className="hbar-track">
                  <span className="hbar-fill" style={{ width: `${(row.count / peopleWaiting[0].count) * 100}%`, display: "block" }} />
                </span>
                <span className="hbar-count">{row.count}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {data.tasks.some((task) => task.unfiled && isActive(task)) && (
        <p className="hint">{data.tasks.filter((task) => task.unfiled && isActive(task)).length} in the catch pile.</p>
      )}
      {data.tasks.some((task) => task.returned && isActive(task)) && (
        <section className="card">
          <h2>Back now</h2>
          {data.tasks
            .filter((task) => task.returned && isActive(task))
            .map((task) => (
              <button key={task.id} className="person-row" onClick={() => onOpenTask(task)}>
                <span className="person-name">{task.title}</span>
              </button>
            ))}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              for (const task of data.tasks.filter((item) => item.returned && isActive(item))) {
                onAction(task, { type: "patch", patch: { returned: false, wake: "" } });
              }
            }}
          >
            Put them back on the list
          </button>
        </section>
      )}

      {heavy && <p className="hint">{heavy}</p>}

      <section className="card">
        <div className="row-between"><h2>Meetings this week</h2><button type="button" className="text-button" onClick={onRefreshAgenda}>Refresh</button></div>
        {!googleConnected && <p className="quiet">Connect Google Calendar in Settings. The next seven days show up here, and each one can hold its notes.</p>}
        {googleConnected && agendaError && <p className="form-error">{agendaError}</p>}
        {googleConnected && !agendaError && events.length === 0 && <p className="quiet">Nothing is on the calendar for the next seven days.</p>}
        {!googleConnected && (
          <button type="button" className="primary" onClick={onOpenSettings}>
            Connect Google Calendar
          </button>
        )}
        <div className="people-list">
          {events.map((event) => {
            const linked = data.meetings.some((meeting) => calendarEventMatches(meeting, event));
            return (
              <button key={`${event.id}-${event.date}`} className="person-row" onClick={() => onOpenAgenda(event)}>
                <span className="person-name">
                  {event.time ? `${event.time} · ` : ""}
                  {event.title}
                </span>
                <span className="person-meta">
                  {event.date === today ? "Today" : formatDay(event.date, today)}
                  {linked ? " · Notes linked" : " · Write notes"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="week">
        <h2 className="section-label">The next seven days</h2>
        <div className="week-strip">
          {days.map((day) => {
            const people = data.tasks
              .filter((task) => isOnBoard(task) && task.dueOn === day.date)
              .map((task) => data.people.find((person) => person.id === task.requesterId))
              .filter((person): person is NonNullable<typeof person> => Boolean(person));
            const unique = [...new Map(people.map((person) => [person.id, person])).values()];
            const dayEvents = events.filter((event) => event.date === day.date);
            return (
              <div
                key={day.date}
                className={day.date === today ? "day today" : "day"}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => dropDue(event, day.date)}
                onClick={() => onOpenDay?.(day.date)}
              >
                <span className="day-name">{day.date === today ? "Today" : weekdayShort(day.date)}</span>
                <span className="day-number">{dayNumber(day.date)}</span>
                <span className="dots">
                  {unique.slice(0, 4).map((person) => (
                    <i key={person.id} style={{ background: swatch(person, data.people) }} />
                  ))}
                </span>
                <span className="day-meta">{dayMeta(day.tasks, day.meetings)}</span>
                {dayEvents.slice(0, 2).map((event) => (
                  <button
                    key={`${event.id}-${event.date}`}
                    type="button"
                    className="day-event"
                    onClick={(click) => {
                      click.stopPropagation();
                      onOpenAgenda(event);
                    }}
                  >
                    {event.title}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <p className="week-totals">
          {totals.map((total) => (
            <span key={total.label}>
              {total.label} · {total.count} due
            </span>
          ))}
        </p>
      </section>

      <section className="card">
        <h2>Five weeks</h2>
        <div className="cal">
          {weeks.map((day) => (
            <button
              key={day.date}
              type="button"
              className={day.date === today ? "cal-day today" : "cal-day"}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropDue(event, day.date)}
              onClick={() => onOpenDay?.(day.date)}
            >
              <span>{dayNumber(day.date)}</span>
              <span className="cal-count" style={{ opacity: day.count === 0 ? 0.35 : 0.35 + (day.count / weekMax) * 0.65 }}>
                {day.count}
              </span>
            </button>
          ))}
        </div>
      </section>

      {openCount > 0 && (
        <>
          <div className="split">
            <section className="card">
              <h2>Waiting the longest</h2>
              <div className="oldest">
                {oldest.map((task) => (
                  <button key={task.id} className="person-row" onClick={() => onOpenTask(task)}>
                    <span className="person-name">{task.title}</span>
                    <span className="person-meta">
                      {personName(data.people, task.requesterId)} · {waitingAge(task.requestedOn, today)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
            <section className="card">
              <h2>This week</h2>
              <p className="takeaway">
                {flow.asked} asked, {flow.finished} finished.
                {median !== null ? ` A typical request takes ${median} days.` : " The typical wait appears after five finished tasks."}
              </p>
              <div className="flow">
                <div>
                  <span className="flow-number">{flow.asked}</span>
                  <span className="flow-label">asked</span>
                </div>
                <div>
                  <span className="flow-number">{flow.finished}</span>
                  <span className="flow-label">finished</span>
                </div>
              </div>
              <p className="section-label">Open tasks, last twelve weeks</p>
              <svg className="spark" viewBox="0 0 120 36" role="img" aria-label="Open tasks over twelve weeks">
                <polyline
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  points={spark
                    .map((count, index) => `${index * (120 / 11)},${34 - (count / sparkMax) * 30}`)
                    .join(" ")}
                />
              </svg>
            </section>
          </div>
        </>
      )}

      {longWait.length > 0 && (
        <section className="section" id="group-long">
          <div className="section-head">
            <h2 className="section-title">
              Waiting a long time
              <span className="quiet"> · {longWait.length}</span>
            </h2>
            <p className="section-note">Open for a long while. Separate from the day groups below.</p>
          </div>
          {longWait.map((task) => (
            <button key={task.id} className="person-row" onClick={() => onOpenTask(task)}>
              <span className="person-name">{task.title}</span>
              <span className="person-meta">
                {personName(data.people, task.requesterId)} · {waitingAge(task.requestedOn, today)}
              </span>
            </button>
          ))}
        </section>
      )}

      {openCount === 0 && !latest && (
        <div className="empty">
          <p>No open tasks. Log a meeting and its tasks appear here, sorted by due date.</p>
          <button className="primary" onClick={() => onLog()}>
            Log a meeting
          </button>
        </div>
      )}

      {openCount === 0 && latest && (
        <div className="caught-up">
          <p>All caught up. Nothing is due.</p>
          <p className="quiet">
            Last meeting logged: {formatDay(latest.meetingDate, today)}, with {personName(data.people, latest.personId)}.
          </p>
          <button className="text-button" onClick={() => onLog()}>
            Log a meeting
          </button>
        </div>
      )}

      <div className="filters no-print">
        <button
          type="button"
          className={filter.stale ? "chip selected" : "chip"}
          onClick={() => setFilter((current) => ({ ...current, stale: !current.stale }))}
        >
          Unchanged for two weeks
        </button>
        <button type="button" className={selecting ? "chip selected" : "chip"} onClick={() => setSelecting((value) => !value)}>
          Select several
        </button>
        {data.tags.length > 0 && (
          <select
            aria-label="Tag"
            value={filter.tagId ?? ""}
            onChange={(event) => setFilter((current) => ({ ...current, tagId: event.target.value || null }))}
          >
            <option value="">Any tag</option>
            {data.tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        )}
        {data.views.map((view) => (
          <span key={view.id} className="view-chip">
            <button
              type="button"
              className="chip"
              onClick={() => setFilter({ stale: view.stale, tagId: view.tagId, personId: view.personId })}
            >
              {view.name}
            </button>
            <button type="button" className="text-button" aria-label={`Remove view ${view.name}`} onClick={() => onDeleteView(view.id)}>
              ×
            </button>
          </span>
        ))}
        {filtering && !naming && (
          <button type="button" className="chip" onClick={() => setNaming(true)}>
            Save this view
          </button>
        )}
        {naming && (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveView(viewName, filter);
              setViewName("");
              setNaming(false);
            }}
          >
            <input aria-label="View name" value={viewName} onChange={(event) => setViewName(event.target.value)} />
            <button className="text-button" type="submit">
              Save
            </button>
          </form>
        )}
      </div>

      {selecting && selected.length > 0 && (
        <div className="bulk-bar">
          <button
            type="button"
            className="chip"
            onClick={() => {
              onBulkDone(selected);
              setSelected([]);
            }}
          >
            Mark selected done
          </button>
          <label className="chip">
            Move to
            <input className="sr-only" type="date" value={bulkDate} onChange={(event) => setBulkDate(event.target.value)} />
          </label>
          <button
            type="button"
            className="chip"
            onClick={() => {
              onBulkDue(selected, bulkDate);
              setSelected([]);
            }}
          >
            Apply date
          </button>
        </div>
      )}

      {pinned.length > 0 && (
        <section className="section" id="group-pinned">
          <div className="section-head">
            <h2 className="section-title">Pinned</h2>
            <p className="section-note">Kept at the top, apart from the days below.</p>
          </div>
          {pinned.map(renderTask)}
        </section>
      )}

      {GROUPS.map((group) => {
        const soonPeople = new Set(
          data.meetings
            .filter((meeting) => meeting.meetingDate > today && meeting.meetingDate <= addDays(today, 3))
            .map((meeting) => meeting.personId),
        );
        const tasks = groups[group.bucket]
          .filter((task) => !task.pinned)
          .sort((a, b) => Number(soonPeople.has(b.requesterId)) - Number(soonPeople.has(a.requesterId)));
        if (tasks.length === 0) return null;
        return (
          <section key={group.id} id={group.id} className={group.bucket === "evening" ? "section evening-group" : "section"}>
            <div className="section-head">
              <button
                type="button"
                className="section-title fold"
                onClick={() => setFolded((current) => (current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id]))}
              >
                {group.bucket === "none" ? "No due date" : bucketLabel(group.bucket)}
                <span className="quiet"> · {tasks.length}</span>
              </button>
              <p className="section-note">{groupNote(group.bucket)}</p>
            </div>
            {group.bucket === "none" && !folded.includes(group.id) && <p className="quiet">Drag one of these onto a day.</p>}
            {!folded.includes(group.id) && tasks.map(renderTask)}
          </section>
        );
      })}
    </>
  );
}

