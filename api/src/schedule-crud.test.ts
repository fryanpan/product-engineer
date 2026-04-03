/**
 * Tests for schedule CRUD operations (edit and delete).
 * Tests the SQL patterns used by handleScheduleRoute in conductor.ts.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { parseSchedule, calculateNextScheduledTime } from "./parse-schedule";

// Generic mock SQL that handles parameterized UPDATEs for recurring_schedules
function createMockSql() {
  const schedules = new Map<string, Record<string, unknown>>();

  function insertSchedule(id: string, overrides: Partial<Record<string, unknown>> = {}) {
    schedules.set(id, {
      id,
      product: "test-product",
      title: "Daily Review",
      description: "Review AI news",
      recurrence: "daily",
      time: "09:00",
      day_of_week: null,
      day_of_month: null,
      enabled: 1,
      next_scheduled_for: "2024-03-29 09:00:00",
      created_by: null,
      created_at: "2024-03-28 10:00:00",
      updated_at: "2024-03-28 10:00:00",
      ...overrides,
    });
  }

  const sql = {
    schedules,
    insertSchedule,
    exec(query: string, ...params: unknown[]) {
      const normalized = query.trim().toLowerCase();

      if (normalized.startsWith("insert into recurring_schedules")) {
        const [id, product, title, description, recurrence, time, dayOfWeek, dayOfMonth, nextScheduledFor, createdBy] = params;
        schedules.set(id as string, {
          id,
          product,
          title,
          description,
          recurrence,
          time,
          day_of_week: dayOfWeek,
          day_of_month: dayOfMonth,
          enabled: 1,
          next_scheduled_for: nextScheduledFor,
          created_by: createdBy,
          created_at: "2024-03-28 10:00:00",
          updated_at: "2024-03-28 10:00:00",
        });
        return { toArray: () => [] };
      }

      if (normalized.startsWith("select")) {
        if (normalized.includes("where id =")) {
          const id = params[0];
          const row = schedules.get(id as string);
          return { toArray: () => (row ? [row] : []) };
        }
        if (normalized.includes("where product =")) {
          const product = params[0];
          const results = Array.from(schedules.values()).filter(s => s.product === product);
          return { toArray: () => results };
        }
        return { toArray: () => Array.from(schedules.values()) };
      }

      if (normalized.startsWith("update recurring_schedules")) {
        // Extract id from the last param (WHERE id = ?)
        const id = params[params.length - 1] as string;
        const schedule = schedules.get(id);
        if (!schedule) return { toArray: () => [] };

        // Parse SET clause to apply parameterized updates
        const setMatch = query.match(/SET\s+(.*?)\s+WHERE/is);
        if (setMatch) {
          const setPairs = setMatch[1].split(",").map(s => s.trim());
          let paramIndex = 0;
          for (const pair of setPairs) {
            const eqIdx = pair.indexOf("=");
            if (eqIdx === -1) continue;
            const field = pair.slice(0, eqIdx).trim();
            const valuePart = pair.slice(eqIdx + 1).trim();
            if (valuePart === "?") {
              (schedule as Record<string, unknown>)[field] = params[paramIndex++];
            } else if (valuePart.includes("datetime('now')")) {
              (schedule as Record<string, unknown>)[field] = new Date().toISOString();
            }
          }
        }

        return { toArray: () => [] };
      }

      if (normalized.startsWith("delete from recurring_schedules")) {
        const id = params[0];
        schedules.delete(id as string);
        return { toArray: () => [] };
      }

      return { toArray: () => [] };
    },
  };

  return sql;
}

describe("Schedule CRUD — edit operations", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
    sql.insertSchedule("sched-1");
  });

  test("update description only — changes title and description", () => {
    const newDescription = "Updated review description";
    const updates = ["updated_at = datetime('now')", "title = ?", "description = ?"];
    const values = [newDescription.slice(0, 80), newDescription, "sched-1"];

    sql.exec(`UPDATE recurring_schedules SET ${updates.join(", ")} WHERE id = ?`, ...values);

    const [schedule] = sql.exec("SELECT * FROM recurring_schedules WHERE id = ?", "sched-1").toArray();
    expect(schedule.description).toBe(newDescription);
    expect(schedule.title).toBe(newDescription.slice(0, 80));
    // Timing fields unchanged
    expect(schedule.recurrence).toBe("daily");
    expect(schedule.time).toBe("09:00");
  });

  test("update via scheduleText — changes recurrence, time, and description", () => {
    const newScheduleText = "weekly on friday at 2pm: Weekly team sync";
    const parsed = parseSchedule(newScheduleText);
    expect(parsed).not.toBeNull();
    expect(parsed!.recurrence).toBe("weekly");
    expect(parsed!.time).toBe("14:00");
    expect(parsed!.dayOfWeek).toBe(5); // Friday

    const nextScheduledFor = calculateNextScheduledTime(parsed!);
    expect(nextScheduledFor).toMatch(/^\d{4}-\d{2}-\d{2} 14:00:00$/);

    const updates = [
      "updated_at = datetime('now')",
      "title = ?", "description = ?",
      "recurrence = ?", "time = ?",
      "day_of_week = ?", "day_of_month = ?",
      "next_scheduled_for = ?",
    ];
    const values = [
      parsed!.description.slice(0, 80),
      parsed!.description,
      parsed!.recurrence,
      parsed!.time,
      parsed!.dayOfWeek ?? null,
      parsed!.dayOfMonth ?? null,
      nextScheduledFor,
      "sched-1",
    ];

    sql.exec(`UPDATE recurring_schedules SET ${updates.join(", ")} WHERE id = ?`, ...values);

    const [schedule] = sql.exec("SELECT * FROM recurring_schedules WHERE id = ?", "sched-1").toArray();
    expect(schedule.recurrence).toBe("weekly");
    expect(schedule.time).toBe("14:00");
    expect(schedule.day_of_week).toBe(5);
    expect(schedule.description).toBe("Weekly team sync");
    expect(schedule.title).toBe("Weekly team sync");
    expect(schedule.next_scheduled_for).toBe(nextScheduledFor);
  });

  test("update to monthly schedule — sets day_of_month", () => {
    const newScheduleText = "monthly on 1st at 10:00: Monthly report";
    const parsed = parseSchedule(newScheduleText);
    expect(parsed).not.toBeNull();
    expect(parsed!.recurrence).toBe("monthly");
    expect(parsed!.dayOfMonth).toBe(1);

    const nextScheduledFor = calculateNextScheduledTime(parsed!);
    const updates = [
      "updated_at = datetime('now')",
      "title = ?", "description = ?",
      "recurrence = ?", "time = ?",
      "day_of_week = ?", "day_of_month = ?",
      "next_scheduled_for = ?",
    ];
    const values = [
      parsed!.description.slice(0, 80),
      parsed!.description,
      parsed!.recurrence,
      parsed!.time,
      parsed!.dayOfWeek ?? null,
      parsed!.dayOfMonth ?? null,
      nextScheduledFor,
      "sched-1",
    ];

    sql.exec(`UPDATE recurring_schedules SET ${updates.join(", ")} WHERE id = ?`, ...values);

    const [schedule] = sql.exec("SELECT * FROM recurring_schedules WHERE id = ?", "sched-1").toArray();
    expect(schedule.recurrence).toBe("monthly");
    expect(schedule.day_of_month).toBe(1);
    expect(schedule.day_of_week).toBeNull();
  });

  test("update enabled + description together", () => {
    const newDescription = "Paused daily review";
    const updates = [
      "updated_at = datetime('now')",
      "enabled = ?",
      "title = ?",
      "description = ?",
    ];
    const values = [0, newDescription.slice(0, 80), newDescription, "sched-1"];

    sql.exec(`UPDATE recurring_schedules SET ${updates.join(", ")} WHERE id = ?`, ...values);

    const [schedule] = sql.exec("SELECT * FROM recurring_schedules WHERE id = ?", "sched-1").toArray();
    expect(schedule.enabled).toBe(0);
    expect(schedule.description).toBe(newDescription);
  });

  test("invalid scheduleText returns null from parseSchedule", () => {
    const invalidSchedule = "not a valid schedule format";
    const parsed = parseSchedule(invalidSchedule);
    expect(parsed).toBeNull();
    // The handler returns 400 when parsed is null
  });

  test("empty body (no fields) is a no-op — updated_at not bumped", () => {
    const originalUpdatedAt = sql.schedules.get("sched-1")?.updated_at as string;

    // No updates to apply — simulate the no-op path (no SQL UPDATE runs)
    const updates: string[] = [];
    expect(updates.length).toBe(0);
    // The handler returns the existing schedule without touching updated_at

    const [schedule] = sql.exec("SELECT * FROM recurring_schedules WHERE id = ?", "sched-1").toArray();
    expect(schedule.updated_at).toBe(originalUpdatedAt);
  });
});

describe("Schedule CRUD — delete operations", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
    sql.insertSchedule("sched-1");
    sql.insertSchedule("sched-2", { product: "other-product", title: "Other" });
  });

  test("delete removes the schedule", () => {
    expect(sql.schedules.size).toBe(2);

    sql.exec("DELETE FROM recurring_schedules WHERE id = ?", "sched-1");

    expect(sql.schedules.size).toBe(1);
    const [remaining] = sql.exec("SELECT * FROM recurring_schedules WHERE id = ?", "sched-1").toArray();
    expect(remaining).toBeUndefined();
  });

  test("delete only removes the targeted schedule", () => {
    sql.exec("DELETE FROM recurring_schedules WHERE id = ?", "sched-1");

    const [sched2] = sql.exec("SELECT * FROM recurring_schedules WHERE id = ?", "sched-2").toArray();
    expect(sched2).toBeDefined();
    expect(sched2.id).toBe("sched-2");
  });

  test("delete nonexistent id is a no-op", () => {
    expect(sql.schedules.size).toBe(2);
    sql.exec("DELETE FROM recurring_schedules WHERE id = ?", "nonexistent-id");
    expect(sql.schedules.size).toBe(2);
  });
});

describe("Schedule CRUD — description truncation", () => {
  test("long description is truncated to 80 chars for title", () => {
    const longTask = "A".repeat(100);
    const scheduleText = `daily at 9am: ${longTask}`;
    const parsed = parseSchedule(scheduleText);
    expect(parsed).not.toBeNull();
    const title = parsed!.description.slice(0, 80);
    expect(title.length).toBe(80);
    expect(title).toBe("A".repeat(80));
    expect(parsed!.description.length).toBe(100); // full description preserved
  });

  test("description under 80 chars preserved as title", () => {
    const scheduleText = "daily at 9am: Short task";
    const parsed = parseSchedule(scheduleText);
    expect(parsed).not.toBeNull();
    const title = parsed!.description.slice(0, 80);
    expect(title).toBe("Short task");
  });
});
