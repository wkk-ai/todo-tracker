import test from "node:test";
import assert from "node:assert/strict";
import { SafeHistory, HistoryConflict, fingerprint } from "../src/history.ts";

type State = { rows: { id: string; title: string; why?: string }[] };
function shared() {
  let saved: State = { rows: [{ id: "old", title: "Keep this", why: "Original reason" }] };
  let pending: Promise<unknown> = Promise.resolve();
  const atomic = <T>(run: (connection: State) => Promise<T>): Promise<T> => {
    const next = pending.then(async () => {
      const draft = structuredClone(saved);
      const result = await run(draft);
      saved = draft;
      return result;
    });
    pending = next.catch(() => undefined);
    return next;
  };
  const window = () => new SafeHistory<State, State>(atomic, async (draft) => structuredClone(draft), async (draft, state) => { draft.rows = structuredClone(state.rows); });
  return { window, read: () => structuredClone(saved) };
}

test("meeting append Undo preserves older content and explanations", async () => {
  const store = shared(), history = store.window();
  const result = await history.mutate(async (draft) => { draft.rows.push({ id: "new", title: "Appended note" }); });
  await history.undo(result.undoId!);
  assert.deepEqual(store.read().rows, [{ id: "old", title: "Keep this", why: "Original reason" }]);
  await history.redo();
  assert.equal(store.read().rows.length, 2);
});

test("Undo refuses a stale window without erasing another window's saved work", async () => {
  const store = shared(), a = store.window(), b = store.window();
  await a.mutate(async (draft) => { draft.rows[0].title = "Window A edit"; });
  await b.mutate(async (draft) => { draft.rows.push({ id: "b", title: "Window B task" }); });
  await assert.rejects(a.undo(), HistoryConflict);
  assert.deepEqual(store.read().rows.map((row) => row.title), ["Window A edit", "Window B task"]);
  assert.equal(await a.undo(), null);
});

test("an old toast cannot undo a later action in the same window", async () => {
  const store = shared(), history = store.window();
  const first = await history.mutate(async (draft) => { draft.rows[0].title = "First"; });
  await history.mutate(async (draft) => { draft.rows.push({ id: "later", title: "Later" }); });
  await assert.rejects(history.undo(first.undoId!), HistoryConflict);
  assert.equal(store.read().rows.length, 2);
});

test("failed multi-step save and failed restore roll back; history remains usable", async () => {
  const store = shared(), history = store.window();
  await assert.rejects(history.mutate(async (draft) => { draft.rows = []; throw Error("Injected failure after delete"); }));
  assert.equal(store.read().rows[0].title, "Keep this");
  await history.mutate(async (draft) => { draft.rows[0].title = "Saved"; });
  await history.undo();
  assert.equal(store.read().rows[0].why, "Original reason");
});

test("rapid actions serialize and preserve independent rows", async () => {
  const store = shared(), history = store.window();
  await Promise.all(Array.from({ length: 12 }, (_, i) => history.mutate(async (draft) => { draft.rows.push({ id: String(i), title: "Task " + i }); })));
  assert.equal(store.read().rows.length, 13);
  await history.undo();
  assert.equal(store.read().rows.length, 12);
});

test("content comparison ignores retrieval order and includes explanation changes", () => {
  assert.equal(fingerprint({ a: 1, rows: [{ id: "b" }, { id: "a" }] }), fingerprint({ rows: [{ id: "a" }, { id: "b" }], a: 1 }));
  assert.notEqual(fingerprint({ why: "Before" }), fingerprint({ why: "After" }));
});

test("maintenance metadata does not block Undo or get rolled back", async () => {
  type Snapshot = { title: string; backupPath: string };
  let saved: Snapshot = { title: "Before", backupPath: "older" };
  const atomic = async <T>(run: (draft: Snapshot) => Promise<T>) => {
    const draft = structuredClone(saved);
    const result = await run(draft);
    saved = draft;
    return result;
  };
  const history = new SafeHistory<Snapshot, Snapshot>(atomic, async (draft) => structuredClone(draft),
    async (draft, state) => { draft.title = state.title; }, (state) => ({ title: state.title }));
  await history.mutate(async (draft) => { draft.title = "After"; });
  saved.backupPath = "latest completed backup";
  await history.undo();
  assert.deepEqual(saved, { title: "Before", backupPath: "latest completed backup" });
  await history.redo();
  assert.deepEqual(saved, { title: "After", backupPath: "latest completed backup" });
});

test("large histories release older snapshots while keeping the latest Undo and Redo", async () => {
  let saved = { title: "start", notes: "fiction ".repeat(1000) };
  const history = new SafeHistory(async (run) => run(saved), async (draft) => structuredClone(draft),
    async (draft, state) => { Object.assign(draft, state); }, (state) => state, 1000);
  await history.mutate(async (draft) => { draft.title = "first"; });
  await history.mutate(async (draft) => { draft.title = "second"; });
  await history.undo();
  assert.equal(saved.title, "first");
  assert.equal(await history.undo(), null);
  await history.redo();
  assert.equal(saved.title, "second");
});
