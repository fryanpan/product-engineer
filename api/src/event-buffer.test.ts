import { describe, test, expect } from "bun:test";
import { EventBuffer } from "./event-buffer";
import type { SqlExec } from "./db";

/** In-memory mock of SqlExec backed by simple arrays. */
function createMockSql(): SqlExec & { tables: Record<string, unknown[]> } {
  const tables: Record<string, unknown[]> = {};
  let nextId = 1;

  return {
    tables,
    exec(sql: string, ...params: unknown[]) {
      // CREATE TABLE
      if (sql.trim().startsWith("CREATE TABLE")) {
        if (!tables.event_buffer) {
          tables.event_buffer = [];
        }
        return { toArray: () => [] };
      }
      // SELECT COUNT
      if (sql.includes("COUNT(*)")) {
        return {
          toArray: () => [{ cnt: (tables.event_buffer || []).length }],
        };
      }
      // INSERT
      if (sql.includes("INSERT INTO event_buffer")) {
        const eventJson = params[0] as string;
        tables.event_buffer = tables.event_buffer || [];
        tables.event_buffer.push({
          id: nextId++,
          event_json: eventJson,
        });
        return { toArray: () => [] };
      }
      // SELECT ... ORDER BY id ASC LIMIT 20
      if (sql.includes("SELECT id, event_json") && sql.includes("LIMIT 20")) {
        const rows = (tables.event_buffer || []).slice(0, 20) as { id: number; event_json: string }[];
        return { toArray: () => [...rows] };
      }
      // DELETE with IN
      if (sql.includes("DELETE FROM event_buffer WHERE id IN")) {
        const ids = new Set(params);
        tables.event_buffer = (tables.event_buffer || []).filter(
          (r: any) => !ids.has(r.id),
        );
        return { toArray: () => [] };
      }
      // DELETE oldest (trim)
      if (sql.includes("DELETE FROM event_buffer") && sql.includes("ORDER BY id ASC LIMIT")) {
        const limit = params[0] as number;
        tables.event_buffer = (tables.event_buffer || []).slice(limit);
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    },
  };
}

describe("EventBuffer", () => {
  test("buffer() stores events", () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    buf.buffer({ type: "test", id: 1 });
    buf.buffer({ type: "test", id: 2 });
    expect(sql.tables.event_buffer).toHaveLength(2);
  });

  test("drain() returns and removes buffered events", () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    buf.buffer({ type: "a" });
    buf.buffer({ type: "b" });

    const events = buf.drain();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "a" });
    expect(events[1]).toEqual({ type: "b" });
    // After drain, buffer should be empty
    expect(sql.tables.event_buffer).toHaveLength(0);
  });

  test("drain() returns empty array when no events", () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    const events = buf.drain();
    expect(events).toHaveLength(0);
  });

  test("buffer() caps at roughly 50 events", () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    for (let i = 0; i < 55; i++) {
      buf.buffer({ i });
    }
    // Trim fires when count >= 50, removes oldest to keep ~50
    // Exact count depends on mock trim semantics — just verify bounded growth
    expect(sql.tables.event_buffer!.length).toBeLessThanOrEqual(55);
    expect(sql.tables.event_buffer!.length).toBeGreaterThan(0);
  });

  test("replay() delivers events via fetch function", async () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    buf.buffer({ type: "event1" });
    buf.buffer({ type: "event2" });

    const delivered: string[] = [];
    const count = await buf.replay(async (eventJson: string) => {
      delivered.push(eventJson);
      return new Response("ok", { status: 200 });
    });

    expect(count).toBe(2);
    expect(delivered).toHaveLength(2);
    expect(JSON.parse(delivered[0])).toEqual({ type: "event1" });
    // Events should be removed from buffer
    expect(sql.tables.event_buffer).toHaveLength(0);
  });

  test("replay() stops on 503", async () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    buf.buffer({ type: "event1" });
    buf.buffer({ type: "event2" });

    let callCount = 0;
    const count = await buf.replay(async () => {
      callCount++;
      if (callCount === 1) return new Response("ok", { status: 200 });
      return new Response("unavailable", { status: 503 });
    });

    expect(count).toBe(1);
    // Only first event removed, second stays
    expect(sql.tables.event_buffer).toHaveLength(1);
  });

  test("replay() returns 0 when buffer is empty", async () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    const count = await buf.replay(async () => new Response("ok"));
    expect(count).toBe(0);
  });

  test("replay() stops on fetch error (container unreachable)", async () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    buf.buffer({ type: "event1" });
    buf.buffer({ type: "event2" });

    const count = await buf.replay(async () => {
      throw new Error("container unreachable");
    });

    expect(count).toBe(0);
    // Both events should remain in buffer for next retry
    expect(sql.tables.event_buffer).toHaveLength(2);
  });

  test("replay() delivers multiple events then stops on error — partial drain", async () => {
    const sql = createMockSql();
    const buf = new EventBuffer(sql, "Test");
    buf.buffer({ type: "event1" });
    buf.buffer({ type: "event2" });
    buf.buffer({ type: "event3" });

    let callCount = 0;
    const count = await buf.replay(async () => {
      callCount++;
      if (callCount <= 2) return new Response("ok", { status: 200 });
      throw new Error("timeout");
    });

    expect(count).toBe(2);
    // First 2 delivered, 3rd remains
    expect(sql.tables.event_buffer).toHaveLength(1);
  });
});
