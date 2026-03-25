/**
 * Shared database helpers for the Orchestrator DO.
 *
 * All functions accept a `SqlExec` interface (the same one used by AgentManager)
 * so they can be called with `this.ctx.storage.sql` from any DO method.
 */

import type { ProductConfig, CloudflareAIGateway } from "./registry";

export interface SqlResult {
  toArray(): Record<string, unknown>[];
}

export interface SqlExec {
  exec(sql: string, ...params: unknown[]): SqlResult;
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/**
 * Create all tables and run migrations. Idempotent — safe to call on every request.
 */
export function initSchema(sql: SqlExec): void {
  // Tasks table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_uuid TEXT PRIMARY KEY,
      product TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      slack_thread_ts TEXT,
      slack_channel TEXT,
      pr_url TEXT,
      branch_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      agent_active INTEGER NOT NULL DEFAULT 1,
      last_heartbeat TEXT,
      transcript_r2_key TEXT,
      session_id TEXT
    )
  `);

  // Products table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS products (
      slug TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Settings table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Token usage table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      task_uuid TEXT PRIMARY KEY,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0.0,
      turns INTEGER NOT NULL DEFAULT 0,
      session_message_count INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Slack thread → Linear issue mapping
  sql.exec(`
    CREATE TABLE IF NOT EXISTS slack_thread_map (
      linear_issue_id TEXT PRIMARY KEY,
      slack_thread_ts TEXT NOT NULL,
      slack_channel TEXT NOT NULL
    )
  `);

  // Task queue table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      task_uuid TEXT NOT NULL,
      product TEXT NOT NULL,
      priority INTEGER DEFAULT 3,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Task metrics table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS task_metrics (
      task_uuid TEXT PRIMARY KEY,
      outcome TEXT,
      pr_count INTEGER NOT NULL DEFAULT 0,
      revision_count INTEGER NOT NULL DEFAULT 0,
      total_agent_time_ms INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0.0,
      hands_on_sessions INTEGER NOT NULL DEFAULT 0,
      hands_on_notes TEXT,
      first_response_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrations: add columns that may not exist on older deployments
  const addColumn = (table: string, colDef: string) => {
    try {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
        console.error(`[db] Failed to add column (${colDef}) to ${table}:`, err);
        throw err;
      }
    }
  };

  addColumn("tasks", "agent_active INTEGER NOT NULL DEFAULT 1");
  addColumn("tasks", "last_heartbeat TEXT");
  addColumn("tasks", "transcript_r2_key TEXT");
  addColumn("tasks", "session_id TEXT");
  addColumn("tasks", "identifier TEXT"); // renamed to task_id below
  addColumn("tasks", "title TEXT");
  addColumn("tasks", "agent_message TEXT");
  addColumn("tasks", "checks_passed INTEGER DEFAULT 0");
  addColumn("tasks", "last_merge_decision_sha TEXT");

  // Merge gate retry state
  sql.exec(`
    CREATE TABLE IF NOT EXISTS merge_gate_retries (
      task_uuid TEXT PRIMARY KEY,
      product TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'copilot'
    )
  `);

  // Migration: add phase column if missing
  try {
    sql.exec(`ALTER TABLE merge_gate_retries ADD COLUMN phase TEXT NOT NULL DEFAULT 'copilot'`);
  } catch {
    // Column already exists
  }

  // Migration: rename id → ticket_uuid (legacy)
  try {
    sql.exec(`ALTER TABLE tickets RENAME COLUMN id TO ticket_uuid`);
  } catch {
    // Column already renamed or table created with new name
  }
  // Migration: rename identifier → ticket_id (legacy)
  try {
    sql.exec(`ALTER TABLE tickets RENAME COLUMN identifier TO ticket_id`);
  } catch {
    // Column already renamed or table created with new name
  }
  // Migration: rename ticket_id → ticket_uuid in merge_gate_retries (legacy)
  try {
    sql.exec(`ALTER TABLE merge_gate_retries RENAME COLUMN ticket_id TO ticket_uuid`);
  } catch {}
  // Migration: rename ticket_id → ticket_uuid in token_usage (legacy)
  try {
    sql.exec(`ALTER TABLE token_usage RENAME COLUMN ticket_id TO ticket_uuid`);
  } catch {}
  // Migration: rename ticket_id → ticket_uuid in ticket_queue (legacy)
  try {
    sql.exec(`ALTER TABLE ticket_queue RENAME COLUMN ticket_id TO ticket_uuid`);
  } catch {}
  // Migration: rename ticket_id → ticket_uuid in ticket_metrics (legacy)
  try {
    sql.exec(`ALTER TABLE ticket_metrics RENAME COLUMN ticket_id TO ticket_uuid`);
  } catch {}

  addColumn("tasks", "ci_status TEXT DEFAULT NULL");
  addColumn("tasks", "needs_attention INTEGER DEFAULT 0");
  addColumn("tasks", "needs_attention_reason TEXT DEFAULT NULL");

  // Migration: rename ticket terminology → task (tables first, then columns)
  try { sql.exec("ALTER TABLE tickets RENAME TO tasks"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE ticket_queue RENAME TO task_queue"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE ticket_metrics RENAME TO task_metrics"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE tasks RENAME COLUMN ticket_uuid TO task_uuid"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE tasks RENAME COLUMN ticket_id TO task_id"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE task_queue RENAME COLUMN ticket_uuid TO task_uuid"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE task_metrics RENAME COLUMN ticket_uuid TO task_uuid"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE merge_gate_retries RENAME COLUMN ticket_uuid TO task_uuid"); } catch { /* already renamed */ }
  try { sql.exec("ALTER TABLE token_usage RENAME COLUMN ticket_uuid TO task_uuid"); } catch { /* already renamed */ }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

/** Look up a setting value by key. Returns null if not found. */
export function getSetting(sql: SqlExec, key: string): string | null {
  const rows = sql.exec(
    "SELECT value FROM settings WHERE key = ?", key,
  ).toArray() as Array<{ value: string }>;
  return rows.length > 0 ? rows[0].value : null;
}

/** Upsert a setting value. */
export function setSetting(sql: SqlExec, key: string, value: string): void {
  sql.exec(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    value,
  );
}

// ---------------------------------------------------------------------------
// Gateway config
// ---------------------------------------------------------------------------

/** Parse the cloudflare_ai_gateway setting. Returns null if not configured. */
export function getGatewayConfig(sql: SqlExec): CloudflareAIGateway | null {
  const raw = getSetting(sql, "cloudflare_ai_gateway");
  if (!raw) return null;
  return JSON.parse(raw) as CloudflareAIGateway;
}

// ---------------------------------------------------------------------------
// Product config helpers
// ---------------------------------------------------------------------------

/** Get a single product's parsed config by slug. Returns null if not found. */
export function getProductConfig(sql: SqlExec, slug: string): ProductConfig | null {
  const rows = sql.exec(
    "SELECT config FROM products WHERE slug = ?", slug,
  ).toArray() as Array<{ config: string }>;
  if (rows.length === 0) return null;
  return JSON.parse(rows[0].config) as ProductConfig;
}

/** Get all products as a Record<slug, ProductConfig>. */
export function getAllProductConfigs(sql: SqlExec): Record<string, ProductConfig> {
  const rows = sql.exec(
    "SELECT slug, config FROM products ORDER BY slug",
  ).toArray() as Array<{ slug: string; config: string }>;

  return rows.reduce((acc, row) => {
    acc[row.slug] = JSON.parse(row.config) as ProductConfig;
    return acc;
  }, {} as Record<string, ProductConfig>);
}

// ---------------------------------------------------------------------------
// Task metrics
// ---------------------------------------------------------------------------

/** Idempotent creation of a task_metrics row. */
export function ensureTaskMetrics(sql: SqlExec, taskUUID: string): void {
  sql.exec(
    `INSERT INTO task_metrics (task_uuid) VALUES (?)
     ON CONFLICT(task_uuid) DO NOTHING`,
    taskUUID,
  );
}
