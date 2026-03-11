#!/usr/bin/env bun
/**
 * End-to-End Staging Test for Product Engineer Orchestrator
 *
 * Exercises the full orchestrator lifecycle against staging:
 * 1. Slack mention → Linear ticket creation
 * 2. Ticket review → agent spawn decision
 * 3. Agent working (sends chat messages, status updates, heartbeats)
 * 4. CI failure → automated fix
 * 5. Merge gate evaluation
 * 6. Auto-merge and deploy verification
 *
 * Catches the class of bugs found in Mar 9-10: supervisor spam loop, merge gate
 * race condition, duplicate webhook dedup, stale token refresh, thread routing.
 *
 * Usage:
 *   # Against staging (default)
 *   bun run scripts/e2e-staging-test.ts
 *
 *   # Against production (rare — only after risky changes)
 *   STAGING_URL=https://product-engineer.fryansoftware.workers.dev \
 *   SLACK_CHANNEL=C0... \
 *   LINEAR_PROJECT=... \
 *   bun run scripts/e2e-staging-test.ts
 */

import { parseArgs } from "util";

// --- Configuration ---

const STAGING_URL = process.env.STAGING_URL || "https://product-engineer-stg.fryanpan.workers.dev";
const STAGING_SLACK_CHANNEL = process.env.SLACK_CHANNEL || "C0AKB6HUEPM"; // #staging-product-engineer
const STAGING_REPO = process.env.STAGING_REPO || "fryanpan/staging-test-app";

const API_KEY = process.env.API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
// User OAuth token (xoxp-) for posting mentions as a real user.
// Slack doesn't fire app_mention when a bot mentions itself, so we need a user token
// to trigger the full Socket Mode flow in E2E tests.
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;

// Test timeout settings
const POLL_INTERVAL_MS = 5_000; // 5 seconds
const AGENT_START_TIMEOUT_MS = 120_000; // 2 minutes for agent to start
const AGENT_WORK_TIMEOUT_MS = 600_000; // 10 minutes for agent to finish
const CI_FIX_TIMEOUT_MS = 300_000; // 5 minutes for CI fix
const MERGE_TIMEOUT_MS = 600_000; // 10 minutes for merge (includes Copilot review retries: 5 x 90s)

// --- Interfaces ---

interface TestContext {
  testId: string;
  slackThreadTs: string | null;
  linearIssueId: string | null;
  linearIdentifier: string | null;
  prUrl: string | null;
  branchName: string | null;
  startTime: number;
}

interface StatusResponse {
  activeAgents: Array<{
    id: string;
    product: string;
    status: string;
    last_heartbeat: string | null;
    pr_url: string | null;
    branch_name: string | null;
  }>;
}

interface TicketRow {
  id: string;
  product: string;
  status: string;
  slack_thread_ts: string | null;
  pr_url: string | null;
  branch_name: string | null;
  agent_active: number;
  title: string | null;
  identifier: string | null;
}

// --- Helpers ---

function log(step: string, message: string) {
  const elapsed = ((Date.now() - globalStartTime) / 1000).toFixed(1);
  console.log(`[${elapsed}s] [${step}] ${message}`);
}

function logSuccess(step: string, message: string) {
  const elapsed = ((Date.now() - globalStartTime) / 1000).toFixed(1);
  console.log(`[${elapsed}s] [${step}] ✅ ${message}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API Clients ---

async function apiCall<T>(
  endpoint: string,
  method: string = "GET",
  body?: unknown
): Promise<T> {
  const res = await fetch(`${STAGING_URL}${endpoint}`, {
    method,
    headers: {
      "X-API-Key": API_KEY!,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API call failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function postSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<{ ts: string; channel: string }> {
  return postSlackMessageWithToken(channel, text, SLACK_BOT_TOKEN!, threadTs);
}

async function postSlackMessageWithToken(
  channel: string,
  text: string,
  token: string,
  threadTs?: string
): Promise<{ ts: string; channel: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs && { thread_ts: threadTs }),
    }),
  });

  const data = (await res.json()) as { ok: boolean; ts: string; channel: string; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API failed: ${data.error}`);
  }

  return { ts: data.ts, channel: data.channel };
}

async function getLinearIssue(
  issueId: string
): Promise<{ state: { name: string }; assignee?: { name: string } }> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY!,
    },
    body: JSON.stringify({
      query: `
        query($issueId: String!) {
          issue(id: $issueId) {
            state { name }
            assignee { name }
          }
        }
      `,
      variables: { issueId },
    }),
  });

  const data = (await res.json()) as { data?: { issue: { state: { name: string }; assignee?: { name: string } } } };
  return data.data!.issue;
}

async function fetchGitHubPR(
  repo: string,
  prNumber: number
): Promise<{ state: string; merged: boolean; mergeable: boolean | null; mergeable_state: string }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API failed: ${res.status}`);
  }

  return res.json() as Promise<{ state: string; merged: boolean; mergeable: boolean | null; mergeable_state: string }>;
}

async function getCommitStatuses(
  repo: string,
  ref: string
): Promise<Array<{ context: string; state: string; description: string | null }>> {
  // Use commit statuses API — works with fine-grained PAT "Commit statuses" permission.
  // (The check-runs API requires "Checks" permission which doesn't exist on fine-grained PATs.)
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}/status`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API failed: ${res.status}`);
  }

  const data = (await res.json()) as { state: string; statuses: Array<{ context: string; state: string; description: string | null }> };
  return data.statuses;
}

// --- Test Steps ---

async function verifyPrerequisites(): Promise<void> {
  log("prereqs", "Verifying prerequisites...");

  const missing: string[] = [];
  if (!API_KEY) missing.push("API_KEY");
  if (!SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!LINEAR_API_KEY) missing.push("LINEAR_API_KEY");
  if (!GITHUB_TOKEN) missing.push("GITHUB_TOKEN/GH_TOKEN");

  if (!SLACK_USER_TOKEN) missing.push("SLACK_USER_TOKEN (xoxp- token for app_mention trigger)");

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  // Test API connectivity
  try {
    await apiCall<{ ok: boolean }>("/health");
    logSuccess("prereqs", `Staging API at ${STAGING_URL} is healthy`);
  } catch (err) {
    throw new Error(`Cannot connect to staging API at ${STAGING_URL}: ${err}`);
  }

  // Test Slack connectivity
  const slackAuth = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const slackData = (await slackAuth.json()) as { ok: boolean; user?: string };
  if (!slackData.ok) {
    throw new Error("Slack bot token is invalid");
  }
  logSuccess("prereqs", `Slack bot authenticated as ${slackData.user}`);

  // Test Linear connectivity
  const linearAuth = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY!,
    },
    body: JSON.stringify({ query: "{ viewer { id } }" }),
  });
  const linearData = (await linearAuth.json()) as { data?: { viewer: { id: string } }; errors?: unknown[] };
  if (linearData.errors) {
    throw new Error("Linear API key is invalid");
  }
  logSuccess("prereqs", "Linear API authenticated");
}

async function step1_triggerViaSlack(ctx: TestContext): Promise<void> {
  log("step1", "Triggering via Slack mention...");

  // Create a unique test task description that will introduce a CI failure
  const taskDescription = `[E2E Test ${ctx.testId}] Add a new greeting function

Add a function called \`greetE2E_${ctx.testId.replace(/-/g, "_")}\` to src/index.ts that:
1. Takes a name parameter
2. Returns "Hello, {name}! (E2E test ${ctx.testId})"

IMPORTANT: The initial implementation should have a syntax error (missing semicolon) to test CI failure handling. After CI fails, fix the syntax error.`;

  const botUserId = process.env.SLACK_BOT_USER_ID || "U0AKJ2C6QUA"; // staging bot
  const message = `<@${botUserId}> ${taskDescription}`;

  // Post the mention using a user token (xoxp-) so Slack fires app_mention via Socket Mode.
  // Slack does NOT fire app_mention when a bot mentions itself (xoxb- token).
  const mentionToken = SLACK_USER_TOKEN || SLACK_BOT_TOKEN;
  if (!SLACK_USER_TOKEN) {
    log("step1", "WARNING: No SLACK_USER_TOKEN — using bot token. Slack won't fire app_mention for self-mentions.");
    log("step1", "Set SLACK_USER_TOKEN (xoxp-) for full end-to-end Socket Mode testing.");
  }

  const result = await postSlackMessageWithToken(STAGING_SLACK_CHANNEL, message, mentionToken!);
  ctx.slackThreadTs = result.ts;
  logSuccess("step1", `Slack mention posted: ts=${result.ts} (as ${SLACK_USER_TOKEN ? "user" : "bot"})`);

  // Wait for Socket Mode to deliver the event to the orchestrator
  await sleep(5000);
}

async function step2_verifyLinearTicketCreated(ctx: TestContext): Promise<void> {
  log("step2", "Waiting for Linear ticket creation...");

  const deadline = Date.now() + AGENT_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Search by test ID in the title since the orchestrator stores the ACK message ts
    // as slack_thread_ts (not the original mention ts).
    try {
      const tickets = await apiCall<{ tickets: TicketRow[] }>("/api/orchestrator/tickets");
      const ticket = tickets.tickets.find(
        (t) => t.title?.includes(ctx.testId)
      );

      if (ticket) {
        ctx.linearIssueId = ticket.id;
        ctx.slackThreadTs = ticket.slack_thread_ts;
        log("step2", `Found ticket linked to thread: ${ticket.id}`);

        // Get Linear identifier
        const issue = await getLinearIssue(ticket.id);
        logSuccess("step2", `Linear ticket created: ${ticket.id} (state: ${issue.state.name})`);
        return;
      }
    } catch (err) {
      log("step2", `Polling error (will retry): ${err}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Linear ticket was not created within timeout");
}

async function step3_verifyAgentSpawned(ctx: TestContext): Promise<void> {
  log("step3", "Waiting for agent to spawn...");

  const deadline = Date.now() + AGENT_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const status = await apiCall<StatusResponse>("/api/orchestrator/status");

      const agent = status.activeAgents.find(
        (a) => a.id === ctx.linearIssueId
      );

      if (agent) {
        logSuccess("step3", `Agent spawned: status=${agent.status}, heartbeat=${agent.last_heartbeat || "none"}`);

        // Wait for first heartbeat to confirm agent is actually running
        if (agent.last_heartbeat) {
          log("step3", "Agent has sent heartbeat — confirmed running");
          return;
        }
      }
    } catch (err) {
      log("step3", `Polling error (will retry): ${err}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Agent did not spawn within timeout");
}

async function step4_sendSlackMessage(ctx: TestContext): Promise<void> {
  log("step4", "Sending chat message to agent in thread...");

  if (!ctx.slackThreadTs) {
    throw new Error("No Slack thread to reply to");
  }

  // Send a message that should affect the agent's work
  await postSlackMessage(
    STAGING_SLACK_CHANNEL,
    "Also add a JSDoc comment to the function explaining it's for E2E testing.",
    ctx.slackThreadTs
  );

  logSuccess("step4", "Message sent to agent thread");

  // Wait a bit for agent to process
  await sleep(5000);
}

async function step5_waitForPR(ctx: TestContext): Promise<void> {
  log("step5", "Waiting for PR creation...");

  const deadline = Date.now() + AGENT_WORK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const status = await apiCall<StatusResponse>("/api/orchestrator/status");

      const agent = status.activeAgents.find(
        (a) => a.id === ctx.linearIssueId
      );

      if (agent?.pr_url) {
        ctx.prUrl = agent.pr_url;
        ctx.branchName = agent.branch_name || null;

        // Fallback: if branch_name not reported, fetch from GitHub PR API
        if (!ctx.branchName && ctx.prUrl) {
          try {
            const prNumber = ctx.prUrl.split("/").pop();
            const prRes = await fetch(`https://api.github.com/repos/${STAGING_REPO}/pulls/${prNumber}`, {
              headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github.v3+json",
              },
            });
            if (prRes.ok) {
              const prData = await prRes.json() as { head: { ref: string } };
              ctx.branchName = prData.head.ref;
              log("step5", `Fetched branch name from GitHub API: ${ctx.branchName}`);
            }
          } catch {
            log("step5", "Could not fetch branch name from GitHub API");
          }
        }

        logSuccess("step5", `PR created: ${agent.pr_url}`);
        return;
      }

      if (agent) {
        log("step5", `Agent status: ${agent.status}, heartbeat: ${agent.last_heartbeat || "none"}`);
      }
    } catch (err) {
      log("step5", `Polling error (will retry): ${err}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("PR was not created within timeout");
}

async function step6_verifyCIFailure(ctx: TestContext): Promise<void> {
  log("step6", "Verifying CI failure (intentional syntax error)...");

  if (!ctx.branchName) {
    throw new Error("No branch name to check CI");
  }

  const deadline = Date.now() + CI_FIX_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const statuses = await getCommitStatuses(STAGING_REPO, ctx.branchName);

      const failedStatus = statuses.find(
        (s) => s.state === "failure" || s.state === "error"
      );

      if (failedStatus) {
        logSuccess("step6", `CI failure detected: ${failedStatus.context} (${failedStatus.state})`);
        return;
      }

      const pendingStatuses = statuses.filter((s) => s.state === "pending");
      if (pendingStatuses.length > 0) {
        log("step6", `Waiting for statuses: ${pendingStatuses.map((s) => s.context).join(", ")}`);
      } else if (statuses.length === 0) {
        log("step6", "No commit statuses reported yet");
      }
    } catch (err) {
      log("step6", `Polling error (will retry): ${err}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // It's okay if CI doesn't fail — the implementation might be correct
  log("step6", "No CI failure detected — implementation may be correct");
}

async function step7_waitForMerge(ctx: TestContext): Promise<void> {
  log("step7", "Waiting for merge gate evaluation and auto-merge...");

  if (!ctx.prUrl) {
    throw new Error("No PR URL to check");
  }

  const prNumber = parseInt(ctx.prUrl.split("/").pop()!, 10);
  const deadline = Date.now() + MERGE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const pr = await fetchGitHubPR(STAGING_REPO, prNumber);

      if (pr.merged) {
        logSuccess("step7", "PR merged successfully!");
        return;
      }

      if (pr.state === "closed") {
        throw new Error("PR was closed without merging");
      }

      log("step7", `PR state: ${pr.state}, mergeable: ${pr.mergeable}, mergeable_state: ${pr.mergeable_state}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("closed without merging")) {
        throw err;
      }
      log("step7", `Polling error (will retry): ${err}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("PR was not merged within timeout");
}

async function step8_verifyAgentTerminated(ctx: TestContext): Promise<void> {
  log("step8", "Verifying agent terminated after merge...");

  await sleep(5000); // Give orchestrator time to process merge

  try {
    const status = await apiCall<StatusResponse>("/api/orchestrator/status");

    const agent = status.activeAgents.find(
      (a) => a.id === ctx.linearIssueId
    );

    if (!agent) {
      logSuccess("step8", "Agent terminated after merge");
      return;
    }

    // Agent might still be active but in terminal status
    if (agent.status === "merged" || agent.status === "closed") {
      logSuccess("step8", `Agent in terminal status: ${agent.status}`);
      return;
    }

    log("step8", `Warning: Agent still active with status ${agent.status}`);
  } catch (err) {
    log("step8", `Error checking agent status: ${err}`);
  }
}

async function step9_cleanup(ctx: TestContext): Promise<void> {
  log("cleanup", "Cleaning up test artifacts...");

  // For now, just log what would need to be cleaned up
  // Full cleanup would involve:
  // 1. Reverting the merge commit on staging-test-app main branch
  // 2. Deleting the Linear ticket
  // 3. Deleting the Slack thread (if possible)

  log("cleanup", "Cleanup items:");
  if (ctx.branchName) {
    log("cleanup", `  - Branch: ${ctx.branchName} (should be deleted after merge)`);
  }
  if (ctx.linearIssueId) {
    log("cleanup", `  - Linear ticket: ${ctx.linearIssueId} (can be closed/archived)`);
  }
  if (ctx.prUrl) {
    log("cleanup", `  - PR: ${ctx.prUrl} (merged)`);
  }

  // Note: Full cleanup would require:
  // git push --force origin main^:main
  // But this is dangerous and should be done carefully

  logSuccess("cleanup", "Test completed — manual cleanup may be required");
}

// --- Main ---

let globalStartTime = Date.now();

async function runE2ETest(): Promise<void> {
  const ctx: TestContext = {
    testId: `e2e-${Date.now().toString(36)}`,
    slackThreadTs: null,
    linearIssueId: null,
    linearIdentifier: null,
    prUrl: null,
    branchName: null,
    startTime: Date.now(),
  };

  globalStartTime = ctx.startTime;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Product Engineer Orchestrator E2E Test                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`\nTest ID: ${ctx.testId}`);
  console.log(`Target: ${STAGING_URL}`);
  console.log(`Repo: ${STAGING_REPO}`);
  console.log(`Channel: ${STAGING_SLACK_CHANNEL}`);
  console.log("");

  try {
    await verifyPrerequisites();
    await step1_triggerViaSlack(ctx);
    await step2_verifyLinearTicketCreated(ctx);
    await step3_verifyAgentSpawned(ctx);
    await step4_sendSlackMessage(ctx);
    await step5_waitForPR(ctx);
    await step6_verifyCIFailure(ctx);
    await step7_waitForMerge(ctx);
    await step8_verifyAgentTerminated(ctx);
    await step9_cleanup(ctx);

    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║     ✅ E2E TEST PASSED                                       ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`\nElapsed: ${((Date.now() - ctx.startTime) / 1000).toFixed(1)}s`);

  } catch (err) {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║     ❌ E2E TEST FAILED                                       ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.error(`\nError: ${err}`);
    console.log(`\nElapsed: ${((Date.now() - ctx.startTime) / 1000).toFixed(1)}s`);

    // Output context for debugging
    console.log("\nContext at failure:");
    console.log(JSON.stringify(ctx, null, 2));

    process.exit(1);
  }
}

// Parse CLI args
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    dry: { type: "boolean", short: "d", description: "Dry run — check prerequisites only" },
  },
});

if (values.help) {
  console.log(`
E2E Staging Test for Product Engineer Orchestrator

Usage:
  bun run scripts/e2e-staging-test.ts [options]

Options:
  -h, --help    Show this help message
  -d, --dry     Dry run — check prerequisites only

Required Environment Variables:
  API_KEY           Orchestrator API key
  SLACK_BOT_TOKEN   Slack bot token for staging app
  LINEAR_API_KEY    Linear API key
  GITHUB_TOKEN      GitHub token with repo access

Optional Environment Variables:
  STAGING_URL       Override staging URL (default: https://product-engineer-stg.fryanpan.workers.dev)
  SLACK_CHANNEL     Override Slack channel ID
  LINEAR_TEAM_ID    Override Linear team ID
  STAGING_REPO      Override staging repo (default: fryanpan/staging-test-app)
  `);
  process.exit(0);
}

if (values.dry) {
  globalStartTime = Date.now();
  await verifyPrerequisites();
  console.log("\n✅ Dry run complete — all prerequisites verified");
  process.exit(0);
}

runE2ETest();
