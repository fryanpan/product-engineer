/**
 * Observability, status, and metrics queries.
 *
 * All functions accept a `SqlExec` handle and return plain data objects.
 * The orchestrator wraps the return values in `Response.json()`.
 */

import type { SqlExec } from "./db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveAgent {
  ticket_uuid: string;
  ticket_id: string | null;
  product: string;
  status: string;
  agent_message: string | null;
  last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
  pr_url: string | null;
  branch_name: string | null;
  slack_thread_ts: string | null;
  slack_channel: string | null;
}

export interface RecentCompleted {
  ticket_uuid: string;
  ticket_id: string | null;
  product: string;
  status: string;
  updated_at: string;
  pr_url: string | null;
}

export interface StaleAgent {
  ticket_uuid: string;
  product: string;
  status: string;
  last_heartbeat: string;
}

export interface SystemStatusData {
  activeAgents: ActiveAgent[];
  recentCompleted: RecentCompleted[];
  staleAgents: StaleAgent[];
  summary: {
    totalActive: number;
    totalCompleted: number;
    totalStale: number;
  };
}

export interface TranscriptRow {
  ticketUUID: string;
  ticketId: string;
  product: string;
  status: string;
  r2Key: string;
  uploadedAt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function getHealthEmoji(lastHeartbeat: string): string {
  const minutesSinceHeartbeat = Math.floor(
    (Date.now() - new Date(lastHeartbeat).getTime()) / 60000
  );
  if (minutesSinceHeartbeat < 5) return "💚"; // Fresh
  if (minutesSinceHeartbeat < 15) return "💛"; // Recent
  if (minutesSinceHeartbeat < 30) return "🧡"; // Getting stale
  return "❤️"; // Stale
}

export function getStatusEmoji(status: string): string {
  const statusMap: Record<string, string> = {
    in_progress: "⏳",
    pr_open: "👀",
    in_review: "👀",
    needs_revision: "🔄",
    merged: "✅",
    closed: "✅",
    failed: "❌",
    deferred: "⏸️",
    asking: "❓",
  };
  return statusMap[status] || "⏳";
}

export function getTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export function getSystemStatus(sql: SqlExec): SystemStatusData {
  // Get active agents
  const activeAgents = sql.exec(
    `SELECT ticket_uuid, ticket_id, product, status, agent_message, last_heartbeat, created_at, updated_at, pr_url, branch_name, slack_thread_ts, slack_channel
     FROM tickets
     WHERE agent_active = 1
     ORDER BY updated_at DESC`,
  ).toArray() as unknown as ActiveAgent[];

  // Get recent completed tickets (last 24 hours)
  const recentCompleted = sql.exec(
    `SELECT ticket_uuid, ticket_id, product, status, updated_at, pr_url
     FROM tickets
     WHERE agent_active = 0
       AND (julianday('now') - julianday(updated_at)) * 24 < 24
     ORDER BY updated_at DESC
     LIMIT 10`,
  ).toArray() as unknown as RecentCompleted[];

  // Get stale agents (no heartbeat in 30 minutes)
  const staleAgents = sql.exec(
    `SELECT ticket_uuid, product, status, last_heartbeat
     FROM tickets
     WHERE agent_active = 1
       AND last_heartbeat IS NOT NULL
       AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > 30`,
  ).toArray() as unknown as StaleAgent[];

  return {
    activeAgents,
    recentCompleted,
    staleAgents,
    summary: {
      totalActive: activeAgents.length,
      totalCompleted: recentCompleted.length,
      totalStale: staleAgents.length,
    },
  };
}

export function checkAgentHealth(sql: SqlExec): { staleAgents: Array<{ ticketUUID: string; product: string; status: string; minutesStuck: number; lastHeartbeat: string }> } {
  const stuckThreshold = 30; // minutes
  const rows = sql.exec(
    `SELECT ticket_uuid, product, status, last_heartbeat
     FROM tickets
     WHERE agent_active = 1
       AND last_heartbeat IS NOT NULL
       AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > ?`,
    stuckThreshold,
  ).toArray() as Array<{
    ticket_uuid: string;
    product: string;
    status: string;
    last_heartbeat: string;
  }>;

  const staleAgents = rows.map((ticket) => ({
    ticketUUID: ticket.ticket_uuid,
    product: ticket.product,
    status: ticket.status,
    minutesStuck: Math.floor(
      (Date.now() - new Date(ticket.last_heartbeat).getTime()) / 60000,
    ),
    lastHeartbeat: ticket.last_heartbeat,
  }));

  if (staleAgents.length > 0) {
    console.log(`[Orchestrator] Health check: ${staleAgents.length} stale agents found`);
  }

  return { staleAgents };
}

export function listTickets(sql: SqlExec): { tickets: Record<string, unknown>[] } {
  const rows = sql.exec(
    "SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 50",
  ).toArray();
  return { tickets: rows };
}

export function listTranscripts(sql: SqlExec, opts: { limit: number; sinceHours?: number }): { transcripts: TranscriptRow[] } {
  const params: (string | number)[] = [];
  let query = `
    SELECT
      ticket_uuid as ticketUUID,
      COALESCE(ticket_id, ticket_uuid) as ticketId,
      product,
      status,
      transcript_r2_key as r2Key,
      updated_at as uploadedAt
    FROM tickets
    WHERE transcript_r2_key IS NOT NULL
  `;

  if (opts.sinceHours) {
    query += ` AND (julianday('now') - julianday(updated_at)) * 24 < ?`;
    params.push(opts.sinceHours);
  }

  query += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(opts.limit);

  const rows = sql.exec(query, ...params).toArray() as unknown as TranscriptRow[];

  return { transcripts: rows };
}

export function getMetrics(sql: SqlExec, opts: { limit: number; days: number }): { metrics: Record<string, unknown>[] } {
  const metrics = sql.exec(`
    SELECT
      m.*,
      t.ticket_id,
      t.title,
      t.product,
      t.status as ticket_status,
      t.created_at as ticket_created_at,
      u.total_input_tokens,
      u.total_output_tokens,
      u.total_cache_read_tokens,
      u.total_cache_creation_tokens,
      u.turns,
      u.session_message_count
    FROM ticket_metrics m
    LEFT JOIN tickets t ON m.ticket_uuid = t.ticket_uuid
    LEFT JOIN token_usage u ON m.ticket_uuid = u.ticket_uuid
    WHERE t.created_at > datetime('now', '-' || ? || ' days')
    ORDER BY t.created_at DESC
    LIMIT ?
  `, opts.days, opts.limit).toArray();

  return { metrics };
}

export function getMetricsSummary(sql: SqlExec): Record<string, unknown> {
  // Overall statistics
  const totalTickets = sql.exec(
    `SELECT COUNT(*) as count FROM ticket_metrics`
  ).toArray()[0] as { count: number };

  // Outcome distribution
  const outcomes = sql.exec(`
    SELECT
      outcome,
      COUNT(*) as count
    FROM ticket_metrics
    WHERE outcome IS NOT NULL
    GROUP BY outcome
  `).toArray() as Array<{ outcome: string; count: number }>;

  // Calculate automerge rate (automerge_success / total completed)
  const completed = outcomes.reduce((sum, o) => sum + o.count, 0);
  const automergeSuccess = outcomes.find(o => o.outcome === "automerge_success")?.count || 0;
  const automergeRate = completed > 0 ? (automergeSuccess / completed * 100).toFixed(1) : "N/A";

  // Failure rate (failed / total)
  const failed = outcomes.find(o => o.outcome === "failed")?.count || 0;
  const failureRate = completed > 0 ? (failed / completed * 100).toFixed(1) : "N/A";

  // Multi-PR rate (tickets needing 2+ PRs)
  const multiPrTickets = sql.exec(
    `SELECT COUNT(*) as count FROM ticket_metrics WHERE pr_count >= 2`
  ).toArray()[0] as { count: number };
  const multiPrRate = completed > 0 ? (multiPrTickets.count / completed * 100).toFixed(1) : "N/A";

  // Multi-revision rate (tickets sent back 2+ times for 3+ total attempts)
  const multiRevisionTickets = sql.exec(
    `SELECT COUNT(*) as count FROM ticket_metrics WHERE revision_count >= 2`
  ).toArray()[0] as { count: number };
  const multiRevisionRate = completed > 0 ? (multiRevisionTickets.count / completed * 100).toFixed(1) : "N/A";

  // Cost statistics
  const costStats = sql.exec(`
    SELECT
      SUM(total_cost_usd) as total_cost,
      AVG(total_cost_usd) as avg_cost,
      MAX(total_cost_usd) as max_cost
    FROM ticket_metrics
    WHERE total_cost_usd > 0
  `).toArray()[0] as { total_cost: number; avg_cost: number; max_cost: number } | undefined;

  // Daily cost (last 7 days)
  const dailyCost = sql.exec(`
    SELECT
      date(created_at) as day,
      SUM(total_cost_usd) as cost,
      COUNT(*) as tickets
    FROM ticket_metrics
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY date(created_at)
    ORDER BY day DESC
  `).toArray() as Array<{ day: string; cost: number; tickets: number }>;

  // Average time to completion
  const avgCompletionTime = sql.exec(`
    SELECT AVG(
      (julianday(completed_at) - julianday(created_at)) * 24 * 60
    ) as avg_minutes
    FROM ticket_metrics
    WHERE completed_at IS NOT NULL
  `).toArray()[0] as { avg_minutes: number | null };

  return {
    summary: {
      totalTickets: totalTickets.count,
      completed,
      automergeRate: automergeRate === "N/A" ? "N/A" : `${automergeRate}%`,
      failureRate: failureRate === "N/A" ? "N/A" : `${failureRate}%`,
      multiPrRate: multiPrRate === "N/A" ? "N/A" : `${multiPrRate}%`,
      multiRevisionRate: multiRevisionRate === "N/A" ? "N/A" : `${multiRevisionRate}%`,
      avgCompletionMinutes: avgCompletionTime.avg_minutes?.toFixed(1) || "N/A",
    },
    outcomes,
    costs: {
      total: costStats?.total_cost?.toFixed(2) || "0",
      average: costStats?.avg_cost?.toFixed(2) || "0",
      max: costStats?.max_cost?.toFixed(2) || "0",
      daily: dailyCost,
    },
  };
}

// ---------------------------------------------------------------------------
// Slack formatting
// ---------------------------------------------------------------------------

export function formatStatusMessage(statusData: SystemStatusData, channel: string): string {
  let message = `*🤖 Product Engineer Status*\n\n`;

  // Summary
  message += `*Summary:*\n`;
  message += `• Active agents: ${statusData.summary.totalActive}\n`;
  message += `• Completed (24h): ${statusData.summary.totalCompleted}\n`;
  if (statusData.summary.totalStale > 0) {
    message += `• ⚠️ Stale agents: ${statusData.summary.totalStale}\n`;
  }
  message += `\n`;

  // Active agents
  if (statusData.activeAgents.length > 0) {
    message += `*Active Agents:*\n`;
    for (const agent of statusData.activeAgents) {
      const healthEmoji = agent.last_heartbeat
        ? getHealthEmoji(agent.last_heartbeat)
        : "❓";
      const statusEm = getStatusEmoji(agent.status);
      const timeSinceUpdate = getTimeAgo(agent.updated_at);
      const ticketDisplay = agent.ticket_id ?? agent.ticket_uuid;

      message += `${healthEmoji} ${statusEm} \`${ticketDisplay}\` (${agent.product})\n`;
      const phaseInfo = agent.agent_message ? ` (${agent.agent_message})` : "";
      message += `   Status: ${agent.status}${phaseInfo} · Updated: ${timeSinceUpdate}\n`;
      if (agent.pr_url) {
        message += `   PR: ${agent.pr_url}\n`;
      }
      if (agent.slack_thread_ts) {
        const threadChannel = agent.slack_channel || channel;
        message += `   Thread: <#${threadChannel}|thread> (${agent.slack_thread_ts})\n`;
      }
    }
    message += `\n`;
  } else {
    message += `*No active agents*\n\n`;
  }

  // Stale agents warning
  if (statusData.staleAgents.length > 0) {
    message += `*⚠️ Stale Agents (no heartbeat >30min):*\n`;
    for (const agent of statusData.staleAgents) {
      const minutesStale = Math.floor(
        (Date.now() - new Date(agent.last_heartbeat).getTime()) / 60000
      );
      message += `• \`${agent.ticket_uuid}\` (${agent.product}) - ${minutesStale}m ago\n`;
    }
    message += `\n`;
  }

  // Recent completions
  if (statusData.recentCompleted.length > 0) {
    message += `*Recent Completions (24h):*\n`;
    for (const ticket of statusData.recentCompleted.slice(0, 5)) {
      const statusEm = getStatusEmoji(ticket.status);
      const timeAgo = getTimeAgo(ticket.updated_at);
      const ticketDisplay = ticket.ticket_id ?? ticket.ticket_uuid;
      message += `${statusEm} \`${ticketDisplay}\` (${ticket.product}) - ${timeAgo}\n`;
      if (ticket.pr_url) {
        message += `   ${ticket.pr_url}\n`;
      }
    }
  }

  return message;
}
