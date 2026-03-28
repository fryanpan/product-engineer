import { describe, test, expect, beforeEach } from "bun:test";
import { TaskManager } from "./task-manager";

// Mock SQL interface
function createMockSql() {
  const store = new Map<string, Record<string, unknown>>();

  return {
    store,
    exec(sql: string, ...params: unknown[]) {
      // Handle INSERT - params match the SQL: taskUUID, product, slackThreadTs, slackChannel, taskId, title, scheduledFor
      if (sql.includes("INSERT INTO tasks")) {
        const [taskUUID, product, slackThreadTs, slackChannel, taskId, title, scheduledFor] = params;
        store.set(taskUUID as string, {
          task_uuid: taskUUID,
          product,
          status: "created",
          slack_thread_ts: slackThreadTs || null,
          slack_channel: slackChannel || null,
          task_id: taskId || null,
          title: title || null,
          agent_active: 0,
          scheduled_for: scheduledFor || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          pr_url: null,
          branch_name: null,
          agent_message: null,
          checks_passed: 0,
          last_merge_decision_sha: null,
          transcript_r2_key: null,
          session_id: null,
          last_heartbeat: null,
        });
      }

      // Handle SELECT
      if (sql.includes("SELECT") && sql.includes("WHERE task_uuid =")) {
        const taskUUID = params[0] as string;
        const row = store.get(taskUUID);
        return {
          toArray: () => (row ? [row] : []),
        };
      }

      // Handle UPDATE
      if (sql.includes("UPDATE tasks SET")) {
        const taskUUID = params[params.length - 1] as string;
        const row = store.get(taskUUID);
        if (!row) return { toArray: () => [] };

        // Parse SET clause for parameterized values
        const setMatch = sql.match(/SET\s+(.*?)\s+WHERE/);
        if (setMatch) {
          const setPairs = setMatch[1].split(",").map((s) => s.trim());
          let paramIndex = 0;
          setPairs.forEach((pair) => {
            const [field] = pair.split("=").map((s) => s.trim());
            if (pair.includes("?")) {
              (row as any)[field] = params[paramIndex++];
            }
          });
        }

        // Handle literal status updates in SQL
        if (sql.includes("SET status = 'queued'")) {
          row.status = "queued";
        }
        if (sql.includes("SET status = 'reviewing'")) {
          row.status = "reviewing";
        }
      }

      // Handle scheduled tasks query
      if (sql.includes("scheduled_for IS NOT NULL") && sql.includes("scheduled_for <= datetime('now')")) {
        const now = new Date().toISOString();
        const ready = Array.from(store.values()).filter(
          (task) =>
            task.status === "queued" &&
            task.scheduled_for &&
            task.scheduled_for <= now
        );
        return { toArray: () => ready };
      }

      return { toArray: () => [] };
    },
  };
}

describe("TaskManager scheduled tasks", () => {
  test("creates task with scheduledFor timestamp", () => {
    const sql = createMockSql();
    const tm = new TaskManager(sql, {});
    const scheduledFor = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

    tm.createTask({
      taskUUID: "test-uuid",
      product: "test-product",
      scheduledFor,
    });

    const task = tm.getTask("test-uuid");
    expect(task).not.toBeNull();
    expect(task?.scheduled_for).toBe(scheduledFor);
  });

  test("getScheduledTasksReadyToSpawn returns tasks scheduled in the past", () => {
    const sql = createMockSql();
    const tm = new TaskManager(sql, {});

    // Create a task scheduled in the past
    const pastTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    tm.createTask({
      taskUUID: "past-task",
      product: "test-product",
      scheduledFor: pastTime,
    });

    // Manually set status to queued
    sql.exec("UPDATE tasks SET status = 'queued' WHERE task_uuid = ?", "past-task");

    const ready = tm.getScheduledTasksReadyToSpawn();
    expect(ready.length).toBe(1);
    expect(ready[0].task_uuid).toBe("past-task");
  });

  test("getScheduledTasksReadyToSpawn excludes tasks scheduled in the future", () => {
    const sql = createMockSql();
    const tm = new TaskManager(sql, {});

    // Create a task scheduled in the future
    const futureTime = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
    tm.createTask({
      taskUUID: "future-task",
      product: "test-product",
      scheduledFor: futureTime,
    });

    // Manually set status to queued
    sql.exec("UPDATE tasks SET status = 'queued' WHERE task_uuid = ?", "future-task");

    const ready = tm.getScheduledTasksReadyToSpawn();
    expect(ready.length).toBe(0);
  });

  test("isScheduledForFuture returns true for future-scheduled tasks", () => {
    const sql = createMockSql();
    const tm = new TaskManager(sql, {});

    const futureTime = new Date(Date.now() + 3600000).toISOString();
    tm.createTask({
      taskUUID: "future-task",
      product: "test-product",
      scheduledFor: futureTime,
    });

    expect(tm.isScheduledForFuture("future-task")).toBe(true);
  });

  test("isScheduledForFuture returns false for past-scheduled tasks", () => {
    const sql = createMockSql();
    const tm = new TaskManager(sql, {});

    const pastTime = new Date(Date.now() - 3600000).toISOString();
    tm.createTask({
      taskUUID: "past-task",
      product: "test-product",
      scheduledFor: pastTime,
    });

    expect(tm.isScheduledForFuture("past-task")).toBe(false);
  });

  test("updates scheduledFor via updateStatus", () => {
    const sql = createMockSql();
    const tm = new TaskManager(sql, {});

    tm.createTask({
      taskUUID: "test-uuid",
      product: "test-product",
    });

    const newSchedule = new Date(Date.now() + 7200000).toISOString(); // 2 hours from now
    tm.updateStatus("test-uuid", { scheduled_for: newSchedule });

    const task = tm.getTask("test-uuid");
    expect(task?.scheduled_for).toBe(newSchedule);
  });
});
