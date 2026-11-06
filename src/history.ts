/** Compare persisted content, independent of object-key and row retrieval order. */
export function fingerprint(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (Array.isArray(item)) {
      const rows = item.every((row) => row && typeof row === "object" && "id" in row);
      const ordered = rows ? [...item].sort((a, b) => String(a.id).localeCompare(String(b.id))) : item;
      return ordered.map(normalize);
    }
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, normalize(val)]));
    }
    return item;
  }
  return JSON.stringify(normalize(value));
}

export class HistoryConflict extends Error {
  constructor() {
    super("Your saved work changed since that action. Undo was stopped to protect the newer changes.");
  }
}

type Entry = { id: number; before: string; after: string; beforeKey: string; afterKey: string; bytes: number };

/** Serializes this window; the native transaction serializes competing windows. */
export class SafeHistory<State, Connection> {
  private undoEntries: Entry[] = [];
  private redoEntries: Entry[] = [];
  private sequence = 0;
  private pending: Promise<unknown> = Promise.resolve();

  private atomic: <T>(run: (connection: Connection) => Promise<T>) => Promise<T>;
  private read: (connection: Connection) => Promise<State>;
  private replace: (connection: Connection, state: State) => Promise<void>;
  private comparable: (state: State) => unknown;
  private maxBytes: number;

  constructor(
    atomic: <T>(run: (connection: Connection) => Promise<T>) => Promise<T>,
    read: (connection: Connection) => Promise<State>,
    replace: (connection: Connection, state: State) => Promise<void>,
    comparable: (state: State) => unknown = (state) => state,
    maxBytes = 32 * 1024 * 1024,
  ) {
    this.atomic = atomic;
    this.read = read;
    this.replace = replace;
    this.comparable = comparable;
    this.maxBytes = maxBytes;
  }

  private queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pending.then(run);
    this.pending = next.catch(() => undefined);
    return next;
  }

  mutate<T>(run: (connection: Connection) => Promise<T>): Promise<{ value: T; state: State; undoId: number | null }> {
    return this.queue(async () => {
      const result = await this.atomic(async (connection) => {
        const before = await this.read(connection);
        const value = await run(connection);
        const after = await this.read(connection);
        return { value, before, after };
      });
      let undoId: number | null = null;
      const beforeKey = fingerprint(this.comparable(result.before)), afterKey = fingerprint(this.comparable(result.after));
      if (beforeKey !== afterKey) {
        undoId = ++this.sequence;
        const before = JSON.stringify(result.before), after = JSON.stringify(result.after);
        this.undoEntries.push({ id: undoId, before, after, beforeKey, afterKey, bytes: 2 * (before.length + after.length + beforeKey.length + afterKey.length) });
        // Serialized history avoids retaining entire object graphs. Bound older
        // entries by estimated UTF-16 bytes, retaining at least the latest edit.
        let bytes = this.undoEntries.reduce((sum, entry) => sum + entry.bytes, 0);
        while (this.undoEntries.length > 1 && (this.undoEntries.length > 40 || bytes > this.maxBytes)) {
          bytes -= this.undoEntries.shift()!.bytes;
        }
        this.redoEntries = [];
      }
      return { value: result.value, state: result.after, undoId };
    });
  }

  undo(expectedId?: number): Promise<State | null> {
    return this.restore(false, expectedId);
  }

  redo(): Promise<State | null> {
    return this.restore(true);
  }

  private restore(redo: boolean, expectedId?: number): Promise<State | null> {
    return this.queue(async () => {
      const from = redo ? this.redoEntries : this.undoEntries;
      const to = redo ? this.undoEntries : this.redoEntries;
      const entry = from[from.length - 1];
      if (!entry) return null;
      if (expectedId !== undefined && entry.id !== expectedId) throw new HistoryConflict();
      try {
        const restored = await this.atomic(async (connection) => {
          const current = await this.read(connection);
          if (fingerprint(this.comparable(current)) !== (redo ? entry.beforeKey : entry.afterKey)) throw new HistoryConflict();
          await this.replace(connection, JSON.parse(redo ? entry.after : entry.before) as State);
          return this.read(connection);
        });
        from.pop();
        to.push(entry);
        return restored;
      } catch (error) {
        if (error instanceof HistoryConflict) {
          this.undoEntries = [];
          this.redoEntries = [];
        }
        throw error;
      }
    });
  }
}
