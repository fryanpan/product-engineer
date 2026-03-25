/**
 * Shared event buffer for container DOs.
 *
 * Stores events in SQLite when the container is unreachable, then drains/replays
 * them when the container becomes healthy. Used by both TaskAgent and ProjectLead.
 */

import type { SqlExec } from "./db";

export class EventBuffer {
  private initialized = false;

  constructor(
    private sql: SqlExec,
    private label: string,
  ) {}

  private ensureTable() {
    if (this.initialized) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.initialized = true;
  }

  /** Buffer an event for later delivery. Caps at 50 events. */
  buffer(event: unknown): void {
    this.ensureTable();
    const countRow = this.sql.exec(
      "SELECT COUNT(*) as cnt FROM event_buffer",
    ).toArray()[0] as { cnt: number };
    if (countRow.cnt >= 50) {
      this.sql.exec(
        "DELETE FROM event_buffer WHERE id IN (SELECT id FROM event_buffer ORDER BY id ASC LIMIT ?)",
        countRow.cnt - 49,
      );
    }
    this.sql.exec(
      "INSERT INTO event_buffer (event_json) VALUES (?)",
      JSON.stringify(event),
    );
    console.log(`[${this.label}] Buffered event`);
  }

  /** Drain up to 20 buffered events, removing them from the buffer. */
  drain<T = unknown>(): T[] {
    this.ensureTable();
    const rows = this.sql.exec(
      "SELECT id, event_json FROM event_buffer ORDER BY id ASC LIMIT 20",
    ).toArray() as { id: number; event_json: string }[];

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.sql.exec(
        `DELETE FROM event_buffer WHERE id IN (${placeholders})`,
        ...ids,
      );
      console.log(`[${this.label}] Drained ${rows.length} buffered events`);
    }

    return rows.map(r => JSON.parse(r.event_json));
  }

  /**
   * Replay buffered events through a fetch function.
   * Stops on first 503 or error. Returns count of successfully delivered events.
   */
  async replay(
    fetchFn: (eventJson: string) => Promise<Response>,
  ): Promise<number> {
    this.ensureTable();
    const rows = this.sql.exec(
      "SELECT id, event_json FROM event_buffer ORDER BY id ASC LIMIT 20",
    ).toArray() as { id: number; event_json: string }[];

    if (rows.length === 0) return 0;

    console.log(`[${this.label}] Replaying ${rows.length} buffered events...`);
    const delivered: number[] = [];

    for (const row of rows) {
      try {
        const res = await fetchFn(row.event_json);
        if (res.ok) {
          delivered.push(row.id);
        } else if (res.status === 503) {
          break;
        }
      } catch {
        break;
      }
    }

    if (delivered.length > 0) {
      const placeholders = delivered.map(() => "?").join(",");
      this.sql.exec(
        `DELETE FROM event_buffer WHERE id IN (${placeholders})`,
        ...delivered,
      );
      console.log(`[${this.label}] Successfully replayed ${delivered.length} events`);
    }

    return delivered.length;
  }
}
