import * as Sentry from "@sentry/bun";
import { Hono } from "hono";
import { SlackSocket } from "./slack-socket";

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "orchestrator-container" }));

const slackAppToken = process.env.SLACK_APP_TOKEN;
if (slackAppToken) {
  // Resolve our bot's user ID so we can filter self-messages
  let botUserId: string | undefined;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (botToken) {
    try {
      const authRes = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}` },
      });
      const authData = (await authRes.json()) as { ok: boolean; user_id?: string };
      if (authData.ok && authData.user_id) {
        botUserId = authData.user_id;
        console.log(`[Orchestrator Container] Bot user ID: ${botUserId}`);
      }
    } catch (err) {
      console.error("[Orchestrator Container] Failed to resolve bot user ID:", err);
    }
  }

  const socket = new SlackSocket(slackAppToken, async (event) => {
    try {
      console.log(`[Orchestrator Container] Slack event: ${event.type} from ${event.user || "unknown"}`);
      const workerUrl = process.env.WORKER_URL;
      if (!workerUrl) {
        console.error("[Orchestrator Container] WORKER_URL not set — cannot forward Slack events");
        return;
      }
      await fetch(`${workerUrl}/api/internal/slack-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": process.env.SLACK_APP_TOKEN || "",
        },
        body: JSON.stringify(event),
      });
    } catch (err) {
      console.error("[Orchestrator Container] Failed to forward Slack event:", err);
    }
  }, botUserId, async (payload) => {
    try {
      const interactiveType = payload.type || "unknown";
      console.log(`[Orchestrator Container] Interactive payload: ${interactiveType}`);
      const workerUrl = process.env.WORKER_URL;
      if (!workerUrl) {
        console.error("[Orchestrator Container] WORKER_URL not set — cannot forward interactive payload");
        return;
      }
      await fetch(`${workerUrl}/api/internal/slack-interactive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": process.env.SLACK_APP_TOKEN || "",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("[Orchestrator Container] Failed to forward interactive payload:", err);
    }
  });

  socket.connect().catch((err) => {
    console.error("[Orchestrator Container] Failed to start Socket Mode:", err);
  });
} else {
  console.warn("[Orchestrator Container] No SLACK_APP_TOKEN — Socket Mode disabled");
}

export default {
  port: 3000,
  fetch: app.fetch,
};
