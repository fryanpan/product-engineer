/**
 * Product Engineer Orchestrator — shared Cloudflare Worker.
 *
 * Receives triggers from multiple sources (Linear webhooks, Slack commands,
 * per-product dispatch API, GitHub webhooks) and launches sandbox containers
 * with the generic Product Engineer agent.
 *
 * This worker does NO AI decision-making — it's pure dispatch.
 */

import { Hono } from "hono";
import { dispatch } from "./dispatch";
import { linearWebhook } from "./linear-webhook";
import { slackCommands } from "./slack-commands";
import { githubWebhook } from "./github-webhook";

// Sandbox Durable Object class — required by wrangler for the [[containers]] binding
export { Sandbox } from "@cloudflare/sandbox";
import { getProduct } from "./registry";
import { launchSandbox, type SandboxEnv } from "./sandbox";

export interface Bindings {
  // Queue
  TASK_QUEUE: Queue;

  // Sandbox (Durable Object → Container)
  Sandbox: DurableObjectNamespace;

  // Secrets
  API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  ORCHESTRATOR_URL: string;

  // Per-product GitHub tokens
  HEALTH_TOOL_GITHUB_TOKEN: string;
  BIKE_TOOL_GITHUB_TOKEN: string;

  [key: string]: unknown;
}

const app = new Hono<{ Bindings: Bindings }>();

// Health check
app.get("/health", (c) => c.json({ ok: true, service: "product-engineer-orchestrator" }));

// Dispatch API (for per-product workers)
app.route("/api/dispatch", dispatch);
app.route("/api", dispatch); // Also mount task status routes under /api

// Webhook handlers
app.route("/api/webhooks/linear", linearWebhook);
app.route("/api/webhooks/slack", slackCommands);
app.route("/api/webhooks/github", githubWebhook);

export default {
  fetch: app.fetch,

  // Queue consumer: process dispatched tasks
  async queue(
    batch: MessageBatch<{
      type: "feedback" | "ticket" | "command";
      product: string;
      data: unknown;
      slack_thread_ts?: string;
    }>,
    env: Bindings,
  ) {
    for (const msg of batch.messages) {
      const { type, product, data, slack_thread_ts } = msg.body;

      const productConfig = getProduct(product);
      if (!productConfig) {
        console.error(`[Queue] Unknown product: ${product}`);
        msg.ack();
        continue;
      }

      // Determine task ID for sandbox naming
      const taskId =
        type === "feedback"
          ? (data as { id: string }).id
          : type === "ticket"
            ? (data as { id: string }).id
            : `cmd-${Date.now()}`;

      // Post initial Slack notification
      let threadTs = slack_thread_ts;
      try {
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: productConfig.slack_channel,
            text: `🔍 *${product}* — Agent picking up ${type}: ${summarizeTask(type, data)}`,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          }),
        });
        if (res.ok) {
          const resData = (await res.json()) as { ok: boolean; ts?: string };
          if (resData.ok && resData.ts && !threadTs) {
            threadTs = resData.ts;
          }
        }
      } catch {
        // Slack notification is best-effort
      }

      // Launch the sandbox
      try {
        await launchSandbox({
          taskId,
          product,
          productConfig,
          taskPayload: { type, data },
          env: env as unknown as SandboxEnv,
          slackThreadTs: threadTs,
        });
        console.log(`[Queue] ${product}/${taskId} completed`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Queue] ${product}/${taskId} failed: ${errMsg}`);

        // Notify Slack of failure
        try {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              channel: productConfig.slack_channel,
              text: `❌ *${product}* — Agent failed on ${type} ${taskId}: ${errMsg.slice(0, 200)}`,
              ...(threadTs ? { thread_ts: threadTs } : {}),
            }),
          });
        } catch {
          // Best-effort
        }
      }

      msg.ack();
    }
  },
};

function summarizeTask(
  type: string,
  data: unknown,
): string {
  const d = data as Record<string, unknown>;
  switch (type) {
    case "feedback":
      return (d.text as string)?.slice(0, 80) || "(annotations)";
    case "ticket":
      return (d.title as string)?.slice(0, 80) || "(no title)";
    case "command":
      return (d.text as string)?.slice(0, 80) || "(empty command)";
    default:
      return "(unknown)";
  }
}
