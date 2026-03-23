/**
 * Webhook handlers for Linear and GitHub events.
 *
 * Shared HMAC verification. Per-source event parsing and routing.
 */

import { Hono } from "hono";
import { getLinearAppUserId, getProduct, getProductByLinearProject, isOurTeam, loadRegistry } from "./registry";
import type { Bindings } from "./types";
import { normalizeLinearEvent, normalizeGitHubEvent } from "./security/normalized-event";

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
    ticketUUID: taskId,
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

/** Assign a Linear issue to the app user (by known user ID). */
export async function assignTicketToAgent(apiKey: string, issueId: string, appUserId: string) {
  try {
    await linearGraphQL(
      apiKey,
      `mutation($id: String!, $assigneeId: String!) { issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success } }`,
      { id: issueId, assigneeId: appUserId },
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
    delegate?: { id: string; name: string };
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

  // Only handle issues and comments
  if (payload.type !== "Issue" && payload.type !== "Comment") {
    return c.json({ ok: true, ignored: true });
  }

  const orchestrator = getOrchestrator(c.env);

  // Handle Linear comments on tracked tickets
  if (payload.type === "Comment" && payload.action === "create") {
    const commentData = payload.data as unknown as {
      id: string;
      body: string;
      issue: { id: string; identifier: string; title: string };
      user: { id: string; name: string };
    };

    // Don't re-process our own comments (posted by the app)
    const appUserId = await getLinearAppUserId(orchestrator);
    if (commentData.user.id === appUserId) {
      return c.json({ ok: true, ignored: true, reason: "our own comment" });
    }

    // Check if we're tracking this ticket
    const statusRes = await orchestrator.fetch(
      new Request(`http://internal/ticket-status/${encodeURIComponent(commentData.issue.id)}`)
    );

    if (!statusRes.ok) {
      return c.json({ ok: true, ignored: true, reason: "ticket not tracked" });
    }

    const ticketStatus = await statusRes.json<{ status: string; product: string }>();

    const commentScanResult = await normalizeLinearEvent({
      action: payload.action,
      type: payload.type,
      data: { id: commentData.id, body: commentData.body },
    } as Record<string, unknown>);
    if (!commentScanResult.ok) {
      console.warn(`[Linear] Comment rejected: ${commentScanResult.error}`);
      return c.json({ error: "Event rejected: suspicious content detected" }, 400);
    }

    await forwardToOrchestrator(c.env, {
      type: "linear_comment",
      source: "linear",
      ticketUUID: commentData.issue.id,
      product: ticketStatus.product,
      payload: {
        comment_id: commentData.id,
        body: commentData.body,
        author: commentData.user.name,
        issue_identifier: commentData.issue.identifier,
        issue_title: commentData.issue.title,
      },
    });

    return c.json({ ok: true, ticketUUID: commentData.issue.id });
  }

  // Scan free-text fields for injection attacks
  const scanResult = await normalizeLinearEvent(payload as unknown as Record<string, unknown>);
  if (!scanResult.ok) {
    console.warn(`[Linear] Event rejected: ${scanResult.error}`);
    return c.json({ error: "Event rejected: suspicious content detected" }, 400);
  }

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

  // Trigger conditions: only trigger on create/update when assigned to agent (but not if already in terminal state)
  const appUserId = await getLinearAppUserId(orchestrator);
  const isAssignedToAgent = payload.data.assignee?.id === appUserId || payload.data.delegate?.id === appUserId;

  // Ignore terminal states even if assigned to agent
  const terminalStates = ["Done", "Canceled", "Cancelled"];
  const isTerminal = payload.data.state?.name && terminalStates.includes(payload.data.state.name);

  // Only trigger on create/update actions when assigned to agent
  const isRelevantAction = payload.action === "create" || payload.action === "update";
  const shouldTrigger = isRelevantAction && isAssignedToAgent && !isTerminal;

  if (!shouldTrigger) {
    return c.json({ ok: true, ignored: true, reason: "action not relevant" });
  }

  await forwardToOrchestrator(c.env, {
    type: "ticket_created",
    source: "linear",
    ticketUUID: payload.data.id,
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

  return c.json({
    ok: true,
    product: match.name,
    project: projectName,
    ticketUUID: payload.data.id,
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
  if (event === "code_scanning_alert") {
    return handleCodeScanningAlert(rawBody, c.env);
  }
  if (event === "dependabot_alert") {
    return handleDependabotAlert(rawBody, c.env);
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

  // Scan free-text fields for injection attacks
  const ghScan = await normalizeGitHubEvent("pull_request", payload as unknown as Record<string, unknown>);
  if (!ghScan.ok) {
    console.warn(`[GitHub] PR event rejected: ${ghScan.error}`);
    return Response.json({ error: "Event rejected: suspicious content" }, { status: 400 });
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

  // Handle different PR actions
  if (payload.action === "closed") {
    if (payload.pull_request.merged) {
      await forwardToOrchestrator(env, {
        type: "pr_merged",
        source: "github",
        ticketUUID: taskId,
        product: productName,
        payload: {
          pr_url: payload.pull_request.html_url,
          branch,
          repo: payload.repository.full_name,
        },
      });
      return Response.json({ ok: true, product: productName, taskId, status: "pr_merged" });
    } else {
      // PR closed without merging — notify agent so it can update status
      await forwardToOrchestrator(env, {
        type: "pr_closed",
        source: "github",
        ticketUUID: taskId,
        product: productName,
        payload: {
          pr_url: payload.pull_request.html_url,
          branch,
          repo: payload.repository.full_name,
        },
      });
      return Response.json({ ok: true, product: productName, taskId, status: "pr_closed" });
    }
  }

  if (payload.action === "synchronize") {
    // New commits pushed to PR
    await forwardToOrchestrator(env, {
      type: "pr_updated",
      source: "github",
      ticketUUID: taskId,
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
      ticketUUID: taskId,
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
      ticketUUID: taskId,
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

  // Scan free-text fields for injection attacks
  const ghScan = await normalizeGitHubEvent("pull_request_review", payload as unknown as Record<string, unknown>);
  if (!ghScan.ok) {
    console.warn(`[GitHub] PR review rejected: ${ghScan.error}`);
    return Response.json({ error: "Event rejected: suspicious content" }, { status: 400 });
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
    ticketUUID: taskId,
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

  // Scan free-text fields for injection attacks
  const ghScan = await normalizeGitHubEvent("pull_request_review_comment", payload as unknown as Record<string, unknown>);
  if (!ghScan.ok) {
    console.warn(`[GitHub] PR review comment rejected: ${ghScan.error}`);
    return Response.json({ error: "Event rejected: suspicious content" }, { status: 400 });
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
    ticketUUID: taskId,
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

  // Scan free-text fields for injection attacks
  const ghScan = await normalizeGitHubEvent("issue_comment", payload as unknown as Record<string, unknown>);
  if (!ghScan.ok) {
    console.warn(`[GitHub] Issue comment rejected: ${ghScan.error}`);
    return Response.json({ error: "Event rejected: suspicious content" }, { status: 400 });
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
    ticketUUID: taskId,
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

async function handleCodeScanningAlert(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    alert: {
      number: number;
      state: string;
      rule: { id: string; severity: string; description: string };
      most_recent_instance: {
        ref: string;
        location: { path: string; start_line: number; end_line: number };
        message: { text: string };
      } | null;
      html_url: string;
    };
    repository: { full_name: string };
  };

  // Handle new, reopened, and branch-reappearance alerts
  if (payload.action !== "created" && payload.action !== "reopened" && payload.action !== "appeared_in_branch") {
    return Response.json({ ok: true, ignored: true });
  }

  const ref = payload.alert.most_recent_instance?.ref;
  // Only route alerts on branch refs — ignore tags, PR refs, etc.
  const branch = ref?.startsWith("refs/heads/") ? ref.replace("refs/heads/", "") : undefined;

  return routeWebhookEvent(env, branch, payload.repository.full_name, {
    type: "code_scanning_alert",
    payload: {
      alert_number: payload.alert.number,
      state: payload.alert.state,
      rule_id: payload.alert.rule.id,
      severity: payload.alert.rule.severity,
      description: payload.alert.rule.description,
      file_path: payload.alert.most_recent_instance?.location?.path,
      start_line: payload.alert.most_recent_instance?.location?.start_line,
      end_line: payload.alert.most_recent_instance?.location?.end_line,
      message: payload.alert.most_recent_instance?.message?.text,
      alert_url: payload.alert.html_url,
    },
  });
}

async function handleDependabotAlert(rawBody: string, env: Bindings) {
  const payload = JSON.parse(rawBody) as {
    action: string;
    alert: {
      number: number;
      state: string;
      dependency: {
        package: { ecosystem: string; name: string };
        manifest_path: string;
      } | null;
      security_advisory: {
        severity: string;
        summary: string;
        description: string;
        cve_id: string | null;
      } | null;
      security_vulnerability: {
        vulnerable_version_range: string;
        first_patched_version: { identifier: string } | null;
      } | null;
      html_url: string;
    };
    repository: { full_name: string };
  };

  // Only handle new or reopened alerts
  if (payload.action !== "created" && payload.action !== "reopened") {
    return Response.json({ ok: true, ignored: true });
  }

  // Dependabot alerts are repo-level, not branch-specific.
  // Forward to orchestrator as a new event — the orchestrator can decide
  // whether to create a ticket or wait for the Dependabot PR.
  const orchestrator = getOrchestrator(env);
  const productName = await resolveProductByRepo(orchestrator, payload.repository.full_name);
  if (!productName) {
    return Response.json({ ok: true, ignored: true, reason: "unknown repo" });
  }

  // Include repo in uuid to avoid collisions across repos in the same product
  // (alert numbers are only unique per repo). Use action suffix for reopened alerts
  // so they get a fresh ticket instead of hitting the terminal state guard.
  const repoShort = payload.repository.full_name.replace("/", "-");
  const actionSuffix = payload.action === "reopened" ? `-reopen-${Date.now()}` : "";
  const ticketUUID = `dependabot-${repoShort}-${payload.alert.number}${actionSuffix}`;

  await forwardToOrchestrator(env, {
    type: "dependabot_alert",
    source: "github",
    ticketUUID,
    product: productName,
    payload: {
      alert_number: payload.alert.number,
      state: payload.alert.state,
      package_name: payload.alert.dependency?.package?.name,
      ecosystem: payload.alert.dependency?.package?.ecosystem,
      manifest_path: payload.alert.dependency?.manifest_path,
      severity: payload.alert.security_advisory?.severity,
      summary: payload.alert.security_advisory?.summary,
      cve_id: payload.alert.security_advisory?.cve_id,
      vulnerable_range: payload.alert.security_vulnerability?.vulnerable_version_range,
      patched_version: payload.alert.security_vulnerability?.first_patched_version?.identifier,
      alert_url: payload.alert.html_url,
      repo: payload.repository.full_name,
    },
  });

  return Response.json({ ok: true, product: productName, ticketUUID, alertNumber: payload.alert.number });
}

export { linearWebhook, githubWebhook };
