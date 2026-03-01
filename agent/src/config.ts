/**
 * Agent configuration from environment variables.
 *
 * The orchestrator injects these into the sandbox container.
 * Secret names are resolved per-product by the orchestrator.
 */

export type TaskType = "feedback" | "ticket" | "command";

export interface TaskPayload {
  type: TaskType;
  product: string;
  repos: string[];
  data: FeedbackData | TicketData | CommandData;
}

export interface FeedbackData {
  id: string;
  text: string | null;
  annotations: string | null;
  page_url: string | null;
  screenshot: string | null;
  callback_url?: string;
}

export interface TicketData {
  id: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
}

export interface CommandData {
  text: string;
  user: string;
  channel: string;
  thread_ts?: string;
}

export interface AgentConfig {
  taskPayload: TaskPayload;
  anthropicApiKey: string;
  githubToken: string;
  slackBotToken: string;
  slackChannel: string;
  slackAppToken: string;
  slackThreadTs: string;
  linearApiKey: string;
  orchestratorUrl: string;
  orchestratorApiKey: string;
}

export function loadConfig(): AgentConfig {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
  };

  return {
    taskPayload: JSON.parse(required("TASK_PAYLOAD")),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    githubToken: required("GITHUB_TOKEN"),
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackChannel: process.env.SLACK_CHANNEL || "#general",
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackThreadTs: process.env.SLACK_THREAD_TS || "",
    linearApiKey: required("LINEAR_API_KEY"),
    orchestratorUrl: process.env.ORCHESTRATOR_URL || "",
    orchestratorApiKey: process.env.ORCHESTRATOR_API_KEY || "",
  };
}
