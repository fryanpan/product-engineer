/**
 * Webhook handlers for Linear and GitHub events.
 *
 * Shared HMAC verification. Per-source event parsing and routing.
 */

import { Hono } from "hono";
import { getAgentIdentity, getProduct, getProductByLinearProject, isOurTeam, loadRegistry } from "./registry";
import type { Bindings } from "./types";

function getOrchestrator(env: Bindings): DurableObjectStub {
  const id = env.ORCHESTRATOR.idFromName("main");
  return env.ORCHESTRATOR.get(id);
}

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

// Helper to reduce repetition across webhook handlers
async function routeWebhookEvent(
  env: Bindings,
  branch: string | undefined,
  repo: string,
  eventData: { type: string; payload: Record<string, unknown> },
): Promise<Response> {
  if (!branch) {
    return Response.json({ ok: true, ignored: true, reason: "no branch" });
  }

  const taskId = extractTaskId(branch);
  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  const orchestrator = getOrchestrator(env);
  const productName = await resolveProductByRepo(orchestrator, repo);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  await forwardToOrchestrator(env, {
    type: eventData.type,
    source: "github",
    ticketId: taskId,
    product: productName,
    payload: { ...eventData.payload, branch, repo },
  });

  return Response.json({ ok: true, product: productName, taskId });
}

export async function resolveProductByRepo(
  orchestratorStub: DurableObjectStub,
  repoFullName: string,
): Promise<string | null> {
  const registry = await loadRegistry(orchestratorStub);
  for (const [name, config] of Object.entries(registry.products)) {
    if (config.repos.includes(repoFullName)) return name;
  }
  return null;
}

function forwardToOrchestrator(env: Bindings, event: Record<string, unknown>) {
  const orchestrator = getOrchestrator(env);
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

  const orchestrator = getOrchestrator(c.env);

  if (!(await isOurTeam(orchestrator, payload.data.teamId))) {
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

  const match = await getProductByLinearProject(orchestrator, projectName);
  if (!match) {
    return c.json({
      ok: true,
      ignored: true,
      reason: `unknown project: ${projectName}`,
    });
  }

  // Trigger conditions: create or assigned to agent (but not if already in terminal state)
  const agent = await getAgentIdentity(orchestrator);
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
  if (event === "check_run") {
    return handleCheckRun(rawBody, c.env);
  }
  if (event === "check_suite") {
    return handleCheckSuite(rawBody, c.env);
  }
  if (event === "workflow_run") {
    return handleWorkflowRun(rawBody, c.env);
  }
  if (event === "status") {
    return handleStatus(rawBody, c.env);
  }
  if (event === "deployment_status") {
    return handleDeploymentStatus(rawBody, c.env);
  }

  return c.json({ ok: true, ignored: true });
});

async function handlePullRequest(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    label?: { name: string };
    pull_request: {
      merged: boolean;
      head: { ref: string };
      html_url: string;
      number: number;
    };
    repository: { full_name: string };
  };

  const branch = payload.pull_request.head.ref;
  const taskId = extractTaskId(branch);
  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
  }

  const orchestrator = getOrchestrator(env);
  const productName = await resolveProductByRepo(orchestrator, payload.repository.full_name);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  // Handle different PR actions
  if (payload.action === "closed" && payload.pull_request.merged) {
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

  if (payload.action === "synchronize") {
    // New commits pushed to PR
    await forwardToOrchestrator(env, {
      type: "pr_updated",
      source: "github",
      ticketId: taskId,
      product: productName,
      payload: {
        pr_url: payload.pull_request.html_url,
        pr_number: payload.pull_request.number,
        branch,
        repo: payload.repository.full_name,
      },
    });
    return Response.json({ ok: true, product: productName, taskId, status: "pr_updated" });
  }

  if (payload.action === "reopened") {
    await forwardToOrchestrator(env, {
      type: "pr_reopened",
      source: "github",
      ticketId: taskId,
      product: productName,
      payload: {
        pr_url: payload.pull_request.html_url,
        branch,
        repo: payload.repository.full_name,
      },
    });
    return Response.json({ ok: true, product: productName, taskId, status: "pr_reopened" });
  }

  if (payload.action === "labeled" || payload.action === "unlabeled") {
    await forwardToOrchestrator(env, {
      type: payload.action === "labeled" ? "pr_labeled" : "pr_unlabeled",
      source: "github",
      ticketId: taskId,
      product: productName,
      payload: {
        pr_url: payload.pull_request.html_url,
        label: payload.label?.name,
        branch,
        repo: payload.repository.full_name,
      },
    });
    return Response.json({ ok: true, product: productName, taskId, label: payload.label?.name });
  }

  return Response.json({ ok: true, ignored: true, reason: `action not handled: ${payload.action}` });
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

  const orchestrator = getOrchestrator(env);
  const productName = await resolveProductByRepo(orchestrator, payload.repository.full_name);
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

  const orchestrator = getOrchestrator(env);
  const productName = await resolveProductByRepo(orchestrator, payload.repository.full_name);
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

  // Resolve product early so we can get the right per-product GitHub token
  const orchestrator = getOrchestrator(env);
  const productName = await resolveProductByRepo(orchestrator, payload.repository.full_name);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  const productConfig = await getProduct(orchestrator, productName);
  const ghTokenBinding = productConfig?.secrets?.GITHUB_TOKEN;
  const ghToken = ghTokenBinding ? (env as Record<string, unknown>)[ghTokenBinding] as string : undefined;
  if (!ghToken) {
    console.error(`[GitHub] No GitHub token configured for product ${productName}`);
    return Response.json({ error: "No GitHub token for product" }, { status: 500 });
  }

  // Extract PR info from the PR URL
  const prUrlMatch = payload.issue.pull_request.url.match(/\/pulls\/(\d+)$/);
  if (!prUrlMatch) {
    return Response.json({ ok: true, ignored: true, reason: "could not parse PR number" });
  }

  // Fetch PR details to get the branch name
  const prNumber = prUrlMatch[1];
  const prApiUrl = `https://api.github.com/repos/${payload.repository.full_name}/pulls/${prNumber}`;

  const prResponse = await fetch(prApiUrl, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!prResponse.ok) {
    console.error(`[GitHub] Failed to fetch PR details: ${prResponse.status}`);
    return Response.json({ error: "Failed to fetch PR details" }, { status: 502 });
  }

  const prData = await prResponse.json() as { head: { ref: string } };
  const branch = prData.head.ref;
  const taskId = extractTaskId(branch);

  if (!taskId) {
    return Response.json({ ok: true, ignored: true, reason: "not a task branch" });
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

async function handleCheckRun(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    check_run: {
      name: string;
      conclusion: string | null;
      output: { title: string; summary: string };
      html_url: string;
      check_suite: { head_branch: string };
      pull_requests: Array<{ number: number }>;
    };
    repository: { full_name: string };
  };

  // Only handle failed checks
  if (payload.action !== "completed" || payload.check_run.conclusion === "success") {
    return Response.json({ ok: true, ignored: true });
  }

  return routeWebhookEvent(env, payload.check_run.check_suite?.head_branch, payload.repository.full_name, {
    type: "ci_failure",
    payload: {
      check_name: payload.check_run.name,
      conclusion: payload.check_run.conclusion,
      output_title: payload.check_run.output.title,
      output_summary: payload.check_run.output.summary,
      check_url: payload.check_run.html_url,
    },
  });
}

async function handleWorkflowRun(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    workflow_run: {
      name: string;
      conclusion: string | null;
      html_url: string;
      head_branch: string;
      pull_requests: Array<{ number: number; head: { ref: string } }>;
    };
    repository: { full_name: string };
  };

  // Only handle failed workflows
  if (payload.action !== "completed" || payload.workflow_run.conclusion === "success") {
    return Response.json({ ok: true, ignored: true });
  }

  return routeWebhookEvent(env, payload.workflow_run.head_branch, payload.repository.full_name, {
    type: "workflow_failure",
    payload: {
      workflow_name: payload.workflow_run.name,
      conclusion: payload.workflow_run.conclusion,
      workflow_url: payload.workflow_run.html_url,
    },
  });
}

async function handleCheckSuite(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    check_suite: {
      conclusion: string | null;
      status: string;
      html_url: string;
      head_branch: string;
      pull_requests: Array<{ number: number }>;
    };
    repository: { full_name: string };
  };

  // Only handle completed check suites (success or failure)
  if (payload.action !== "completed") {
    return Response.json({ ok: true, ignored: true });
  }

  const eventType = payload.check_suite.conclusion === "success" ? "checks_passed" : "checks_failed";

  return routeWebhookEvent(env, payload.check_suite.head_branch, payload.repository.full_name, {
    type: eventType,
    payload: {
      conclusion: payload.check_suite.conclusion,
      status: payload.check_suite.status,
      suite_url: payload.check_suite.html_url,
    },
  });
}

async function handleStatus(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    state: string;
    description: string;
    context: string;
    target_url: string | null;
    branches: Array<{ name: string }>;
    repository: { full_name: string };
  };

  // Only handle failure/error states
  if (payload.state !== "failure" && payload.state !== "error") {
    return Response.json({ ok: true, ignored: true });
  }

  const branch = payload.branches?.[0]?.name;
  return routeWebhookEvent(env, branch, payload.repository.full_name, {
    type: "status_failure",
    payload: {
      state: payload.state,
      context: payload.context,
      description: payload.description,
      target_url: payload.target_url,
    },
  });
}

async function handleDeploymentStatus(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    deployment_status: {
      state: string;
      description: string;
      environment: string;
      target_url: string | null;
    };
    deployment: {
      ref: string;
      task: string;
      environment: string;
    };
    repository: { full_name: string };
  };

  // Only handle failure/error states
  if (payload.deployment_status.state !== "failure" && payload.deployment_status.state !== "error") {
    return Response.json({ ok: true, ignored: true });
  }

  return routeWebhookEvent(env, payload.deployment.ref, payload.repository.full_name, {
    type: "deployment_failure",
    payload: {
      state: payload.deployment_status.state,
      environment: payload.deployment_status.environment,
      description: payload.deployment_status.description,
      target_url: payload.deployment_status.target_url,
    },
  });
}

export { linearWebhook, githubWebhook };
