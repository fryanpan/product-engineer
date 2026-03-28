import { describe, test, expect } from "bun:test";

/**
 * Extract scheduled_for timestamp from issue description.
 * Supports formats:
 * - "Scheduled for: 2024-03-28 14:30" (local time interpreted as UTC)
 * - "Scheduled for: 2024-03-28T14:30:00Z" (ISO8601)
 * - "Schedule: 2024-03-28 14:30"
 * Returns ISO8601 string or null if no valid schedule found.
 */
function extractScheduledFor(description: string): string | null {
  if (!description) return null;

  // Match patterns like "Scheduled for: 2024-03-28 14:30" or "Schedule: 2024-03-28 14:30"
  const patterns = [
    /scheduled?\s+for:\s*(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)/i,
    /schedule:\s*(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)/i,
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) {
      const dateStr = match[1].trim();
      try {
        // If it has a space instead of 'T', replace it
        const normalized = dateStr.includes(' ') && !dateStr.includes('T')
          ? dateStr.replace(' ', 'T') + 'Z'  // Assume UTC if no timezone
          : dateStr;

        const parsed = new Date(normalized);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString();
        }
      } catch {
        // Invalid date, continue
      }
    }
  }

  return null;
}

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
