import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  addDays,
  findPersonByName,
  personInTitle,
  type AgendaEvent,
  formatDay,
  openTasksForPerson,
  readDateInTitle,
  todayISO,
  type Data,
  type Person,
  type RepeatRule,
} from "./logic";
import type { NewTaskInput, SaveMeetingInput } from "./db";
import { BulletList, DueChips, linesFromText, type Line } from "./ui";

const DRAFT_KEY = "todo-tracker.meeting-draft";

type Row = {
  key: string;
  title: string;
  requesterId: string;
  dueOn: string | null;
  keptWords: boolean;
  dateTouched: boolean;
  evening: boolean;
  repeatRule: RepeatRule;
  indent: number;
  owner: "mine" | "theirs";
  durationMin: number;
  doOn: string | null;
  clockTime: string;
  sourceLine: string;
};

type Draft = {
  saveId: string;
  personText: string;
  personId: string | null;
  title: string;
  meetingDate: string;
  note: string;
  noteLines: Line[];
  topicLines: Line[];
  questionLines: Line[];
  privateNote: string;
  nextOn: string;
  nextFocus: string;
  spanEnd: string;
  sourceUrl: string;
  calendarUid: string;
  rows: Row[];
  markDoneIds: string[];
  guestIds: string[];
  decisionText: string;
  submittedSave?: { fingerprint: string; input: SaveMeetingInput };
};

type Props = {
  data: Data;
  presetPersonId: string | null;
  presetDate?: string | null;
  presetEvent?: AgendaEvent | null;
  agenda?: AgendaEvent[];
  travelDates?: string[];
  busy: boolean;
  stayOpen: boolean;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  onSave: (input: SaveMeetingInput) => Promise<void>;
  onSaveTemplate: (name: string, lines: string[]) => void;
  onDeleteTemplate: (id: string) => void;
  draftStorageKey?: string;
};

function explain(caught: unknown): string {
  if (caught instanceof Error && caught.message) return caught.message;
  if (typeof caught === "string" && caught) return caught;
  try {
    const text = JSON.stringify(caught);
    if (text && text !== "{}") return text;
  } catch {
    // Fall through to the plain sentence below.
  }
  return "Could not save the meeting.";
}

function blankRow(): Row {
  return {
    key: crypto.randomUUID(),
    title: "",
    requesterId: "",
    dueOn: null,
    keptWords: false,
    dateTouched: false,
    evening: false,
    repeatRule: null,
    indent: 0,
    owner: "mine",
    durationMin: 0,
    doOn: null,
    clockTime: "",
    sourceLine: "",
  };
}

function readDraft(storageKey = DRAFT_KEY): Draft | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    return {
      saveId: typeof parsed.saveId === "string" && parsed.saveId ? parsed.saveId : crypto.randomUUID(),
      personText: parsed.personText ?? "",
      personId: parsed.personId ?? null,
      title: parsed.title ?? "",
      meetingDate: parsed.meetingDate || todayISO(),
      note: parsed.note ?? "",
      noteLines: parsed.noteLines?.length ? parsed.noteLines : linesFromText(parsed.note ?? ""),
      topicLines: parsed.topicLines?.length ? parsed.topicLines : [{ key: crypto.randomUUID(), text: "", indent: 0 }],
      questionLines: parsed.questionLines?.length ? parsed.questionLines : [{ key: crypto.randomUUID(), text: "", indent: 0 }],
      privateNote: parsed.privateNote ?? "",
      nextOn: parsed.nextOn ?? "",
      nextFocus: parsed.nextFocus ?? "",
      spanEnd: parsed.spanEnd ?? "",
      sourceUrl: parsed.sourceUrl ?? "",
      calendarUid: parsed.calendarUid ?? "",
      rows: parsed.rows.map((row) => ({
        key: row.key || crypto.randomUUID(),
        title: row.title ?? "",
        requesterId: row.requesterId ?? "",
        dueOn: row.dueOn ?? null,
        keptWords: Boolean(row.keptWords),
        dateTouched: Boolean(row.dateTouched),
        evening: Boolean(row.evening),
        repeatRule: row.repeatRule ?? null,
        indent: row.indent ?? 0,
        owner: row.owner === "theirs" ? "theirs" : "mine",
        durationMin: row.durationMin ?? 0,
        doOn: row.doOn ?? null,
        clockTime: row.clockTime ?? "",
        sourceLine: row.sourceLine ?? "",
      })),
      markDoneIds: Array.isArray(parsed.markDoneIds) ? parsed.markDoneIds : [],
      guestIds: Array.isArray(parsed.guestIds) ? parsed.guestIds : [],
      decisionText: parsed.decisionText ?? "",
      ...(parsed.submittedSave && typeof parsed.submittedSave.fingerprint === "string" && parsed.submittedSave.input && typeof parsed.submittedSave.input === "object"
        ? { submittedSave: parsed.submittedSave as Draft["submittedSave"] }
        : {}),
    };
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft | null, storageKey = DRAFT_KEY) {
  try {
    if (!draft) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    // A draft is only a convenience. Saving the meeting still works.
  }
}

function hasContent(draft: Draft, presetName: string): boolean {
  const typedPerson = draft.personText.trim() !== "" && draft.personText.trim() !== presetName;
  return Boolean(
    draft.title.trim() ||
      draft.noteLines.some((line) => line.text.trim()) ||
      draft.note.trim() ||
      draft.topicLines.some((line) => line.text.trim()) ||
      draft.questionLines.some((line) => line.text.trim()) ||
      draft.privateNote.trim() ||
      draft.nextOn.trim() ||
      draft.nextFocus.trim() ||
      draft.spanEnd.trim() ||
      draft.sourceUrl.trim() ||
      typedPerson ||
      draft.markDoneIds.length > 0 ||
      draft.guestIds.length > 0 ||
      draft.decisionText.trim() !== "" ||
      draft.rows.some((row) => row.title.trim() || row.dueOn || row.requesterId),
  );
}

function draftFingerprint(draft: Draft): string {
  const { saveId: _saveId, submittedSave: _submittedSave, ...authored } = draft;
  const withoutLineKeys = (lines: Line[]) => lines
    .filter((line) => line.text.trim())
    .map(({ key: _key, ...line }) => line);
  const rows = authored.rows
    .filter((row) => row.title.trim())
    .map(({ key: _key, ...row }) => row);
  return JSON.stringify({
    ...authored,
    noteLines: withoutLineKeys(authored.noteLines),
    topicLines: withoutLineKeys(authored.topicLines),
    questionLines: withoutLineKeys(authored.questionLines),
    rows,
  });
}

function initialDraft(
  people: Person[],
  presetPersonId: string | null,
  presetDate: string | null,
  travelDates: string[],
  presetEvent: AgendaEvent | null,
  draftStorageKey = DRAFT_KEY,
): { draft: Draft; restored: boolean } {
  const preset = people.find((person) => person.id === presetPersonId) ?? null;
  const saved = readDraft(draftStorageKey);
  if (presetEvent) {
    if (saved && hasContent(saved, preset?.name ?? "")) {
      return { draft: { ...saved, rows: saved.rows.length > 0 ? saved.rows : [blankRow(), blankRow()] }, restored: true };
    }
    return {
      restored: false,
      draft: {
        saveId: crypto.randomUUID(),
        personText: preset?.name ?? "",
        personId: preset?.id ?? null,
        title: presetEvent.title,
        meetingDate: presetEvent.date,
        note: "",
        noteLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
        topicLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
        questionLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
        privateNote: "",
        nextOn: "",
        nextFocus: "",
        spanEnd: "",
        sourceUrl: presetEvent.url,
        calendarUid: presetEvent.id,
        rows: [blankRow(), blankRow()],
        markDoneIds: [],
        guestIds: [],
        decisionText: "",
      },
    };
  }
  if (saved && hasContent(saved, preset?.name ?? "")) {
    const rows = saved.rows.length > 0 ? saved.rows : [blankRow(), blankRow()];
    return { draft: { ...saved, rows }, restored: true };
  }
  let meetingDate = presetDate || todayISO();
  if (travelDates.includes(meetingDate)) meetingDate = addDays(meetingDate, 1);
  return {
    restored: false,
    draft: {
      saveId: crypto.randomUUID(),
      personText: preset?.name ?? "",
      personId: preset?.id ?? null,
      title: "",
      meetingDate,
      note: "",
      noteLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
      topicLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
      questionLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
      privateNote: "",
      nextOn: "",
      nextFocus: "",
      spanEnd: "",
      sourceUrl: "",
      calendarUid: "",
      rows: [blankRow(), blankRow()],
      markDoneIds: [],
      guestIds: [],
      decisionText: "",
    },
  };
}

export function MeetingSheet({
  data,
  presetPersonId,
  presetDate = null,
  presetEvent = null,
  agenda = [],
  travelDates = [],
  busy,
  stayOpen,
  onDirty,
  onClose,
  onSave,
  onSaveTemplate,
  onDeleteTemplate,
  draftStorageKey = DRAFT_KEY,
}: Props) {
  const today = todayISO();
  const starting = initialDraft(data.people, presetPersonId, presetDate, travelDates, presetEvent, draftStorageKey);
  const [draft, setDraft] = useState<Draft>(starting.draft);
  const [restored, setRestored] = useState(starting.restored);
  const [recoveredFor, setRecoveredFor] = useState(
    starting.restored ? { calendarUid: starting.draft.calendarUid, meetingDate: starting.draft.meetingDate } : null,
  );
  const [showRest, setShowRest] = useState(starting.restored || Boolean(presetEvent));
  const [speechNote, setSpeechNote] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState("");
  const [recoveryKind, setRecoveryKind] = useState<"payload-mismatch" | "unverifiable-receipt" | null>(null);
  const [templateName, setTemplateName] = useState("");
  const savedRef = useRef(false);
  const savingRef = useRef(false);
  const titleRefs = useRef<Array<HTMLInputElement | null>>([]);
  const presetName = data.people.find((person) => person.id === presetPersonId)?.name ?? "";

  useEffect(() => {
    if (savedRef.current) return;
    const shouldKeepDraft = hasContent(draft, presetName) || Boolean(draft.calendarUid);
    writeDraft(shouldKeepDraft ? draft : null, draftStorageKey);
    onDirty(shouldKeepDraft);
  }, [draft, draftStorageKey, onDirty, presetName]);

  useEffect(() => {
    if (!draft.personId) return;
    if (draft.topicLines.some((line) => line.text.trim())) return;
    const owned = data.bullets.filter(
      (bullet) =>
        bullet.kind === "topic" &&
        !bullet.done &&
        (bullet.ownerId === draft.personId ||
          data.meetings.some((meeting) => meeting.personId === draft.personId && meeting.id === bullet.ownerId)),
    );
    if (owned.length === 0) return;
    patch({
      topicLines: owned.map((bullet) => ({ key: bullet.id, text: bullet.body, indent: bullet.indent })),
    });
  }, [data.bullets, data.meetings, draft.personId, draft.topicLines]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy && !savingRef.current) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const resolved =
    findPersonByName(data.people, draft.personText) ??
    data.people.find((person) => person.id === draft.personId) ??
    null;
  const openTasks = resolved ? openTasksForPerson(data.tasks, data.meetings, resolved.id) : [];
  const query = draft.personText.trim().toLowerCase();
  const lastId = data.settings.lastPersonId;
  const matches = (query
    ? data.people.filter((person) => person.name.toLowerCase().includes(query))
    : data.people
  )
    .slice()
    .sort((a, b) => {
      if (a.id === lastId) return -1;
      if (b.id === lastId) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 6);
  const exact = findPersonByName(data.people, draft.personText);

  function patch(partial: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  function setRow(key: string, partial: Partial<Row>) {
    setDraft((current) => ({
      ...current,
      rows: current.rows.map((row) => (row.key === key ? { ...row, ...partial } : row)),
    }));
  }

  function chooseDue(key: string, dueOn: string | null) {
    setRow(key, { dueOn, dateTouched: true });
  }

  async function save(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    if (busy || savingRef.current) return;
    const match = findPersonByName(data.people, draft.personText);
    const id = match?.id ?? null;
    const newName = id ? null : draft.personText.trim();
    if (!id && !newName) {
      setError("Add the person you met with.");
      return;
    }
    if (!draft.title.trim()) {
      setError("Add the meeting name.");
      return;
    }
    if (!draft.meetingDate) {
      setError("Add the meeting date.");
      return;
    }
    const tasks: NewTaskInput[] = draft.rows
      .filter((row) => row.title.trim())
      .map((row) => {
        const reading = !row.keptWords && !row.dateTouched ? readDateInTitle(row.title, today) : null;
        return {
          title: reading ? reading.title : row.title.trim(),
          requesterId: row.requesterId || null,
          dueOn: row.dueOn ?? reading?.date ?? null,
          evening: row.evening || Boolean(reading?.evening),
          repeatRule: row.repeatRule,
          indent: row.indent,
          owner: row.owner,
          durationMin: row.durationMin,
          doOn: row.doOn,
          clockTime: row.clockTime,
          sourceLine: row.sourceLine,
        };
      });
    const decisionLines = draft.decisionText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const decisions: string[] = [];
    const decisionWhys: string[] = [];
    for (const line of decisionLines) {
      if (/^why:/i.test(line) && decisions.length > 0) decisionWhys[decisions.length - 1] = line.replace(/^why:\s*/i, "");
      else {
        decisions.push(line);
        decisionWhys.push("");
      }
    }
    const note = draft.noteLines
      .map((line) => `${"  ".repeat(line.indent)}${line.text.trim()}`)
      .filter((line) => line.trim())
      .join("\n");
    const fingerprint = draftFingerprint(draft);
    const cachedInput = draft.submittedSave?.fingerprint === fingerprint ? draft.submittedSave.input : null;
    const input: SaveMeetingInput = cachedInput
      ? { ...cachedInput, saveId: draft.saveId }
      : {
          personId: id,
          newPersonName: newName,
          title: draft.title,
          meetingDate: draft.meetingDate,
          note,
          noteLines: draft.noteLines,
          topics: draft.topicLines,
          questions: draft.questionLines,
          privateNote: draft.privateNote,
          nextOn: draft.nextOn || null,
          nextFocus: draft.nextFocus,
          spanEnd: draft.spanEnd || null,
          sourceUrl: draft.sourceUrl,
          calendarUid: draft.calendarUid,
          saveId: draft.saveId,
          tasks,
          markDoneIds: draft.markDoneIds.filter((taskId) => openTasks.some((task) => task.id === taskId)),
          guestIds: draft.guestIds,
          decisions,
          decisionWhys,
        };
    const submittedDraft = { ...draft, submittedSave: { fingerprint, input } };
    setDraft(submittedDraft);
    writeDraft(submittedDraft, draftStorageKey);
    setError("");
    setRecoveryKind(null);
    savingRef.current = true;
    try {
      await onSave(input);
      setRecoveryKind(null);
      setRestored(false);
      setRecoveredFor(null);
      if (stayOpen) {
        const cleared = {
          ...draft,
          saveId: crypto.randomUUID(),
          submittedSave: undefined,
          title: "",
          note: "",
          noteLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
          topicLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
          questionLines: [{ key: crypto.randomUUID(), text: "", indent: 0 }],
          privateNote: "",
          decisionText: "",
          rows: [blankRow(), blankRow()],
          markDoneIds: [],
        };
        setDraft(cleared);
        writeDraft(null, draftStorageKey);
      } else {
        savedRef.current = true;
        writeDraft(null, draftStorageKey);
      }
    } catch (caught) {
      setError(explain(caught));
      if (caught && typeof caught === "object" && "recoveryKind" in caught) {
        const kind = (caught as { recoveryKind?: unknown }).recoveryKind;
        setRecoveryKind(kind === "payload-mismatch" || kind === "unverifiable-receipt" ? kind : null);
      } else {
        setRecoveryKind(null);
      }
    } finally {
      savingRef.current = false;
    }
  }

  function prepareNewSaveAttempt() {
    setDraft((current) => ({ ...current, saveId: crypto.randomUUID() }));
    setRecoveryKind(null);
    setError("A new save attempt is ready. Select Save meeting to retry.");
  }

  function discard() {
    if (busy || savingRef.current) return;
    savedRef.current = true;
    writeDraft(null, draftStorageKey);
    onClose();
  }

  function onTaskKey(event: ReactKeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key === "Tab") {
      event.preventDefault();
      const row = draft.rows[index];
      setRow(row.key, { indent: Math.max(0, Math.min(6, row.indent + (event.shiftKey ? -1 : 1))) });
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (index === draft.rows.length - 1) {
      patch({ rows: [...draft.rows, blankRow()] });
    }
    window.setTimeout(() => titleRefs.current[index + 1]?.focus(), 0);
  }

  return (
    <div className="overlay" onMouseDown={() => { if (!busy && !savingRef.current) onClose(); }}>
      <form
        className="sheet"
        inert={busy}
        aria-busy={busy}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void save(event)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void save();
          }
          if (event.key !== "Tab") return;
          const root = event.currentTarget;
          const items = Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select, button")).filter(
            (item) => item.tabIndex >= 0 && !item.hasAttribute("disabled"),
          );
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2>{draft.calendarUid ? draft.title || "Meeting notes" : "New meeting"}</h2>
        {agenda.length > 0 && (
          <div className="field">
            <span>Meetings this week</span>
            <div className="chips">
              {agenda.map((event) => (
                <button
                  key={`${event.id}-${event.date}`}
                  type="button"
                  className={draft.calendarUid === event.id && draft.meetingDate === event.date ? "chip selected" : "chip"}
                  onClick={() => {
                    if (recoveredFor && (event.id !== recoveredFor.calendarUid || event.date !== recoveredFor.meetingDate)) {
                      setError("Finish saving or discard the recovered meeting draft before choosing another calendar event.");
                      return;
                    }
                    setError("");
                    const person = personInTitle(data.people, event.title);
                    patch({
                      title: event.title,
                      meetingDate: event.date,
                      sourceUrl: event.url,
                      calendarUid: event.id,
                      ...(person ? { personText: person.name, personId: person.id } : {}),
                    });
                    setShowRest(true);
                  }}
                >
                  {event.time ? `${event.time} ` : ""}
                  {event.date === today ? "Today" : formatDay(event.date, today)} · {event.title}
                </button>
              ))}
            </div>
          </div>
        )}
        {restored && <p className="hint">Picking up where you left off.</p>}
        {recoveredFor && presetEvent && (recoveredFor.calendarUid !== presetEvent.id || recoveredFor.meetingDate !== presetEvent.date) && (
          <p className="hint">A saved draft is open. This calendar event stays unselected until you save or discard that draft.</p>
        )}
        {!showRest && (
          <p className="hint">
            Start with the note. The person, the date, and the tasks appear when you leave it.{" "}
            <button type="button" className="text-button" onClick={() => setShowRest(true)}>
              Show them now
            </button>
          </p>
        )}
        {showRest && (
        <>
        <label className="field">
          <span>Person</span>
          <input
            value={draft.personText}
            placeholder="Who did you meet?"
            autoComplete="off"
            autoFocus={!draft.personId}
            aria-expanded={suggesting}
            onFocus={() => setSuggesting(true)}
            onBlur={() => window.setTimeout(() => setSuggesting(false), 120)}
            onChange={(event) => {
              const value = event.target.value;
              const match = findPersonByName(data.people, value);
              patch({ personText: value, personId: match?.id ?? null });
              setSuggesting(true);
            }}
          />
          {suggesting && (matches.length > 0 || (query && !exact)) && (
            <div className="suggestions">
              {matches.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  className="suggestion"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    patch({ personText: person.name, personId: person.id });
                    setSuggesting(false);
                  }}
                >
                  {person.name}
                  {person.id === lastId ? " · last time" : ""}
                </button>
              ))}
              {query && !exact && (
                <button
                  type="button"
                  className="suggestion"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    patch({ personText: draft.personText.trim(), personId: null });
                    setSuggesting(false);
                  }}
                >
                  Add {draft.personText.trim()}
                </button>
              )}
            </div>
          )}
        </label>

        <label className="field">
          <span>Meeting</span>
          <input
            value={draft.title}
            placeholder="What did you meet about?"
            autoFocus={Boolean(draft.personId)}
            onChange={(event) => patch({ title: event.target.value })}
          />
        </label>

        <label className="field">
          <span>Date</span>
          <input
            type="date"
            value={draft.meetingDate}
            onChange={(event) => patch({ meetingDate: event.target.value })}
          />
        </label>

        {data.templates.length > 0 && (
          <label className="field">
            <span>Template</span>
            <select
              value=""
              onChange={(event) => {
                const template = data.templates.find((item) => item.id === event.target.value);
                if (!template) return;
                patch({
                  rows: template.lines.map((line) => ({ ...blankRow(), title: line })),
                });
              }}
            >
              <option value="">Use a template</option>
              {data.templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <div className="chips">
              {data.templates.map((template) => (
                <button key={template.id} type="button" className="text-button" onClick={() => onDeleteTemplate(template.id)}>
                  Remove {template.name}
                </button>
              ))}
            </div>
          </label>
        )}

        {data.people.length > 1 && (
          <fieldset className="field">
            <legend>Also there</legend>
            <div className="chips">
              {data.people
                .filter((person) => person.id !== resolved?.id)
                .map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className={draft.guestIds.includes(person.id) ? "chip selected" : "chip"}
                    onClick={() =>
                      patch({
                        guestIds: draft.guestIds.includes(person.id)
                          ? draft.guestIds.filter((id) => id !== person.id)
                          : [...draft.guestIds, person.id],
                      })
                    }
                  >
                    {person.name}
                  </button>
                ))}
            </div>
          </fieldset>
        )}
        </>
        )}

        <div
          className="field"
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (!next || !event.currentTarget.contains(next)) setShowRest(true);
          }}
        >
          <span className="section-label">Notes</span>
          <p className="hint">Notes stay notes. Tab indents a line. Shift-Tab pulls it back. Enter adds the next line.</p>
          <BulletList
            label="Meeting notes"
            placeholder="A note from the meeting"
            lines={draft.noteLines}
            onChange={(noteLines) => patch({ noteLines })}
          />
          <button
            type="button"
            className="text-button"
            onClick={() => {
              const Speech = (window as unknown as { webkitSpeechRecognition?: new () => { start: () => void; onresult: ((event: { results: { 0: { 0: { transcript: string } } } }) => void) | null } }).webkitSpeechRecognition;
              if (!Speech) {
                setSpeechNote("This Mac did not offer dictation here. Type the note, or turn Dictation on in Keyboard settings.");
                return;
              }
              setSpeechNote("Listening…");
              const heard = new Speech();
              heard.onresult = (event) => {
                const text = event.results[0][0].transcript;
                patch({ noteLines: [...draft.noteLines, { key: crypto.randomUUID(), text, indent: 0 }] });
              };
              heard.start();
            }}
          >
            Speak a note
          </button>
          {speechNote && <p className="hint">{speechNote}</p>}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              const line = [...draft.noteLines].reverse().find((item) => item.text.trim());
              if (!line) return;
              patch({
                rows: [...draft.rows, { ...blankRow(), title: line.text.trim(), indent: line.indent, sourceLine: line.text.trim() }],
              });
              setShowRest(true);
            }}
          >
            Make the last note a task
          </button>
        </div>

        {openTasks.length > 0 && (
          <section className="open-list">
            <h3 className="section-label">Still open with {resolved?.name}</h3>
            <p className="hint">Mark anything that is finished, then add what was asked today.</p>
            {openTasks.map((task) => (
              <label key={task.id} className="open-item">
                <input
                  type="checkbox"
                  checked={draft.markDoneIds.includes(task.id)}
                  onChange={(event) => {
                    patch({
                      markDoneIds: event.target.checked
                        ? [...draft.markDoneIds, task.id]
                        : draft.markDoneIds.filter((id) => id !== task.id),
                    });
                  }}
                />
                <span>
                  {task.title}
                  <span className="ask">
                    {task.dueOn ? `Due ${formatDay(task.dueOn, today).toLowerCase()}` : "No due date"}
                  </span>
                </span>
              </label>
            ))}
          </section>
        )}

        <details className="more-block">
          <summary>More about this meeting</summary>
          <label className="field">
            <span>Decisions</span>
            <textarea
              value={draft.decisionText}
              placeholder="One decision per line. Add why on the next line if you want."
              onChange={(event) => patch({ decisionText: event.target.value })}
            />
          </label>
          <div className="field">
            <span className="section-label">Topics to talk about</span>
            <BulletList label="Topics" placeholder="A topic, not a task" lines={draft.topicLines} onChange={(topicLines) => patch({ topicLines })} />
          </div>
          <div className="field">
            <span className="section-label">Questions still open</span>
            <BulletList label="Questions" placeholder="Something the meeting did not settle" lines={draft.questionLines} onChange={(questionLines) => patch({ questionLines })} />
          </div>
          <label className="field">
            <span>Private note</span>
            <textarea value={draft.privateNote} placeholder="Only for you. Left out of the brief and of files you save." onChange={(event) => patch({ privateNote: event.target.value })} />
          </label>
          <label className="field">
            <span>Next meeting date</span>
            {draft.nextOn ? (
              <input type="date" value={draft.nextOn} onChange={(event) => patch({ nextOn: event.target.value })} />
            ) : (
              <button type="button" className="chip" onClick={() => patch({ nextOn: addDays(today, 7) })}>
                Set the next meeting
              </button>
            )}
          </label>
          <label className="field">
            <span>What the next meeting should cover</span>
            <input value={draft.nextFocus} onChange={(event) => patch({ nextFocus: event.target.value })} />
          </label>
          <label className="field">
            <span>This meeting covers until</span>
            {draft.spanEnd ? (
              <input type="date" value={draft.spanEnd} onChange={(event) => patch({ spanEnd: event.target.value })} />
            ) : (
              <button type="button" className="chip" onClick={() => patch({ spanEnd: addDays(draft.meetingDate || today, 1) })}>
                It covers more than one day
              </button>
            )}
          </label>
          <label className="field">
            <span>Link back to the mail or page</span>
            <input value={draft.sourceUrl} placeholder="https://" onChange={(event) => patch({ sourceUrl: event.target.value })} />
          </label>
        </details>

        <h3 className="section-label">Tasks from this meeting</h3>
        <div className="chips drop-days">
          {Array.from({ length: 7 }, (_, offset) => addDays(today, offset)).map((date) => (
            <button
              key={date}
              type="button"
              className={draft.meetingDate === date ? "chip selected" : "chip"}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const key = event.dataTransfer.getData("text/task-key");
                if (key) setRow(key, { dueOn: date, dateTouched: true });
              }}
              onClick={() => patch({ meetingDate: date })}
            >
              {date === today ? "Today" : formatDay(date, today)}
            </button>
          ))}
        </div>
        {draft.rows.map((row, index) => {
          return (
            <div className="task-draft" key={row.key}>
              <div className="bullet-row" style={{ paddingLeft: row.indent * 22 }}>
              <span className="bullet-mark" aria-hidden="true">•</span>
              <input
                type="text"
                placeholder="What needs doing?"
                value={row.title}
                ref={(node) => {
                  titleRefs.current[index] = node;
                }}
                onChange={(event) => setRow(row.key, { title: event.target.value, keptWords: false })}
                onKeyDown={(event) => onTaskKey(event, index)}
              />
              </div>
              {(() => {
                const reading = !row.keptWords && !row.dateTouched ? readDateInTitle(row.title, today) : null;
                if (!reading) return null;
                return (
                  <p
                    className="hint"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/due-preview", reading.date);
                      event.dataTransfer.setData("text/task-key", row.key);
                    }}
                  >
                    Read as due {formatDay(reading.date, today)}
                    {reading.evening ? ", this evening" : ""}. Drag this line onto a day.{" "}
                    <button type="button" className="text-button" onClick={() => setRow(row.key, { keptWords: true })}>
                      Keep the words
                    </button>
                  </p>
                );
              })()}
              <div className="who-row">
                <label>
                  <span className="sr-only">Who asked</span>
                  <select
                    aria-label="Who asked"
                    value={row.requesterId}
                    onChange={(event) => setRow(row.key, { requesterId: event.target.value })}
                  >
                    <option value="">{resolved ? resolved.name : "Person in this meeting"}</option>
                    {data.people
                      .filter((person) => person.id !== resolved?.id)
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                  </select>
                </label>
                <DueChips dueOn={row.dueOn} today={today} index={index} onChoose={(dueOn) => chooseDue(row.key, dueOn)} />
                <div className="chips">
                  {row.doOn ? (
                    <label>
                      <span className="sr-only">Do this on</span>
                      <input
                        type="date"
                        aria-label={`Do task ${index + 1} on`}
                        value={row.doOn}
                        onChange={(event) => setRow(row.key, { doOn: event.target.value || null })}
                      />
                    </label>
                  ) : (
                    <button type="button" className="chip" onClick={() => setRow(row.key, { doOn: today })}>
                      Day I'll do it
                    </button>
                  )}
                  <label>
                    <span className="sr-only">Clock time</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="Clock, 17:00"
                      aria-label={`Clock time for task ${index + 1}`}
                      value={row.clockTime}
                      onChange={(event) => setRow(row.key, { clockTime: event.target.value })}
                    />
                  </label>
                  <select
                    aria-label={`Who does task ${index + 1}`}
                    value={row.owner}
                    onChange={(event) => setRow(row.key, { owner: event.target.value === "theirs" ? "theirs" : "mine" })}
                  >
                    <option value="mine">Mine to do</option>
                    <option value="theirs">Theirs to do</option>
                  </select>
                  <select
                    aria-label={`How long for task ${index + 1}`}
                    value={String(row.durationMin)}
                    onChange={(event) => setRow(row.key, { durationMin: Number(event.target.value) })}
                  >
                    <option value="0">No length</option>
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                  </select>
                  <select
                    aria-label={`Repeats for task ${index + 1}`}
                    value={row.repeatRule ?? ""}
                    onChange={(event) => setRow(row.key, { repeatRule: (event.target.value || null) as RepeatRule })}
                  >
                    <option value="">Once</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              </div>
            </div>
          );
        })}

        <div className="inline-form">
          <input
            aria-label="Template name"
            placeholder="Save these tasks as a template"
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
          />
          <button
            className="text-button"
            type="button"
            onClick={() => {
              onSaveTemplate(
                templateName,
                draft.rows.map((row) => row.title),
              );
              setTemplateName("");
            }}
          >
            Save template
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
        {recoveryKind && (
          <button type="button" className="text-button" onClick={prepareNewSaveAttempt}>
            Prepare new save attempt
          </button>
        )}
        <div className="sheet-actions">
          <button type="button" className="text-button" onClick={discard}>
            Discard
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save meeting
          </button>
        </div>
      </form>
    </div>
  );
}
