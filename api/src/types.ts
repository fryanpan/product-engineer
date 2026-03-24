/** Statuses that represent completed/closed tickets — agents should not restart for these. */
export const TERMINAL_STATUSES = ["merged", "closed", "deferred", "failed"] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

/** Valid ticket states — forms a state machine. */
export const TICKET_STATES = [
  "created", "reviewing", "needs_info", "queued", "spawning",
  "active", "pr_open", "escalated", "suspended",
  "merged", "closed", "deferred", "failed",
] as const;
export type TicketState = typeof TICKET_STATES[number];

/** Valid state transitions. Key = from state, value = allowed to states. */
export const VALID_TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
  created:     ["reviewing", "failed"],
  reviewing:   ["spawning", "needs_info", "queued", "closed", "deferred", "failed"],
  needs_info:  ["reviewing", "closed", "deferred", "failed"],
  queued:      ["reviewing", "spawning", "closed", "deferred", "failed"],
  spawning:    ["active", "failed"],
  active:      ["active", "pr_open", "suspended", "failed"],
  pr_open:     ["active", "merged", "escalated", "closed", "failed"],
  escalated:   ["active", "merged", "closed", "failed"],
  suspended:   ["active", "closed"],
  merged:      [],
  closed:      [],
  deferred:    [],
  failed:      [],
};

export interface TicketEvent {
  type: string;       // "ticket_created", "ticket_updated", "pr_review", "pr_merged", "ci_status", "slack_reply", "linear_comment"
  source: string;     // "linear", "github", "slack", "api"
  ticketUUID: string;
  product: string;
  payload: unknown;
  slackThreadTs?: string;
  slackChannel?: string;
  resumeSessionId?: string;
  resumeTranscriptR2Key?: string;
}

export interface TicketRecord {
  ticket_uuid: string;
  product: string;
  status: string;
  slack_thread_ts: string | null;
  slack_channel: string | null;
  pr_url: string | null;
  branch_name: string | null;
  ticket_id: string | null;
  title: string | null;
  agent_active: number;
  agent_message: string | null;
  checks_passed: number;
  last_merge_decision_sha: string | null;
  transcript_r2_key: string | null;
  session_id: string | null;
  last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketAgentConfig {
  ticketUUID: string;
  ticketId?: string; // Human-readable ID (e.g., "BC-172")
  ticketTitle?: string; // Brief title for display
  product: string;
  repos: string[];
  slackChannel: string;
  slackThreadTs?: string; // Thread to post replies to (if set from initial event)
  secrets: Record<string, string>; // logical name → binding name
  gatewayConfig?: { account_id: string; gateway_id: string } | null;
  model?: string; // Claude model to use (e.g., "sonnet", "opus", "haiku")
  mode?: "coding" | "research" | "flexible";
  slackPersona?: { username: string; icon_emoji?: string; icon_url?: string };
}

// Metrics types for observability
export interface TicketMetrics {
  ticket_id: string;
  outcome: "automerge_success" | "automerge_failure" | "manual_merge" | "closed" | "deferred" | "failed" | null;
  pr_count: number;           // Number of PRs created for this ticket
  revision_count: number;     // Times sent back for revision
  total_agent_time_ms: number;
  total_cost_usd: number;
  hands_on_sessions: number;
  hands_on_notes: string | null;
  first_response_at: string | null;
  completed_at: string | null;
}

export interface HeartbeatPayload {
  ticketUUID: string;
  message?: string;
  status?: TicketState;
  pr_url?: string;
  ci_status?: "pending" | "passing" | "failing" | "none";
  ready_to_merge?: boolean;
  needs_attention?: boolean;
  needs_attention_reason?: string;
}

export interface Bindings {
  ORCHESTRATOR: DurableObjectNamespace;
  TICKET_AGENT: DurableObjectNamespace;
  PROJECT_AGENT: DurableObjectNamespace;

  // R2 buckets
  TRANSCRIPTS: R2Bucket;

  // KV namespaces
  SESSIONS: KVNamespace;

  // Config vars
  WORKER_URL: string;

  // Secrets
  API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  LINEAR_APP_TOKEN: string;          // OAuth access token (actor=app)
  LINEAR_APP_CLIENT_ID: string;      // For token refresh
  LINEAR_APP_CLIENT_SECRET: string;  // For token refresh
  LINEAR_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  SENTRY_DSN: string;
  NOTION_TOKEN: string;
  SENTRY_ACCESS_TOKEN: string;
  CONTEXT7_API_KEY: string;

  // Google OAuth for dashboard
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_ALLOWED_DOMAIN?: string; // Optional - restricts access to specific domain
  ALLOWED_EMAILS: string; // Comma-separated list of allowed email addresses

  // Per-product GitHub tokens
  HEALTH_TOOL_GITHUB_TOKEN: string;
  BIKE_TOOL_GITHUB_TOKEN: string;
  PRODUCT_ENGINEER_GITHUB_TOKEN: string;

  [key: string]: unknown;
}
