/**
 * SlackEcho — echoes Agent SDK messages and tool uses to a Slack thread
 * without consuming LLM tokens.
 *
 * Fire-and-forget: all Slack posts silently catch errors.
 * Debounces assistant text (500ms) to batch rapid messages.
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
  fetchFn?: typeof fetch;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;
const MAX_TEXT_LENGTH = 3000;
const MAX_BASH_LENGTH = 200;
const MAX_OTHER_LENGTH = 150;

/** Tools that should NOT be echoed (they already post to Slack). */
const SKIP_TOOLS = new Set(["notify_slack", "ask_question", "update_task_status"]);

// ── Implementation ───────────────────────────────────────────────────────────

export class SlackEcho {
  private token: string;
  private channel: string;
  private threadTs: string | undefined;
  private persona: SlackPersona | undefined;
  private fetchFn: typeof fetch;

  private pendingText: string[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SlackEchoConfig) {
    this.token = config.slackBotToken;
    this.channel = config.slackChannel;
    this.threadTs = config.slackThreadTs;
    this.persona = config.slackPersona;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /** Update thread_ts (e.g., after first post creates a thread). */
  setThreadTs(ts: string): void {
    this.threadTs = ts;
  }

  /** Echo assistant text to Slack. Debounced 500ms to batch rapid messages. */
  echoAssistantText(text: string): void {
    if (!this.threadTs) return;

    this.pendingText.push(text);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushPendingText();
    }, DEBOUNCE_MS);
  }

  /** Echo a tool use to Slack. Posted immediately (no debounce). */
  echoToolUse(toolName: string, input: Record<string, unknown>): void {
    if (!this.threadTs) return;
    if (SKIP_TOOLS.has(toolName)) return;

    const summary = formatToolSummary(toolName, input);
    const message = `\u{1F527} \`${toolName}\` ${summary}`;

    this.postToSlack(message);
  }

  /** Flush any pending debounced assistant text immediately. */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.flushPendingText();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async flushPendingText(): Promise<void> {
    this.debounceTimer = null;

    if (this.pendingText.length === 0) return;

    const combined = this.pendingText.join("\n\n");
    this.pendingText = [];

    const truncated =
      combined.length > MAX_TEXT_LENGTH
        ? combined.slice(0, MAX_TEXT_LENGTH) + "..."
        : combined;

    const message = `\u{1F4AC} ${truncated}`;
    await this.postToSlack(message);
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
  // Compact summaries — just enough to know what happened, not the full input.
  switch (toolName) {
    case "Bash": {
      const desc = typeof input.description === "string" ? input.description : "";
      return desc ? truncate(desc, MAX_OTHER_LENGTH) : "";
    }
    case "Read":
    case "Edit":
    case "Write": {
      const fp = typeof input.file_path === "string" ? input.file_path : "";
      return fp ? `\`${shortPath(fp)}\`` : "";
    }
    case "Glob":
    case "Grep":
      return "";
    case "Agent": {
      const desc = typeof input.description === "string" ? input.description : "";
      return desc ? truncate(desc, MAX_OTHER_LENGTH) : "";
    }
    default:
      return "";
  }
}
