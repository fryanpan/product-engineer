/**
 * Slack Socket Mode listener for receiving thread replies in real-time.
 *
 * Used for mid-task human feedback: the agent asks a question via Slack,
 * then listens for the reply using Socket Mode (WebSocket).
 */

export interface SlackReply {
  text: string;
  user: string;
}

interface SlackEnvelope {
  envelope_id: string;
  type: string;
  payload?: {
    event?: {
      type: string;
      thread_ts?: string;
      text?: string;
      user?: string;
      bot_id?: string;
    };
  };
}

export class SlackListener {
  private appToken: string;
  private threadTs: string;
  private ws: WebSocket | null = null;
  private listening = false;
  private replyResolve: ((reply: SlackReply | null) => void) | null = null;
  private ackSender: ((msg: string) => void) | null = null;

  constructor(appToken: string, threadTs: string) {
    this.appToken = appToken;
    this.threadTs = threadTs;
  }

  isListening(): boolean {
    return this.listening;
  }

  async start(): Promise<void> {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!res.ok) {
      throw new Error(`apps.connections.open failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      ok: boolean;
      url?: string;
      error?: string;
    };
    if (!data.ok || !data.url) {
      throw new Error(
        `Slack Socket Mode error: ${data.error || "no URL returned"}`,
      );
    }

    this.ws = new WebSocket(data.url);
    this.ackSender = (msg: string) => this.ws?.send(msg);
    this.listening = true;

    this.ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        ) as SlackEnvelope;
        this._handleMessage(envelope);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.addEventListener("close", () => {
      this.listening = false;
      if (this.replyResolve) {
        this.replyResolve(null);
        this.replyResolve = null;
      }
    });
  }

  waitForReply(timeoutMs: number): Promise<SlackReply | null> {
    return new Promise((resolve) => {
      this.replyResolve = resolve;
      setTimeout(() => {
        if (this.replyResolve === resolve) {
          this.replyResolve = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /** Handle an incoming Socket Mode envelope. Public for testing. */
  _handleMessage(envelope: SlackEnvelope): void {
    if (envelope.envelope_id && this.ackSender) {
      this.ackSender(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    const event = envelope.payload?.event;
    if (!event || event.type !== "message") return;
    if (event.thread_ts !== this.threadTs) return;
    if (event.bot_id) return;
    if (!event.text || !event.user) return;

    if (this.replyResolve) {
      const resolve = this.replyResolve;
      this.replyResolve = null;
      resolve({ text: event.text, user: event.user });
    }
  }

  /** Set a custom ack sender (for testing). */
  _setAckSender(sender: (msg: string) => void): void {
    this.ackSender = sender;
  }

  close(): void {
    this.listening = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
