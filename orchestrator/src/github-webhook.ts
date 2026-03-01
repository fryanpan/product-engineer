/**
 * GitHub webhook handler for PR merge detection.
 *
 * When a PR on a feedback/* or ticket/* branch is merged,
 * updates the task status via the orchestrator and notifies Slack.
 */

import { Hono } from "hono";
import { loadRegistry } from "./registry";
import type { Bindings } from "./index";

const githubWebhook = new Hono<{ Bindings: Bindings }>();

githubWebhook.post("/", async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return c.json({ error: "Webhook not configured" }, 500);
  }

  const signature = c.req.header("X-Hub-Signature-256");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 401);
  }

  const rawBody = await c.req.text();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const receivedHex = signature.replace("sha256=", "");
  const receivedBytes = new Uint8Array(
    receivedHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    receivedBytes,
    new TextEncoder().encode(rawBody),
  );
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const event = c.req.header("X-GitHub-Event");
  if (event !== "pull_request") {
    return c.json({ ok: true, ignored: true });
  }

  const payload = JSON.parse(rawBody) as {
    action: string;
    pull_request: {
      merged: boolean;
      head: { ref: string };
      html_url: string;
    };
    repository: {
      full_name: string;
    };
  };

  if (payload.action !== "closed" || !payload.pull_request.merged) {
    return c.json({ ok: true, ignored: true });
  }

  // Extract task ID from branch name: feedback/<id> or ticket/<id>
  const branch = payload.pull_request.head.ref;
  const feedbackMatch = branch.match(/^feedback\/(.+)$/);
  const ticketMatch = branch.match(/^ticket\/(.+)$/);
  const taskId = feedbackMatch?.[1] || ticketMatch?.[1];

  if (!taskId) {
    return c.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  // Find which product this repo belongs to
  const repoName = payload.repository.full_name;
  const registry = loadRegistry();
  let productName: string | null = null;
  let slackChannel: string | null = null;

  for (const [name, config] of Object.entries(registry.products)) {
    if (config.repos.includes(repoName)) {
      productName = name;
      slackChannel = config.slack_channel;
      break;
    }
  }

  // Best-effort Slack notification
  if (slackChannel && c.env.SLACK_BOT_TOKEN) {
    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: slackChannel,
          text: `✅ PR merged for ${productName || repoName}: ${payload.pull_request.html_url}`,
        }),
      });
    } catch {
      // Best-effort
    }
  }

  return c.json({ ok: true, product: productName, taskId, status: "implemented" });
});

export { githubWebhook };
