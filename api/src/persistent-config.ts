/**
 * Shared config persistence for container DOs.
 *
 * Both TicketAgent and ProjectAgent store their config in a SQLite `config` table
 * with the same schema. This class encapsulates the CRUD + terminal flag logic.
 */

import type { SqlExec } from "./db";

export class PersistentConfig<T> {
  private initialized = false;

  constructor(private sql: SqlExec) {}

  private ensureTable() {
    if (this.initialized) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  /** Read the stored agent config. Returns null if not yet initialized. */
  get(): T | null {
    this.ensureTable();
    const row = this.sql.exec(
      "SELECT value FROM config WHERE key = 'agent_config'",
    ).toArray()[0] as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  /** Upsert the agent config. */
  set(config: T): void {
    this.ensureTable();
    this.sql.exec(
      `INSERT INTO config (key, value) VALUES ('agent_config', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      JSON.stringify(config),
      JSON.stringify(config),
    );
  }

  /** Check whether this container has been marked as terminal. */
  isTerminal(): boolean {
    this.ensureTable();
    const row = this.sql.exec(
      "SELECT value FROM config WHERE key = 'terminal'",
    ).toArray()[0] as { value: string } | undefined;
    return row?.value === "true";
  }

  /** Mark this container as terminal (completed/failed — should not restart). */
  markTerminal(): void {
    this.ensureTable();
    this.sql.exec(
      `INSERT INTO config (key, value) VALUES ('terminal', 'true')
       ON CONFLICT(key) DO UPDATE SET value = 'true'`,
    );
  }
}
