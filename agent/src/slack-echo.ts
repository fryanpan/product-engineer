/**
 * SlackEcho — echoes Agent SDK messages and tool uses to a Slack thread.
 *
 * Non-tool assistant text posts immediately to Slack (no summarization).
 * Tool uses are buffered for up to 1 minute, then summarized via Claude Haiku
 * before posting. Posts immediately when ask_question is flushed.
 *
 * Fire-and-forget: all Slack posts silently catch errors.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlackPersona {
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
}

export interface SlackEchoConfig {
  slackBotToken: string;
  slackChannel: string;
  slackThreadTs?: string;
  slackPersona?: SlackPersona;
  anthropicApiKey?: string;
  fetchFn?: typeof fetch;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Aggregation window for tool use summaries. */
const RATE_LIMIT_MS = 60_000;
const MAX_SUMMARY_LENGTH = 500;
/** Maximum length for assistant text posts before truncation. */
const MAX_PASSTHROUGH_LENGTH = 3_000;

/** Tools that should NOT be echoed (they already post to Slack). */
const SKIP_TOOLS = new Set(["notify_slack", "ask_question", "update_task_status"]);

// ── Implementation ───────────────────────────────────────────────────────────

export class SlackEcho {
  private token: string;
  private channel: string;
  private threadTs: string | undefined;
  private persona: SlackPersona | undefined;
  private anthropicApiKey: string | undefined;
  private fetchFn: typeof fetch;

  private buffer: string[] = [];
  private rateLimitTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SlackEchoConfig) {
    this.token = config.slackBotToken;
    this.channel = config.slackChannel;
    this.threadTs = config.slackThreadTs;
    this.persona = config.slackPersona;
    this.anthropicApiKey = config.anthropicApiKey;
    this.fetchFn = config.fetchFn ?? fetch;

    this.rateLimitTimer = setInterval(() => {
      this.flushBuffer().catch(() => {});
    }, RATE_LIMIT_MS);
  }

  /** Update thread_ts (e.g., after first post creates a thread). */
  setThreadTs(ts: string): void {
    this.threadTs = ts;
  }

  /** Post assistant text immediately without buffering or summarization. */
  echoAssistantText(text: string): void {
    if (!this.threadTs) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const capped =
      trimmed.length > MAX_PASSTHROUGH_LENGTH
        ? trimmed.slice(0, MAX_PASSTHROUGH_LENGTH) + "... [truncated]"
        : trimmed;
    this.postImmediate(`\u{1F4AC} ${capped}`).catch(() => {});
  }

  /** Buffer a tool use for the next rate-limited flush. */
  echoToolUse(toolName: string, input: Record<string, unknown>): void {
    if (!this.threadTs) return;
    if (SKIP_TOOLS.has(toolName)) return;

    const summary = formatToolSummary(toolName, input);
    const entry = summary ? `[tool:${toolName}] ${summary}` : `[tool:${toolName}]`;
    this.buffer.push(entry);
  }

  /**
   * Flush the buffer immediately — used when ask_question fires so the
   * user sees the agent's current state before the question arrives.
   */
  async flush(): Promise<void> {
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }
    await this.flushBuffer();
    // Restart the timer after immediate flush
    this.rateLimitTimer = setInterval(() => {
      this.flushBuffer().catch(() => {});
    }, RATE_LIMIT_MS);
  }

  /** Stop the rate-limit timer (call at session end). */
  async stop(): Promise<void> {
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }
    await this.flushBuffer();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Post text immediately without buffering or summarization. */
  private async postImmediate(text: string): Promise<void> {
    await this.postToSlack(text);
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!this.threadTs) {
      this.buffer = [];
      return;
    }

    const raw = this.buffer.join("\n");
    this.buffer = [];

    const summary = await this.summarizeWithHaiku(raw);
    await this.postToSlack(`\u{1F527} ${summary}`);
  }

  private async summarizeWithHaiku(activity: string): Promise<string> {
    if (!this.anthropicApiKey) {
      // No API key — fall back to truncated raw text
      return activity.length > MAX_SUMMARY_LENGTH
        ? activity.slice(0, MAX_SUMMARY_LENGTH) + "..."
        : activity;
    }

    try {
      const response = await this.fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 120,
          messages: [
            {
              role: "user",
              content:
                "Summarize this AI coding agent activity in 1-2 concise sentences for a Slack status update. " +
                "Be specific: name which tools were used (e.g. 'read 3 files', 'ran tests', 'edited slack-echo.ts'), " +
                "and what was found or accomplished. No bullet points, no intro phrase.\n\n" +
                `Activity:\n${activity}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Haiku API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text: string }>;
      };
      const text = data.content?.find((b) => b.type === "text")?.text;
      return text?.trim() ?? activity.slice(0, MAX_SUMMARY_LENGTH);
    } catch (err) {
      console.error("[SlackEcho] Haiku summarization failed:", err);
      return activity.length > MAX_SUMMARY_LENGTH
        ? activity.slice(0, MAX_SUMMARY_LENGTH) + "..."
        : activity;
    }
  }

  private async postToSlack(text: string): Promise<void> {
    try {
      const personaFields = this.persona
        ? Object.fromEntries(
            Object.entries(this.persona).filter(([, v]) => v),
          )
        : {};

      await this.fetchFn("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: this.channel,
          text,
          thread_ts: this.threadTs,
          ...personaFields,
        }),
      });
    } catch (err) {
      console.error("[SlackEcho] Failed to post:", err);
    }
  }
}

// ── Tool formatting ──────────────────────────────────────────────────────────

/** Last two path segments for compact file display. */
function shortPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.length <= 2 ? parts.join("/") : parts.slice(-2).join("/");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export function formatToolSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  // Compact summaries — enough context to know what happened.
  switch (toolName) {
    case "Bash": {
      const desc = typeof input.description === "string" ? input.description : "";
      if (desc) return truncate(desc, 150);
      // Fall back to the command itself when no description is provided
      const cmd = typeof input.command === "string" ? input.command : "";
      return cmd ? truncate(cmd, 100) : "";
    }
    case "Read":
    case "Edit":
    case "Write": {
      const fp = typeof input.file_path === "string" ? input.file_path : "";
      return fp ? shortPath(fp) : "";
    }
    case "Grep": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const path = typeof input.path === "string" ? shortPath(input.path) : "";
      if (pattern && path) return `"${truncate(pattern, 50)}" in ${path}`;
      if (pattern) return `"${truncate(pattern, 50)}"`;
      return "";
    }
    case "Glob": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      return pattern ? truncate(pattern, 100) : "";
    }
    case "Agent": {
      const desc = typeof input.description === "string" ? input.description : "";
      return desc ? truncate(desc, 150) : "";
    }
    default:
      return "";
  }
}

