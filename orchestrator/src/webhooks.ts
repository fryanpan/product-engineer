/**
 * Webhook handlers for Linear and GitHub events.
 *
 * Shared HMAC verification. Per-source event parsing and routing.
 */

import { Hono } from "hono";
import { getAgentIdentity, getProductByLinearProject, isOurTeam, loadRegistry } from "./registry";
import type { Bindings } from "./types";

// --- Shared helpers (exported for testing) ---

export async function verifyHmac(
  body: string,
  secret: string,
  signatureHex: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const hexPairs = signatureHex.match(/.{2}/g);
  if (!hexPairs) return false;
  const receivedBytes = new Uint8Array(
    hexPairs.map((b) => parseInt(b, 16)),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    receivedBytes,
    new TextEncoder().encode(body),
  );
}

export function extractTaskId(branch: string): string | null {
  return branch.match(/^(?:feedback|ticket)\/(.+)$/)?.[1] ?? null;
}

export function resolveProductByRepo(repoFullName: string): string | null {
  const registry = loadRegistry();
  for (const [name, config] of Object.entries(registry.products)) {
    if (config.repos.includes(repoFullName)) return name;
  }
  return null;
}

function forwardToOrchestrator(env: Bindings, event: Record<string, unknown>) {
  const id = env.ORCHESTRATOR.idFromName("main");
  const orchestrator = env.ORCHESTRATOR.get(id);
  return orchestrator.fetch(new Request("http://internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }));
}

// --- Linear API helpers ---

async function linearGraphQL(apiKey: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

/** Best-effort: look up agent's Linear user ID by email, then assign the issue. */
export async function assignTicketToAgent(apiKey: string, issueId: string, agentEmail: string) {
  try {
    const userData = await linearGraphQL(
      apiKey,
      `query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id } } }`,
      { email: agentEmail },
    ) as { data?: { users?: { nodes?: { id: string }[] } } };

    const userId = userData.data?.users?.nodes?.[0]?.id;
    if (!userId) {
      console.warn(`[Linear] Could not find user with email ${agentEmail}`);
      return;
    }

    await linearGraphQL(
      apiKey,
      `mutation($id: String!, $assigneeId: String!) { issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success } }`,
      { id: issueId, assigneeId: userId },
    );
  } catch (err) {
    console.error("[Linear] Failed to assign ticket:", err);
  }
}

// --- Linear webhook ---

interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    identifier?: string | null;
    title: string;
    description: string;
    priority: number;
    teamId: string;
    labelIds?: string[];
    state?: { name: string };
    assignee?: { id: string; name: string; email?: string };
    project?: { id: string; name: string };
  };
}

const linearWebhook = new Hono<{ Bindings: Bindings }>();

linearWebhook.post("/", async (c) => {
  const webhookSecret = c.env.LINEAR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return c.json({ error: "Webhook not configured" }, 500);
  }

  const signature = c.req.header("Linear-Signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 401);
  }

  const rawBody = await c.req.text();
  if (!(await verifyHmac(rawBody, webhookSecret, signature))) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody) as LinearWebhookPayload;

  // Only handle issues
  if (payload.type !== "Issue") {
    return c.json({ ok: true, ignored: true });
  }

  if (!isOurTeam(payload.data.teamId)) {
    return c.json({ ok: true, ignored: true, reason: "not our team" });
  }

  const projectName = payload.data.project?.name;
  if (!projectName) {
    return c.json({
      ok: true,
      ignored: true,
      reason: "no project — cannot determine product",
    });
  }

  const match = getProductByLinearProject(projectName);
  if (!match) {
    return c.json({
      ok: true,
      ignored: true,
      reason: `unknown project: ${projectName}`,
    });
  }

  // Trigger conditions: create or assigned to agent (but not if already in terminal state)
  const agent = getAgentIdentity();
  const isAssignedToAgent =
    payload.data.assignee?.email === agent.linear_email ||
    payload.data.assignee?.name === agent.linear_name;

  // Ignore terminal states even if assigned to agent
  const terminalStates = ["Done", "Canceled", "Cancelled"];
  const isTerminal = payload.data.state?.name && terminalStates.includes(payload.data.state.name);

  const shouldTrigger =
    payload.action === "create" ||
    (payload.action === "update" && isAssignedToAgent && !isTerminal);

  if (!shouldTrigger) {
    return c.json({ ok: true, ignored: true, reason: "action not relevant" });
  }

  await forwardToOrchestrator(c.env, {
    type: "ticket_created",
    source: "linear",
    ticketId: payload.data.id,
    product: match.name,
    payload: {
      id: payload.data.id,
      identifier: payload.data.identifier,
      title: payload.data.title,
      description: payload.data.description || "",
      priority: payload.data.priority,
      labels: payload.data.labelIds || [],
    },
  });

  // Self-assign in Linear if not already assigned to agent
  if (!isAssignedToAgent) {
    assignTicketToAgent(c.env.LINEAR_API_KEY, payload.data.id, agent.linear_email);
  }

  return c.json({
    ok: true,
    product: match.name,
    project: projectName,
    ticketId: payload.data.id,
  });
});

// --- GitHub webhook ---

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
  const signatureHex = signature.replace("sha256=", "");
  if (!signatureHex) {
    return c.json({ error: "Malformed signature" }, 401);
  }

  if (!(await verifyHmac(rawBody, secret, signatureHex))) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const event = c.req.header("X-GitHub-Event");

  if (event === "pull_request") {
    return handlePullRequest(rawBody, c.env);
  }
  if (event === "pull_request_review") {
    return handlePullRequestReview(rawBody, c.env);
  }
  if (event === "pull_request_review_comment") {
    return handlePullRequestReviewComment(rawBody, c.env);
  }
  if (event === "issue_comment") {
    return handleIssueComment(rawBody, c.env);
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
    repository: { full_name: string };
  };

  if (payload.action !== "closed" || !payload.pull_request.merged) {
    return Response.json({ ok: true, ignored: true });
  }

  const branch = payload.pull_request.head.ref;
  const taskId = extractTaskId(branch);
  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  const productName = resolveProductByRepo(payload.repository.full_name);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  await forwardToOrchestrator(env, {
    type: "pr_merged",
    source: "github",
    ticketId: taskId,
    product: productName,
    payload: {
      pr_url: payload.pull_request.html_url,
      branch,
      repo: payload.repository.full_name,
    },
  });

  return Response.json({ ok: true, product: productName, taskId, status: "pr_merged" });
}

async function handlePullRequestReview(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    review: {
      state: string;
      body: string | null;
      user: { login: string };
      html_url: string;
    };
    pull_request: {
      head: { ref: string };
      html_url: string;
    };
    repository: { full_name: string };
  };

  if (payload.action !== "submitted") {
    return Response.json({ ok: true, ignored: true });
  }

  const branch = payload.pull_request.head.ref;
  const taskId = extractTaskId(branch);
  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  const productName = resolveProductByRepo(payload.repository.full_name);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  await forwardToOrchestrator(env, {
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
      branch,
      repo: payload.repository.full_name,
    },
  });

  return Response.json({ ok: true, product: productName, taskId, reviewState: payload.review.state });
}

async function handlePullRequestReviewComment(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    comment: {
      body: string;
      user: { login: string };
      html_url: string;
      path: string;
      line: number;
    };
    pull_request: {
      head: { ref: string };
      html_url: string;
    };
    repository: { full_name: string };
  };

  if (payload.action !== "created") {
    return Response.json({ ok: true, ignored: true });
  }

  const branch = payload.pull_request.head.ref;
  const taskId = extractTaskId(branch);
  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  const productName = resolveProductByRepo(payload.repository.full_name);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  await forwardToOrchestrator(env, {
    type: "pr_review_comment",
    source: "github",
    ticketId: taskId,
    product: productName,
    payload: {
      pr_url: payload.pull_request.html_url,
      comment_url: payload.comment.html_url,
      comment_body: payload.comment.body,
      commenter: payload.comment.user.login,
      file_path: payload.comment.path,
      line: payload.comment.line,
      branch,
      repo: payload.repository.full_name,
    },
  });

  return Response.json({ ok: true, product: productName, taskId });
}

async function handleIssueComment(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    issue: {
      pull_request?: { url: string };
      html_url: string;
    };
    comment: {
      body: string;
      user: { login: string };
      html_url: string;
    };
    repository: { full_name: string };
  };

  // Only handle comments on PRs
  if (!payload.issue.pull_request) {
    return Response.json({ ok: true, ignored: true, reason: "not a PR comment" });
  }

  if (payload.action !== "created") {
    return Response.json({ ok: true, ignored: true });
  }

  // Extract PR info from the PR URL
  const prUrlMatch = payload.issue.pull_request.url.match(/\/pulls\/(\d+)$/);
  if (!prUrlMatch) {
    return Response.json({ ok: true, ignored: true, reason: "could not parse PR number" });
  }

  // Fetch PR details to get the branch name
  const prNumber = prUrlMatch[1];
  const ghToken = env.GITHUB_TOKEN;
  const prApiUrl = `https://api.github.com/repos/${payload.repository.full_name}/pulls/${prNumber}`;

  const prResponse = await fetch(prApiUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!prResponse.ok) {
    console.error(`[GitHub] Failed to fetch PR details: ${prResponse.status}`);
    return Response.json({ ok: true, ignored: true, reason: "could not fetch PR details" });
  }

  const prData = await prResponse.json() as { head: { ref: string } };
  const branch = prData.head.ref;
  const taskId = extractTaskId(branch);

  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  const productName = resolveProductByRepo(payload.repository.full_name);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  await forwardToOrchestrator(env, {
    type: "pr_comment",
    source: "github",
    ticketId: taskId,
    product: productName,
    payload: {
      pr_url: payload.issue.html_url,
      comment_url: payload.comment.html_url,
      comment_body: payload.comment.body,
      commenter: payload.comment.user.login,
      branch,
      repo: payload.repository.full_name,
    },
  });

  return Response.json({ ok: true, product: productName, taskId });
}

export { linearWebhook, githubWebhook };
