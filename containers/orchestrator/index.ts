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
