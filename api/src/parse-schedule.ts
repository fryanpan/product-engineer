/**
 * Parse natural language schedule expressions into structured schedule data.
 *
 * Supports formats like:
 * - "daily at 9am: do something"
 * - "every day at 14:30: task"
 * - "weekly on monday at 10am: review"
 * - "every monday at 10:00: check"
 * - "monthly on 15th at 12:00: report"
 */

export interface ParsedSchedule {
  recurrence: "daily" | "weekly" | "monthly";
  time: string; // HH:MM in 24-hour format
  dayOfWeek?: number; // 0-6 for weekly (0=Sunday)
  dayOfMonth?: number; // 1-31 for monthly
  description: string; // The task description
}

const DAY_MAP: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function parse24HourTime(timeStr: string): string | null {
  // Already in 24-hour format (e.g., "14:30", "9:00")
  const match24 = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (match24) {
    const hour = parseInt(match24[1], 10);
    const min = parseInt(match24[2], 10);
    if (hour >= 0 && hour < 24 && min >= 0 && min < 60) {
      return `${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}`;
    }
  }

  // 12-hour format with am/pm (e.g., "9am", "2:30pm", "12pm")
  // Remove any spaces before am/pm
  const normalized12 = timeStr.replace(/\s+/g, "");
  const match12 = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/i.exec(normalized12);
  if (match12) {
    let hour = parseInt(match12[1], 10);
    const min = match12[2] ? parseInt(match12[2], 10) : 0;
    const period = match12[3].toLowerCase();

    if (hour < 1 || hour > 12 || min < 0 || min >= 60) return null;

    // Convert to 24-hour
    if (period === "pm" && hour !== 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;

    return `${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}`;
  }

  return null;
}

export function parseSchedule(input: string): ParsedSchedule | null {
  if (!input) return null;

  // Look for patterns like:
  // - "daily at 9am: description"
  // - "every day at 14:30: description"
  // - "weekly on monday at 10am: description"
  // - "every monday at 10:00: description"
  // - "monthly on 15th at 12:00: description"

  const normalized = input.trim().toLowerCase();

  // Split on ": " (colon-space) to separate schedule from description
  // This ensures we don't split on the colon in times like "14:30"
  const separatorIndex = input.indexOf(": ");
  if (separatorIndex === -1) return null;

  const schedulePartNorm = normalized.slice(0, separatorIndex).trim();
  const schedulePart = input.slice(0, separatorIndex).trim(); // preserve case for time parsing
  const description = input.slice(separatorIndex + 2).trim();

  if (!description) return null;

  // Daily patterns
  if (/^(daily|every\s+day)\s+at\s+/.test(schedulePartNorm)) {
    // Extract time from original input (preserves case for am/pm)
    const timeStr = schedulePart.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]m)?)/i)?.[1]?.trim();
    if (!timeStr) return null;
    const time = parse24HourTime(timeStr);
    if (!time) return null;
    return { recurrence: "daily", time, description };
  }

  // Weekly patterns: "weekly on monday at 10am" or "every monday at 10am"
  const weeklyMatch = schedulePartNorm.match(
    /^(?:weekly\s+on|every)\s+(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\s+at\s+(.+)$/,
  );
  if (weeklyMatch) {
    const dayName = weeklyMatch[1];
    const dayOfWeek = DAY_MAP[dayName];
    if (dayOfWeek === undefined) return null;
    // Extract time from original case-preserved input
    const timeStr = schedulePart.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]m)?)/i)?.[1]?.trim();
    if (!timeStr) return null;
    const time = parse24HourTime(timeStr);
    if (!time) return null;
    return { recurrence: "weekly", time, dayOfWeek, description };
  }

  // Monthly patterns: "monthly on 15th at 12:00"
  const monthlyMatch = schedulePartNorm.match(/^monthly\s+on\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(.+)$/);
  if (monthlyMatch) {
    const dayOfMonth = parseInt(monthlyMatch[1], 10);
    if (dayOfMonth < 1 || dayOfMonth > 31) return null;
    const timeStr = schedulePart.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]m)?)/i)?.[1]?.trim();
    if (!timeStr) return null;
    const time = parse24HourTime(timeStr);
    if (!time) return null;
    return { recurrence: "monthly", time, dayOfMonth, description };
  }

  return null;
}

/**
 * Calculate the next scheduled time for a recurring schedule.
 * Returns ISO8601 timestamp.
 */
/**
 * Format a Date as SQLite-compatible datetime string (YYYY-MM-DD HH:MM:SS).
 * This matches the output of SQLite's datetime('now') function,
 * ensuring consistent string comparisons in SQL queries.
 */
function toSQLiteDatetime(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function calculateNextScheduledTime(schedule: ParsedSchedule, after?: Date): string {
  const now = after || new Date();
  const [hour, minute] = schedule.time.split(":").map(Number);

  switch (schedule.recurrence) {
    case "daily": {
      const next = new Date(now);
      next.setUTCHours(hour, minute, 0, 0);
      // If today's time has passed, schedule for tomorrow
      if (next <= now) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      return toSQLiteDatetime(next);
    }

    case "weekly": {
      if (schedule.dayOfWeek === undefined) throw new Error("dayOfWeek required for weekly");
      const next = new Date(now);
      next.setUTCHours(hour, minute, 0, 0);

      // Find next occurrence of the target day
      const currentDay = next.getUTCDay();
      let daysUntilTarget = schedule.dayOfWeek - currentDay;
      if (daysUntilTarget < 0 || (daysUntilTarget === 0 && next <= now)) {
        daysUntilTarget += 7;
      }
      next.setUTCDate(next.getUTCDate() + daysUntilTarget);
      return toSQLiteDatetime(next);
    }

    case "monthly": {
      if (schedule.dayOfMonth === undefined) throw new Error("dayOfMonth required for monthly");
      const next = new Date(now);
      next.setUTCHours(hour, minute, 0, 0);
      next.setUTCDate(schedule.dayOfMonth);

      // If this month's date has passed, move to next month
      if (next <= now) {
        next.setUTCMonth(next.getUTCMonth() + 1);
      }

      // Handle invalid dates (e.g., setting day 31 in a 30-day month
      // causes Date to roll over to the next month). Clamp to last day.
      const targetMonth = next.getUTCMonth();
      if (next.getUTCDate() !== schedule.dayOfMonth) {
        // Rolled over — go back to last day of the intended month
        next.setUTCDate(0); // sets to last day of previous month (which is our target month)
      }

      return toSQLiteDatetime(next);
    }

    default:
      throw new Error(`Unknown recurrence: ${schedule.recurrence}`);
  }
}
