/** Statuses that represent completed/closed tickets — agents should not restart for these. */
export const TERMINAL_STATUSES = ["merged", "closed", "deferred", "failed"] as const;
export type TerminalStatus = typeof TERMINAL_STATUSES[number];

export interface TicketEvent {
  type: string;       // "ticket_created", "ticket_updated", "pr_review", "pr_merged", "ci_status", "slack_mention", "slack_reply"
  source: string;     // "linear", "github", "slack", "api"
  ticketId: string;
  product: string;
  payload: unknown;
  slackThreadTs?: string;
  slackChannel?: string;
}

export interface TicketRecord {
  id: string;
  product: string;
  status: string;
  slack_thread_ts: string | null;
  slack_channel: string | null;
  pr_url: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketAgentConfig {
  ticketId: string;
  product: string;
  repos: string[];
  slackChannel: string;
  secrets: Record<string, string>; // logical name → binding name
  gatewayConfig?: { account_id: string; gateway_id: string } | null;
  model?: string; // Claude model to use (e.g., "sonnet", "opus", "haiku")
}

export interface Bindings {
  ORCHESTRATOR: DurableObjectNamespace;
  TICKET_AGENT: DurableObjectNamespace;

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
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  SENTRY_DSN: string;
  NOTION_TOKEN: string;
  SENTRY_ACCESS_TOKEN: string;
  CONTEXT7_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAILS?: string; // Comma-separated list of allowed email addresses

  // Google OAuth for dashboard
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_ALLOWED_DOMAIN: string;

  // Per-product GitHub tokens
  HEALTH_TOOL_GITHUB_TOKEN: string;
  BIKE_TOOL_GITHUB_TOKEN: string;
  PRODUCT_ENGINEER_GITHUB_TOKEN: string;

  [key: string]: unknown;
}
