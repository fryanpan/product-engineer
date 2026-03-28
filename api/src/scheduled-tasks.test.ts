import { describe, test, expect } from "bun:test";
import { extractScheduledFor } from "./webhooks";

describe("extractScheduledFor", () => {
  test("parses 'Scheduled for: YYYY-MM-DD HH:MM' format", () => {
    const result = extractScheduledFor("Do something\n\nScheduled for: 2024-03-28 14:30\n\nMore details");
    expect(result).toBe("2024-03-28T14:30:00.000Z");
  });

  test("parses 'Schedule: YYYY-MM-DD HH:MM' format", () => {
    const result = extractScheduledFor("Task description\nSchedule: 2024-12-25 09:00");
    expect(result).toBe("2024-12-25T09:00:00.000Z");
  });

  test("parses ISO8601 format with timezone", () => {
    const result = extractScheduledFor("Scheduled for: 2024-03-28T14:30:00Z");
    expect(result).toBe("2024-03-28T14:30:00.000Z");
  });

  test("returns null when no schedule pattern found", () => {
    const result = extractScheduledFor("Just a regular task description");
    expect(result).toBeNull();
  });

  test("returns null for empty description", () => {
    const result = extractScheduledFor("");
    expect(result).toBeNull();
  });

  test("handles case-insensitive matching", () => {
    const result = extractScheduledFor("SCHEDULED FOR: 2024-03-28 14:30");
    expect(result).toBe("2024-03-28T14:30:00.000Z");
  });

  test("returns null for invalid date format", () => {
    const result = extractScheduledFor("Scheduled for: not-a-date");
    expect(result).toBeNull();
  });

  test("parses date-only format by adding Z suffix", () => {
    const result = extractScheduledFor("Scheduled for: 2024-03-28");
    expect(result).toBe("2024-03-28T00:00:00.000Z");
  });

  test("handles seconds in time format", () => {
    const result = extractScheduledFor("Scheduled for: 2024-03-28 14:30:45");
    expect(result).toBe("2024-03-28T14:30:45.000Z");
  });
});
