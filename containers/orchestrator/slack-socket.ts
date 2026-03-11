interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  url_private_download: string;
  permalink: string;
  filetype: string;
  size: number;
}

interface SlackEnvelope {
  envelope_id: string;
  type: string;
  payload?: {
    event?: {
      type: string;
      text?: string;
      user?: string;
      channel?: string;
      thread_ts?: string;
      ts: string;
      bot_id?: string;
      subtype?: string;
      files?: SlackFile[];
      slash_command?: string;
    };
  };
}

export class SlackSocket {
  private appToken: string;
  private botUserId: string | null = null;
  private onEvent: (event: NonNullable<SlackEnvelope["payload"]>["event"] & {}) => void;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60_000;

  constructor(
    appToken: string,
    onEvent: (event: NonNullable<SlackEnvelope["payload"]>["event"] & {}) => void,
    botUserId?: string,
  ) {
    this.appToken = appToken;
    this.onEvent = onEvent;
    this.botUserId = botUserId || null;
  }

  async connect(): Promise<void> {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const data = await res.json() as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) {
      throw new Error(`Slack Socket Mode error: ${data.error || "no URL"}`);
    }

    this.ws = new WebSocket(data.url);
    this.reconnectAttempts = 0;

    this.ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        ) as SlackEnvelope;

        if (envelope.envelope_id) {
          this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }

        const slackEvent = envelope.payload?.event;
        // Filter out messages from our own bot to prevent loops.
        // We check user ID (not bot_id) because app OAuth tokens produce
        // messages with bot_id even when posted by a real user.
        // Fallback: if botUserId is unknown, filter by bot_id to prevent loops.
        const isOwnBot = this.botUserId
          ? slackEvent?.user === this.botUserId
          : !!slackEvent?.bot_id;
        if (slackEvent && !isOwnBot) {
          if (slackEvent.type === "app_mention") {
            // Check if this is a /agent-status command mention
            const text = slackEvent.text?.trim() || "";
            if (/(^|\s)\/agent-status(\s|$)/.test(text)) {
              this.onEvent({ ...slackEvent, slash_command: "agent-status" });
            } else {
              this.onEvent(slackEvent);
            }
          } else if (slackEvent.type === "message" && slackEvent.thread_ts && !slackEvent.subtype) {
            // Only forward thread replies (not top-level messages, edits, joins, etc.)
            this.onEvent(slackEvent);
          } else if (slackEvent.type === "message" && !slackEvent.thread_ts && !slackEvent.subtype) {
            // Check for slash commands in top-level messages
            const text = slackEvent.text?.trim() || "";
            if (/(^|\s)\/agent-status(\s|$)/.test(text)) {
              // Mark as slash command for special handling
              this.onEvent({ ...slackEvent, slash_command: "agent-status" });
            }
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.addEventListener("close", () => {
      console.log("[SlackSocket] Connection closed, reconnecting...");
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[SlackSocket] Error:", err);
    });

    console.log("[SlackSocket] Connected to Slack Socket Mode");
  }

  private scheduleReconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;
    console.log(`[SlackSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect().catch(console.error), delay);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
