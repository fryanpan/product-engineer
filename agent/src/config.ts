/**
 * Agent configuration from environment variables.
 *
 * The TicketAgent DO injects these into the sandbox container via envVars.
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
  ticketId: string;
  product: string;
  repos: string[];
  anthropicApiKey: string;
  githubToken: string;
  slackBotToken: string;
  slackChannel: string;
  linearApiKey: string;
}

export function loadConfig(): AgentConfig {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
  };

  return {
    ticketId: required("TICKET_ID"),
    product: required("PRODUCT"),
    repos: JSON.parse(required("REPOS")),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    githubToken: required("GITHUB_TOKEN"),
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackChannel: process.env.SLACK_CHANNEL || "#general",
    linearApiKey: process.env.LINEAR_API_KEY || "",
  };
}
