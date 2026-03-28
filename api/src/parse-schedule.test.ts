import { describe, test, expect } from "bun:test";
import { parseSchedule, calculateNextScheduledTime, type ParsedSchedule } from "./parse-schedule";

describe("parseSchedule", () => {
  test("parses daily schedule with 12-hour time", () => {
    const result = parseSchedule("daily at 9am: Review AI news");
    expect(result).toEqual({
      recurrence: "daily",
      time: "09:00",
      description: "Review AI news",
    });
  });

  test("parses daily schedule with 24-hour time", () => {
    const result = parseSchedule("daily at 14:30: Check metrics");
    expect(result).toEqual({
      recurrence: "daily",
      time: "14:30",
      description: "Check metrics",
    });
  });

  test("parses 'every day' variant", () => {
    const result = parseSchedule("every day at 10:00: Morning standup");
    expect(result).toEqual({
      recurrence: "daily",
      time: "10:00",
      description: "Morning standup",
    });
  });

  test("parses weekly schedule with full day name", () => {
    const result = parseSchedule("weekly on monday at 10am: Team sync");
    expect(result).toEqual({
      recurrence: "weekly",
      time: "10:00",
      dayOfWeek: 1,
      description: "Team sync",
    });
  });

  test("parses weekly schedule with abbreviated day", () => {
    const result = parseSchedule("weekly on fri at 5pm: Deploy check");
    expect(result).toEqual({
      recurrence: "weekly",
      time: "17:00",
      dayOfWeek: 5,
      description: "Deploy check",
    });
  });

  test("parses 'every [day]' variant", () => {
    const result = parseSchedule("every tuesday at 14:00: Review PRs");
    expect(result).toEqual({
      recurrence: "weekly",
      time: "14:00",
      dayOfWeek: 2,
      description: "Review PRs",
    });
  });

  test("parses monthly schedule", () => {
    const result = parseSchedule("monthly on 15th at 12:00: Generate report");
    expect(result).toEqual({
      recurrence: "monthly",
      time: "12:00",
      dayOfMonth: 15,
      description: "Generate report",
    });
  });

  test("parses monthly without ordinal suffix", () => {
    const result = parseSchedule("monthly on 1 at 9am: First of month tasks");
    expect(result).toEqual({
      recurrence: "monthly",
      time: "09:00",
      dayOfMonth: 1,
      description: "First of month tasks",
    });
  });

  test("handles pm times correctly", () => {
    const result = parseSchedule("daily at 2:30pm: Afternoon check");
    expect(result).toEqual({
      recurrence: "daily",
      time: "14:30",
      description: "Afternoon check",
    });
  });

  test("handles 12pm correctly", () => {
    const result = parseSchedule("daily at 12pm: Noon task");
    expect(result?.time).toBe("12:00");
  });

  test("handles 12am correctly", () => {
    const result = parseSchedule("daily at 12am: Midnight task");
    expect(result?.time).toBe("00:00");
  });

  test("returns null for invalid format", () => {
    expect(parseSchedule("not a schedule")).toBeNull();
    expect(parseSchedule("daily at badtime: task")).toBeNull();
    expect(parseSchedule("daily at 9am")).toBeNull(); // missing description
    expect(parseSchedule("")).toBeNull();
  });

  test("handles case insensitivity", () => {
    const result = parseSchedule("DAILY AT 9AM: Task");
    expect(result?.recurrence).toBe("daily");
  });

  test("preserves description exactly", () => {
    const result = parseSchedule("daily at 9am: Review AI news from Hacker News and summarize in thread");
    expect(result?.description).toBe("Review AI news from Hacker News and summarize in thread");
  });
});

describe("calculateNextScheduledTime", () => {
  test("daily: schedules for today if time hasn't passed", () => {
    const schedule: ParsedSchedule = {
      recurrence: "daily",
      time: "14:00",
      description: "test",
    };
    const now = new Date("2024-03-28T10:00:00Z");
    const next = calculateNextScheduledTime(schedule, now);
    expect(next).toBe("2024-03-28T14:00:00.000Z");
  });

  test("daily: schedules for tomorrow if time has passed", () => {
    const schedule: ParsedSchedule = {
      recurrence: "daily",
      time: "09:00",
      description: "test",
    };
    const now = new Date("2024-03-28T10:00:00Z");
    const next = calculateNextScheduledTime(schedule, now);
    expect(next).toBe("2024-03-29T09:00:00.000Z");
  });

  test("weekly: schedules for next occurrence of the day", () => {
    const schedule: ParsedSchedule = {
      recurrence: "weekly",
      time: "10:00",
      dayOfWeek: 1, // Monday
      description: "test",
    };
    // Thursday March 28
    const now = new Date("2024-03-28T10:00:00Z");
    const next = calculateNextScheduledTime(schedule, now);
    // Next Monday is April 1
    expect(next).toBe("2024-04-01T10:00:00.000Z");
  });

  test("weekly: schedules for same day next week if time passed", () => {
    const schedule: ParsedSchedule = {
      recurrence: "weekly",
      time: "09:00",
      dayOfWeek: 4, // Thursday
      description: "test",
    };
    // Thursday March 28, 10am (9am has passed)
    const now = new Date("2024-03-28T10:00:00Z");
    const next = calculateNextScheduledTime(schedule, now);
    // Next Thursday is April 4
    expect(next).toBe("2024-04-04T09:00:00.000Z");
  });

  test("monthly: schedules for this month if date hasn't passed", () => {
    const schedule: ParsedSchedule = {
      recurrence: "monthly",
      time: "12:00",
      dayOfMonth: 15,
      description: "test",
    };
    const now = new Date("2024-03-10T10:00:00Z");
    const next = calculateNextScheduledTime(schedule, now);
    expect(next).toBe("2024-03-15T12:00:00.000Z");
  });

  test("monthly: schedules for next month if date has passed", () => {
    const schedule: ParsedSchedule = {
      recurrence: "monthly",
      time: "12:00",
      dayOfMonth: 15,
      description: "test",
    };
    const now = new Date("2024-03-20T10:00:00Z");
    const next = calculateNextScheduledTime(schedule, now);
    expect(next).toBe("2024-04-15T12:00:00.000Z");
  });
});
