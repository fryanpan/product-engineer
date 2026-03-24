import { describe, test, expect } from "bun:test";
import { PersistentConfig } from "./persistent-config";
import type { SqlExec } from "./db";

/** In-memory mock of SqlExec backed by a simple key-value store. */
function createMockSql(): SqlExec {
  const store: Record<string, string> = {};

  return {
    exec(sql: string, ...params: unknown[]) {
      // CREATE TABLE
      if (sql.trim().startsWith("CREATE TABLE")) {
        return { toArray: () => [] };
      }
      // SELECT value FROM config WHERE key = 'agent_config'
      if (sql.includes("SELECT value FROM config WHERE key = 'agent_config'")) {
        const val = store["agent_config"];
        return {
          toArray: () => (val !== undefined ? [{ value: val }] : []),
        };
      }
      // SELECT value FROM config WHERE key = 'terminal'
      if (sql.includes("SELECT value FROM config WHERE key = 'terminal'")) {
        const val = store["terminal"];
        return {
          toArray: () => (val !== undefined ? [{ value: val }] : []),
        };
      }
      // INSERT INTO config (key, value) VALUES ('agent_config', ?)
      if (sql.includes("INSERT INTO config") && sql.includes("'agent_config'")) {
        store["agent_config"] = params[0] as string;
        return { toArray: () => [] };
      }
      // INSERT INTO config (key, value) VALUES ('terminal', 'true')
      if (sql.includes("INSERT INTO config") && sql.includes("'terminal'")) {
        store["terminal"] = "true";
        return { toArray: () => [] };
      }
      // DELETE FROM config WHERE key = 'terminal'
      if (sql.includes("DELETE FROM config") && sql.includes("'terminal'")) {
        delete store["terminal"];
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  };
}

describe("PersistentConfig", () => {
  test("get() returns null when no config stored", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<{ name: string }>(sql);
    expect(pc.get()).toBeNull();
  });

  test("set() and get() round-trip config", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<{ name: string; count: number }>(sql);
    pc.set({ name: "test", count: 42 });
    const result = pc.get();
    expect(result).toEqual({ name: "test", count: 42 });
  });

  test("set() overwrites previous config", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<{ val: string }>(sql);
    pc.set({ val: "first" });
    pc.set({ val: "second" });
    expect(pc.get()).toEqual({ val: "second" });
  });

  test("isTerminal() returns false by default", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<unknown>(sql);
    expect(pc.isTerminal()).toBe(false);
  });

  test("markTerminal() sets terminal flag", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<unknown>(sql);
    pc.markTerminal();
    expect(pc.isTerminal()).toBe(true);
  });

  test("markTerminal() is idempotent", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<unknown>(sql);
    pc.markTerminal();
    pc.markTerminal();
    expect(pc.isTerminal()).toBe(true);
  });

  test("clearTerminal() resets terminal flag", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<unknown>(sql);
    pc.markTerminal();
    expect(pc.isTerminal()).toBe(true);

    pc.clearTerminal();
    expect(pc.isTerminal()).toBe(false);
  });

  test("clearTerminal() is safe when not terminal", () => {
    const sql = createMockSql();
    const pc = new PersistentConfig<unknown>(sql);
    pc.clearTerminal(); // should not throw
    expect(pc.isTerminal()).toBe(false);
  });
});
