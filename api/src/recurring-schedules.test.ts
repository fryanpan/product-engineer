import { describe, test, expect, beforeEach } from "bun:test";
import { parseSchedule, calculateNextScheduledTime } from "./parse-schedule";

// Mock SQL for recurring schedules
function createMockSqlForSchedules() {
  const schedules = new Map<string, Record<string, unknown>>();

  return {
    schedules,
    exec(sql: string, ...params: unknown[]) {
      const normalized = sql.trim().toLowerCase();

      // CREATE TABLE
      if (normalized.startsWith("create table")) {
        return { toArray: () => [] };
      }

      // INSERT
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
          next_scheduled_for: nextScheduledFor,
          created_by: createdBy,
          enabled: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { toArray: () => [] };
      }

      // SELECT
      if (normalized.startsWith("select")) {
        if (normalized.includes("where product =")) {
          const product = params[0];
          const results = Array.from(schedules.values()).filter(s => s.product === product);
          return { toArray: () => results };
        }
        if (normalized.includes("where enabled = 1")) {
          const now = new Date().toISOString();
          const results = Array.from(schedules.values()).filter(
            s => s.enabled === 1 && s.next_scheduled_for && s.next_scheduled_for <= now
          );
          return { toArray: () => results };
        }
        return { toArray: () => Array.from(schedules.values()) };
      }

      // UPDATE
      if (normalized.startsWith("update recurring_schedules")) {
        if (normalized.includes("set enabled =")) {
          const enabled = params[0];
          const id = params[1];
          const schedule = schedules.get(id as string);
          if (schedule) {
            schedule.enabled = enabled as number;
            schedule.updated_at = new Date().toISOString();
          }
          return { toArray: () => [] };
        }
        if (normalized.includes("set next_scheduled_for =")) {
          const nextScheduledFor = params[0];
          const id = params[1];
          const schedule = schedules.get(id as string);
          if (schedule) {
            schedule.next_scheduled_for = nextScheduledFor;
            schedule.last_spawned_at = new Date().toISOString();
            schedule.updated_at = new Date().toISOString();
          }
          return { toArray: () => [] };
        }
        return { toArray: () => [] };
      }

      // DELETE
      if (normalized.startsWith("delete from recurring_schedules")) {
        const id = params[0];
        schedules.delete(id as string);
        return { toArray: () => [] };
      }

      return { toArray: () => [] };
    },
  };
}

describe("Recurring Schedules", () => {
  let sql: ReturnType<typeof createMockSqlForSchedules>;

  beforeEach(() => {
    sql = createMockSqlForSchedules();
  });

  test("creates daily schedule", () => {
    const parsed = parseSchedule("daily at 9am: Review AI news");
    expect(parsed).not.toBeNull();
    expect(parsed!.recurrence).toBe("daily");
    expect(parsed!.time).toBe("09:00");

    const nextScheduledFor = calculateNextScheduledTime(parsed!);
    expect(nextScheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T09:00:00/);
  });

  test("creates weekly schedule", () => {
    const parsed = parseSchedule("weekly on monday at 10am: Team sync");
    expect(parsed).not.toBeNull();
    expect(parsed!.recurrence).toBe("weekly");
    expect(parsed!.dayOfWeek).toBe(1); // Monday
    expect(parsed!.time).toBe("10:00");
  });

  test("creates monthly schedule", () => {
    const parsed = parseSchedule("monthly on 15th at 12:00: Generate report");
    expect(parsed).not.toBeNull();
    expect(parsed!.recurrence).toBe("monthly");
    expect(parsed!.dayOfMonth).toBe(15);
    expect(parsed!.time).toBe("12:00");
  });

  test("stores schedule in database", () => {
    sql.exec(
      `INSERT INTO recurring_schedules
       (id, product, title, description, recurrence, time, day_of_week, day_of_month, next_scheduled_for, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sched-1",
      "test-product",
      "Daily Review",
      "Review AI news",
      "daily",
      "09:00",
      null,
      null,
      "2024-03-29T09:00:00.000Z",
      "test-user",
    );

    const schedules = sql.exec(
      `SELECT * FROM recurring_schedules WHERE product = ?`,
      "test-product",
    ).toArray();

    expect(schedules.length).toBe(1);
    expect(schedules[0].id).toBe("sched-1");
    expect(schedules[0].recurrence).toBe("daily");
  });

  test("lists schedules for product", () => {
    sql.exec(
      `INSERT INTO recurring_schedules
       (id, product, title, description, recurrence, time, day_of_week, day_of_month, next_scheduled_for, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sched-1",
      "product-a",
      "Daily Review",
      "Review AI news",
      "daily",
      "09:00",
      null,
      null,
      "2024-03-29T09:00:00.000Z",
      null,
    );

    sql.exec(
      `INSERT INTO recurring_schedules
       (id, product, title, description, recurrence, time, day_of_week, day_of_month, next_scheduled_for, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sched-2",
      "product-b",
      "Weekly Sync",
      "Team meeting",
      "weekly",
      "10:00",
      1,
      null,
      "2024-04-01T10:00:00.000Z",
      null,
    );

    const productA = sql.exec(
      `SELECT * FROM recurring_schedules WHERE product = ?`,
      "product-a",
    ).toArray();

    expect(productA.length).toBe(1);
    expect(productA[0].id).toBe("sched-1");
  });

  test("pauses and resumes schedule", () => {
    sql.exec(
      `INSERT INTO recurring_schedules
       (id, product, title, description, recurrence, time, day_of_week, day_of_month, next_scheduled_for, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sched-1",
      "product-a",
      "Daily Review",
      "Review AI news",
      "daily",
      "09:00",
      null,
      null,
      "2024-03-29T09:00:00.000Z",
      null,
    );

    // Pause
    sql.exec(
      `UPDATE recurring_schedules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
      0,
      "sched-1",
    );

    let schedule = sql.schedules.get("sched-1");
    expect(schedule?.enabled).toBe(0);

    // Resume
    sql.exec(
      `UPDATE recurring_schedules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
      1,
      "sched-1",
    );

    schedule = sql.schedules.get("sched-1");
    expect(schedule?.enabled).toBe(1);
  });

  test("deletes schedule", () => {
    sql.exec(
      `INSERT INTO recurring_schedules
       (id, product, title, description, recurrence, time, day_of_week, day_of_month, next_scheduled_for, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sched-1",
      "product-a",
      "Daily Review",
      "Review AI news",
      "daily",
      "09:00",
      null,
      null,
      "2024-03-29T09:00:00.000Z",
      null,
    );

    expect(sql.schedules.size).toBe(1);

    sql.exec(`DELETE FROM recurring_schedules WHERE id = ?`, "sched-1");

    expect(sql.schedules.size).toBe(0);
  });

  test("finds schedules ready to spawn", () => {
    // Past schedule (should be returned)
    sql.exec(
      `INSERT INTO recurring_schedules
       (id, product, title, description, recurrence, time, day_of_week, day_of_month, next_scheduled_for, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sched-1",
      "product-a",
      "Past Review",
      "Should run",
      "daily",
      "09:00",
      null,
      null,
      new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      null,
    );

    // Future schedule (should NOT be returned)
    sql.exec(
      `INSERT INTO recurring_schedules
       (id, product, title, description, recurrence, time, day_of_week, day_of_month, next_scheduled_for, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "sched-2",
      "product-a",
      "Future Review",
      "Should not run yet",
      "daily",
      "14:00",
      null,
      null,
      new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      null,
    );

    const ready = sql.exec(`
      SELECT * FROM recurring_schedules
      WHERE enabled = 1
        AND next_scheduled_for IS NOT NULL
        AND next_scheduled_for <= datetime('now')
    `).toArray();

    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("sched-1");
  });
});
