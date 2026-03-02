/**
 * GitHub webhook handler for PR events.
 *
 * Handles:
 * - PR merge: forwards pr_merged event to Orchestrator DO
 * - PR review: forwards pr_review event to Orchestrator DO
 *
 * All Slack notifications are handled by the agent, not here.
 */

import { Hono } from "hono";
import { loadRegistry } from "./registry";
import type { Bindings } from "./types";

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
  if (!receivedHex) {
    return c.json({ error: "Malformed signature" }, 401);
  }
  const hexPairs = receivedHex.match(/.{2}/g);
  if (!hexPairs) {
    return c.json({ error: "Malformed signature" }, 401);
  }
  const receivedBytes = new Uint8Array(
    hexPairs.map((b) => parseInt(b, 16)),
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

  if (event === "pull_request") {
    return handlePullRequest(rawBody, c.env);
  }

  if (event === "pull_request_review") {
    return handlePullRequestReview(rawBody, c.env);
  }

  return c.json({ ok: true, ignored: true });
});

async function handlePullRequest(rawBody: string, env: Bindings) {
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
    return Response.json({ ok: true, ignored: true });
  }

  // Extract task ID from branch name: feedback/<id> or ticket/<id>
  const branch = payload.pull_request.head.ref;
  const feedbackMatch = branch.match(/^feedback\/(.+)$/);
  const ticketMatch = branch.match(/^ticket\/(.+)$/);
  const taskId = feedbackMatch?.[1] || ticketMatch?.[1];

  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  // Find which product this repo belongs to
  const repoName = payload.repository.full_name;
  const registry = loadRegistry();
  let productName: string | null = null;

  for (const [name, config] of Object.entries(registry.products)) {
    if (config.repos.includes(repoName)) {
      productName = name;
      break;
    }
  }

  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  // Forward to Orchestrator DO
  const id = env.ORCHESTRATOR.idFromName("main");
  const orchestrator = env.ORCHESTRATOR.get(id);
  await orchestrator.fetch(new Request("http://internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "pr_merged",
      source: "github",
      ticketId: taskId,
      product: productName,
      payload: {
        pr_url: payload.pull_request.html_url,
        branch: branch,
        repo: repoName,
      },
    }),
  }));

  return Response.json({ ok: true, product: productName, taskId, status: "pr_merged" });
}

async function handlePullRequestReview(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    review: {
      state: string; // "approved", "changes_requested", "commented"
      body: string | null;
      user: { login: string };
      html_url: string;
    };
    pull_request: {
      head: { ref: string };
      html_url: string;
    };
    repository: {
      full_name: string;
    };
  };

  // Only handle submitted reviews
  if (payload.action !== "submitted") {
    return Response.json({ ok: true, ignored: true });
  }

  // Extract task ID from branch name
  const branch = payload.pull_request.head.ref;
  const feedbackMatch = branch.match(/^feedback\/(.+)$/);
  const ticketMatch = branch.match(/^ticket\/(.+)$/);
  const taskId = feedbackMatch?.[1] || ticketMatch?.[1];

  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  // Find which product this repo belongs to
  const repoName = payload.repository.full_name;
  const registry = loadRegistry();
  let productName: string | null = null;

  for (const [name, config] of Object.entries(registry.products)) {
    if (config.repos.includes(repoName)) {
      productName = name;
      break;
    }
  }

  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  // Forward to Orchestrator DO
  const id = env.ORCHESTRATOR.idFromName("main");
  const orchestrator = env.ORCHESTRATOR.get(id);
  await orchestrator.fetch(new Request("http://internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "pr_review",
      source: "github",
      ticketId: taskId,
      product: productName,
      payload: {
        pr_url: payload.pull_request.html_url,
        review_url: payload.review.html_url,
        review_state: payload.review.state,
        review_body: payload.review.body || "",
        reviewer: payload.review.user.login,
        branch: branch,
        repo: repoName,
      },
    }),
  }));

  return Response.json({ ok: true, product: productName, taskId, reviewState: payload.review.state });
}

export { githubWebhook };
