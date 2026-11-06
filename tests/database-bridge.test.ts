import assert from "node:assert/strict";
import test from "node:test";
import { transaction, type Database } from "../src/database.ts";

test("save statements stay on one native token and commit after all statements", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return (command === "begin_database_transaction" ? "owned-token" : { rowsAffected: 1 }) as T;
  };
  let captured: Database | undefined;
  await transaction(async (database) => {
    captured = database;
    await database.execute("INSERT synthetic", ["old"]);
    await database.execute("UPDATE synthetic", ["new"]);
  }, call);
  assert.deepEqual(calls.map((item) => item.command), ["begin_database_transaction", "transaction_execute", "transaction_execute", "finish_database_transaction"]);
  assert(calls.slice(1).every((item) => item.args?.token === "owned-token"));
  assert.equal(calls[3].args?.commit, true);
  await assert.rejects(captured!.select("SELECT synthetic"), /already finished/);
});

test("any failed statement rolls back instead of committing a partial save", async () => {
  const finishes: boolean[] = [];
  let statements = 0;
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "begin_database_transaction") return "token" as T;
    if (command === "finish_database_transaction") finishes.push(Boolean(args?.commit));
    if (command === "transaction_execute" && ++statements === 2) throw Error("Injected failure");
    return { rowsAffected: 1 } as T;
  };
  await assert.rejects(transaction(async (database) => {
    await database.execute("DELETE synthetic");
    await database.execute("INSERT synthetic");
  }, call), /Injected failure/);
  assert.deepEqual(finishes, [false]);
});

test("a lost commit acknowledgement uses the owner-bound native receipt", async () => {
  const calls: string[] = [];
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(command);
    if (command === "begin_database_transaction") return "token" as T;
    if (command === "finish_database_transaction" && args?.commit) throw Error("Acknowledgement lost");
    if (command === "database_transaction_status") return "committed" as T;
    return { rowsAffected: 1 } as T;
  };
  assert.equal(await transaction(async (database) => { await database.execute("INSERT synthetic"); return "saved once"; }, call), "saved once");
  assert.deepEqual(calls.slice(-2), ["finish_database_transaction", "database_transaction_status"]);
});

test("an unknown commit result is never presented as success", async () => {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "begin_database_transaction") return "token" as T;
    if (command === "finish_database_transaction" && args?.commit) throw Error("Unconfirmed commit");
    if (command === "database_transaction_status") return "unknown" as T;
    return { rowsAffected: 1 } as T;
  };
  await assert.rejects(transaction(async () => "unconfirmed", call), /Unconfirmed commit/);
});
