import type { CalEvent } from "./native";

/** Only provider identity proves duplication; matching titles are insufficient. */
export function mergeCalendarEvents(google: CalEvent[], mac: CalEvent[]): CalEvent[] {
  const seen = new Set<string>();
  return [...google, ...mac].filter((event) => {
    const key = `${event.id}|${event.date}|${event.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

export class SingleFlight<T> {
  private active = new Map<string, Promise<T>>();
  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing;
    const promise = work().finally(() => { this.active.delete(key); });
    this.active.set(key, promise);
    return promise;
  }
}
