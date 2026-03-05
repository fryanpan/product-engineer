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
  identifier?: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  url_private_download: string;
  permalink: string;
  filetype: string;
  size: number;
}

export interface CommandData {
  text: string;
  user: string;
  channel: string;
  thread_ts?: string;
  files?: SlackFile[];
}

/** A single content block (text or image) in a structured message. */
export interface ContentBlock {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
}

/** Content that can be passed to the Agent SDK — plain text or structured blocks with images. */
export type MessageContent = string | ContentBlock[];

const IMAGE_MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

/** Normalize a MIME type to one the Anthropic API accepts, defaulting to image/png. */
export function normalizeImageMediaType(mimetype: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  return IMAGE_MEDIA_TYPES[mimetype] || "image/png";
}

export interface TicketEvent {
  type: string;
  source: string;
  ticketId: string;
  product: string;
  payload: unknown;
  slackThreadTs?: string;
  slackChannel?: string;
}

export interface AgentConfig {
  ticketId: string;
  product: string;
  repos: string[];
  anthropicApiKey: string;
  githubToken: string;
  slackBotToken: string;
  slackChannel: string;
  slackThreadTs: string;
  linearApiKey: string;
  workerUrl: string;
  apiKey: string;
  ticketIdentifier?: string;  // e.g., "BC-84"
  ticketTitle?: string;        // Brief title for display
  model?: string;              // Claude model to use (sonnet, opus, haiku)
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
    slackThreadTs: process.env.SLACK_THREAD_TS || "",
    linearApiKey: process.env.LINEAR_API_KEY || "",
    workerUrl: required("WORKER_URL"),
    apiKey: process.env.API_KEY || "",
    ticketIdentifier: process.env.TICKET_IDENTIFIER || undefined,
    ticketTitle: process.env.TICKET_TITLE || undefined,
    model: process.env.MODEL || undefined,
  };
}
