import { invoke } from "@tauri-apps/api/core";
import type SqlDatabase from "@tauri-apps/plugin-sql";
import type { QueryResult } from "@tauri-apps/plugin-sql";

export type Database = Pick<SqlDatabase, "execute" | "select">;

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Every statement in the callback runs on one native connection. */
export async function transaction<T>(
  work: (database: Database) => Promise<T>,
  call: Invoke = invoke,
): Promise<T> {
  const token = await call<string>("begin_database_transaction");
  let active = true;
  const database: Database = {
    execute: (query, values = []) => {
      if (!active) return Promise.reject(new Error("This save has already finished."));
      return call<QueryResult>("transaction_execute", { token, query, values });
    },
    select: <R>(query: string, values: unknown[] = []) => {
      if (!active) return Promise.reject(new Error("This save has already finished."));
      return call<R>("transaction_select", { token, query, values });
    },
  };
  try {
    const result = await work(database);
    try {
      await call("finish_database_transaction", { token, commit: true });
    } catch (error) {
      const status = await call<string>("database_transaction_status", { token }).catch(() => "unknown");
      if (status !== "committed") throw error;
    }
    active = false;
    return result;
  } catch (error) {
    active = false;
    try {
      await call("finish_database_transaction", { token, commit: false });
    } catch {
      // Native expiry/failure also rolls back; preserve the original error.
    }
    throw error;
  }
}
