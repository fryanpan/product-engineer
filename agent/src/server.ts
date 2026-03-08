/**
 * Long-lived HTTP server wrapping the Agent SDK.
 *
 * Receives events via POST /event from the TicketAgent DO.
 * On first event: clones repos, starts Agent SDK session.
 * On subsequent events: yields new messages into the running session.
 */

import * as Sentry from "@sentry/bun";
import { Hono } from "hono";
import {
  query,
  createSdkMcpServer,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, type TaskPayload, type TicketEvent, type MessageContent } from "./config";
import { createTools } from "./tools";
import { buildPrompt, buildEventPrompt, buildResumePrompt } from "./prompt";
import { buildMcpServers } from "./mcp";

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

function userMessage(content: MessageContent): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

const app = new Hono();

console.log("[Agent] Starting server...");
console.log(`[Agent] Running as: uid=${process.getuid?.()} gid=${process.getgid?.()} HOME=${process.env.HOME}`);
console.log(`[Agent] Env check: ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);
console.log(`[Agent] Env check: GITHUB_TOKEN=${process.env.GITHUB_TOKEN ? "SET" : "MISSING"}`);
console.log(`[Agent] Env check: TICKET_ID=${process.env.TICKET_ID || "MISSING"}`);
console.log(`[Agent] Env check: PRODUCT=${process.env.PRODUCT || "MISSING"}`);
console.log(`[Agent] Env check: REPOS=${process.env.REPOS || "MISSING"}`);

const config = loadConfig();
console.log(`[Agent] Config loaded: ticket=${config.ticketId} product=${config.product} repos=${config.repos.join(",")} model=${config.model || "default"}`);

// Phone-home: report lifecycle events to the worker so they appear in wrangler tail.
// Only set branch_name when we actually have a git branch (not diagnostic detail).
function phoneHome(phase: string, detail?: string) {
  const body: Record<string, unknown> = {
    ticketId: config.ticketId,
    status: `agent:${phase}`,
  };
  // Log detail locally, but don't send it as branch_name (avoids overwriting real git branch)
  if (detail) console.log(`[Agent] phoneHome: ${phase} ${detail}`);
  else console.log(`[Agent] phoneHome: ${phase}`);
  fetch(`${config.workerUrl}/api/internal/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": config.apiKey,
    },
    body: JSON.stringify(body),
  }).catch((err) => console.error("[Agent] phoneHome failed:", err));
}

// Report token usage to the orchestrator
async function reportTokenUsage() {
  try {
    console.log(`[Agent] Reporting token usage: ${totalInputTokens} in / ${totalOutputTokens} out / $${totalCostUsd.toFixed(2)}`);

    const usageSummary = {
      ticketId: config.ticketId,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCostUsd,
      turns: turnUsageLog.length,
      sessionMessageCount,
    };

    const res = await fetch(`${config.workerUrl}/api/internal/token-usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": config.apiKey,
      },
      body: JSON.stringify(usageSummary),
    });

    if (!res.ok) {
      console.error(`[Agent] Failed to report token usage: ${res.status}`);
    } else {
      console.log("[Agent] Token usage reported successfully");
    }

    // Also post summary to Slack
    const formattedCost = totalCostUsd.toFixed(2);
    const formattedInputTokens = (totalInputTokens / 1000).toFixed(1);
    const formattedOutputTokens = (totalOutputTokens / 1000).toFixed(1);

    let slackMessage = `📊 **Token Usage Summary**\n\n`;
    slackMessage += `**Total Cost:** $${formattedCost}\n`;
    slackMessage += `**Input:** ${formattedInputTokens}K tokens ($${(totalInputTokens * 3.0 / 1_000_000).toFixed(2)})\n`;
    slackMessage += `**Output:** ${formattedOutputTokens}K tokens ($${(totalOutputTokens * 15.0 / 1_000_000).toFixed(2)})\n`;

    if (totalCacheReadTokens > 0) {
      slackMessage += `**Cache Read:** ${(totalCacheReadTokens / 1000).toFixed(1)}K tokens ($${(totalCacheReadTokens * 0.3 / 1_000_000).toFixed(2)})\n`;
    }
    if (totalCacheCreationTokens > 0) {
      slackMessage += `**Cache Creation:** ${(totalCacheCreationTokens / 1000).toFixed(1)}K tokens ($${(totalCacheCreationTokens * 3.0 / 1_000_000).toFixed(2)})\n`;
    }

    slackMessage += `**Conversation Turns:** ${turnUsageLog.length}\n\n`;

    // Include top 3 most expensive turns
    const topTurns = [...turnUsageLog]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 3);

    if (topTurns.length > 0) {
      slackMessage += `**Most Expensive Turns:**\n`;
      for (const turn of topTurns) {
        slackMessage += `• Turn ${turn.turn}: $${turn.costUsd.toFixed(4)} (${turn.inputTokens} in / ${turn.outputTokens} out)\n`;
        if (turn.promptSnippet) {
          slackMessage += `  Prompt: "${turn.promptSnippet}${turn.promptSnippet.length >= 100 ? '...' : ''}"\n`;
        }
        if (turn.outputSnippet) {
          slackMessage += `  Output: "${turn.outputSnippet}${turn.outputSnippet.length >= 100 ? '...' : ''}"\n`;
        }
      }
    }

    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: config.slackChannel,
        text: slackMessage,
        ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
      }),
    });

    console.log("[Agent] Token usage posted to Slack");
  } catch (err) {
    console.error("[Agent] Failed to report token usage:", err);
  }
}

phoneHome("server_started", `uid=${process.getuid?.()} HOME=${process.env.HOME} API_KEY=${config.apiKey ? "SET" : "MISSING"} ANTHROPIC=${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);

// Stable UUID for this agent instance — prefixes all transcript R2 keys
const agentUuid = crypto.randomUUID();
console.log(`[Agent] Agent UUID: ${agentUuid}`);

// Find the transcript session directory
function getTranscriptDir(): string {
  const home = process.env.HOME || "/home/agent";
  const cwd = process.cwd().replace(/\//g, "-");
  return `${home}/.claude/projects/${cwd}`;
}

// Find all transcript .jsonl files for this agent (compaction creates new files)
async function findAllTranscripts(): Promise<string[]> {
  try {
    const sessionDir = getTranscriptDir();

    const proc = Bun.spawn(["ls", "-1", sessionDir]);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return [];

    return output
      .trim()
      .split("\n")
      .filter(f => f.endsWith(".jsonl"))
      .map(f => `${sessionDir}/${f}`);
  } catch {
    return [];
  }
}

// Track uploaded size per file so we only re-upload when content changes
const uploadedSizes = new Map<string, number>();

// Upload all transcript files to R2 via the worker.
// Each file gets a stable key: {agentUuid}-{filename} so it's uploaded once per change.
async function uploadTranscripts(force = false) {
  try {
    const files = await findAllTranscripts();
    if (files.length === 0) {
      console.log("[Agent] No transcript files found to upload");
      return;
    }

    for (const path of files) {
      try {
        const file = Bun.file(path);
        const currentSize = file.size;
        const prevSize = uploadedSizes.get(path) ?? 0;

        // Skip if unchanged (unless forced, e.g., session end / shutdown)
        if (!force && currentSize === prevSize) continue;

        const basename = path.split("/").pop()!;
        const r2Key = `${agentUuid}-${basename}`;

        console.log(`[Agent] Uploading transcript ${basename} (${currentSize} bytes, was ${prevSize})...`);
        const transcriptContent = await file.text();
        uploadedSizes.set(path, currentSize);

        const uploadRes = await fetch(`${config.workerUrl}/api/internal/upload-transcript`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.apiKey,
          },
          body: JSON.stringify({
            ticketId: config.ticketId,
            r2Key,
            transcript: transcriptContent,
          }),
        });

        if (!uploadRes.ok) {
          const errorText = await uploadRes.text();
          console.error(`[Agent] Transcript upload failed for ${basename}: ${uploadRes.status} — ${errorText}`);
          continue;
        }

        console.log(`[Agent] Transcript uploaded: ${r2Key}`);
      } catch (fileErr) {
        console.error(`[Agent] Error uploading ${path}:`, fileErr);
      }
    }
  } catch (err) {
    console.error("[Agent] Transcript upload error:", err);
  }
}

// Heartbeat every 2 minutes while the session is active
const heartbeatInterval = setInterval(() => {
  if (sessionStatus === "completed" || sessionStatus === "error") {
    clearInterval(heartbeatInterval);
    return;
  }
  // Only send heartbeat when session is actually doing work (not idle waiting for first event)
  if (sessionStatus === "idle") return;
  // Send heartbeat to orchestrator for monitoring
  fetch(`${config.workerUrl}/api/orchestrator/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": config.apiKey,
    },
    body: JSON.stringify({ ticketId: config.ticketId }),
  }).catch((err) => console.error("[Agent] Heartbeat failed:", err));

  phoneHome("heartbeat", `status=${sessionStatus} msgs=${sessionMessageCount}`);
}, 120_000);

// Session timeout watchdog: exit if session runs too long or becomes idle
// This prevents containers from staying alive indefinitely waiting for Slack replies
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours wall-clock time
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes without messages
const timeoutWatchdog = setInterval(() => {
  if (!sessionActive && sessionStatus === "idle") return; // Not started yet

  const now = Date.now();
  const sessionDuration = sessionStartTime > 0 ? now - sessionStartTime : 0;
  const idleDuration = lastMessageTime > 0 ? now - lastMessageTime : 0;

  // Hard timeout: 2 hours of wall-clock time
  if (sessionDuration > SESSION_TIMEOUT_MS) {
    console.log(`[Agent] Session timeout after ${Math.floor(sessionDuration / 60000)}m — exiting`);
    phoneHome("session_timeout", `duration=${Math.floor(sessionDuration / 60000)}m msgs=${sessionMessageCount}`);
    clearInterval(heartbeatInterval);
    clearInterval(transcriptBackupInterval);
    clearInterval(timeoutWatchdog);
    process.exit(0);
  }

  // Idle timeout: 30 minutes without SDK messages AND not actively running
  if (idleDuration > IDLE_TIMEOUT_MS && sessionStatus !== "running") {
    console.log(`[Agent] Idle timeout after ${Math.floor(idleDuration / 60000)}m with status=${sessionStatus} — exiting`);
    phoneHome("idle_timeout", `idle=${Math.floor(idleDuration / 60000)}m status=${sessionStatus}`);
    clearInterval(heartbeatInterval);
    clearInterval(transcriptBackupInterval);
    clearInterval(timeoutWatchdog);
    process.exit(0);
  }
}, 60_000); // Check every minute

// Periodic transcript backup every 1 minute (only uploads if file changed)
const transcriptBackupInterval = setInterval(() => {
  if (sessionStatus === "completed" || sessionStatus === "error") {
    clearInterval(transcriptBackupInterval);
    return;
  }
  if (sessionStatus === "running" && sessionActive) {
    uploadTranscripts().catch((err) => console.error("[Agent] Periodic backup failed:", err));
  }
}, 60_000); // 1 minute

// Signal handlers to upload transcript on container shutdown
async function handleShutdown(signal: string) {
  console.log(`[Agent] Received ${signal}, uploading transcript before shutdown...`);
  clearInterval(heartbeatInterval);
  clearInterval(transcriptBackupInterval);
  clearInterval(timeoutWatchdog);
  await uploadTranscripts(true);
  phoneHome("container_shutdown", signal);
  process.exit(0);
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

let sessionActive = false;
let messageYielder: ((msg: SDKUserMessage) => void) | null = null;
let repoCloned = false;
let sessionStatus = "idle";
let lastToolCall = "";
let lastAssistantText = "";
let sessionMessageCount = 0;
let sessionError = "";
let lastStderr = "";
let currentSessionId = "";
let sessionStartTime = 0;
let lastMessageTime = 0;

// Token usage tracking
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCacheReadTokens = 0;
let totalCacheCreationTokens = 0;
let totalCostUsd = 0;
let lastUserPrompt = "";  // Track most recent user message for logging
let turnUsageLog: Array<{
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  promptSnippet?: string;
  outputSnippet?: string;
}> = [];

function createMessageGenerator(): AsyncGenerator<SDKUserMessage> {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;

  messageYielder = (msg: SDKUserMessage) => {
    queue.push(msg);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  return (async function* () {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
  })();
}

async function cloneRepos() {
  if (repoCloned) return;
  sessionStatus = "cloning";

  console.log("[Agent] Setting up .netrc for GitHub auth...");
  const home = process.env.HOME || "/home/agent";
  const netrc = `machine github.com\nlogin x-access-token\npassword ${config.githubToken}\n`;
  await Bun.write(`${home}/.netrc`, netrc);
  const chmod = Bun.spawn(["chmod", "600", `${home}/.netrc`]);
  await chmod.exited;

  await Promise.all(config.repos.map(async (repo) => {
    const repoName = repo.split("/").pop()!;
    if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
      throw new Error(`Invalid repo name: ${repoName}`);
    }
    console.log(`[Agent] Cloning ${repo}...`);
    const proc = Bun.spawn([
      "git",
      "clone",
      `https://github.com/${repo}.git`,
      `/workspace/${repoName}`,
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "no stderr";
      console.error(`[Agent] Clone failed: ${stderr}`);
      throw new Error(`Failed to clone ${repo}: exit code ${exitCode} — ${stderr}`);
    }
    console.log(`[Agent] Cloned ${repo} successfully`);
    phoneHome("clone_done", repoName);
  }));

  // Set working directory to the first repo so Agent SDK tools operate on it
  const primaryRepo = config.repos[0].split("/").pop()!;
  if (!/^[a-zA-Z0-9._-]+$/.test(primaryRepo)) {
    throw new Error(`Invalid repo name: ${primaryRepo}`);
  }
  process.chdir(`/workspace/${primaryRepo}`);
  console.log(`[Agent] Working directory: /workspace/${primaryRepo}`);

  repoCloned = true;
}

async function checkAndCheckoutWorkBranch(): Promise<string | null> {
  const branchPrefixes = [`ticket/${config.ticketId}`, `feedback/${config.ticketId}`];

  for (const branch of branchPrefixes) {
    const check = Bun.spawn(["git", "ls-remote", "--heads", "origin", branch]);
    const output = await new Response(check.stdout).text();
    const exitCode = await check.exited;

    if (exitCode === 0 && output.trim().length > 0) {
      console.log(`[Agent] Found existing branch on remote: ${branch}`);
      const checkout = Bun.spawn(["git", "checkout", branch]);
      const checkoutExit = await checkout.exited;
      if (checkoutExit !== 0) {
        // Branch doesn't exist locally, create tracking branch
        const track = Bun.spawn(["git", "checkout", "-b", branch, `origin/${branch}`]);
        await track.exited;
      }
      return branch;
    }
  }

  return null;
}

async function startSession(initialPrompt: MessageContent) {
  if (sessionActive) return;
  sessionStatus = "starting_session";

  sessionStartTime = Date.now();
  lastMessageTime = Date.now();

  console.log("[Agent] Creating tools and MCP servers...");
  const { tools } = createTools(config);
  const toolServer = createSdkMcpServer({ name: "pe-tools", tools });
  const externalMcpServers = buildMcpServers();
  console.log(`[Agent] MCP servers: ${Object.keys(externalMcpServers).join(", ")}`);

  const messages = createMessageGenerator();
  // messageYielder is now assigned — safe to mark session active
  sessionActive = true;

  messageYielder!(userMessage(initialPrompt));
  console.log(`[Agent] Initial prompt queued (${typeof initialPrompt === "string" ? initialPrompt.length : JSON.stringify(initialPrompt).length} chars)`);

  phoneHome("session_starting", `prompt_chars=${typeof initialPrompt === "string" ? initialPrompt.length : JSON.stringify(initialPrompt).length}`);
  console.log("[Agent] Starting Agent SDK query()...");

  // Build query options
  // settingSources: ["project"] loads CLAUDE.md, .claude/rules/ (alwaysApply), and
  // .claude/skills/ from the target repo. To keep context lean, target repos should
  // only use alwaysApply rules that are headless-compatible (no interactive prompts,
  // no TodoWrite, no plan mode). See templates/ for headless-optimized templates.
  const queryOptions: any = {
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    maxTurns: 200,
    permissionMode: "bypassPermissions",
    mcpServers: { "pe-tools": toolServer, ...externalMcpServers },
    // Force node runtime — cli.js is a Node bundle, Bun may have compat issues
    executable: "node",
    stderr: (data: string) => {
      lastStderr = data.slice(0, 500);
      console.error(`[Agent][SDK stderr] ${data.slice(0, 300)}`);
      // Don't phone home every stderr chunk — it's available via /status
    },
    hooks: {
      SessionEnd: [
        {
          hooks: [async (input: any, _toolUseID: any, _options: any) => {
            // Upload all transcripts to R2 when session ends (force to capture final state)
            await uploadTranscripts(true);
            return { continue: true };
          }],
        },
      ],
    },
  };

  // Set model if configured (sonnet, opus, haiku)
  if (config.model) {
    queryOptions.model = config.model;
    console.log(`[Agent] Using model: ${config.model}`);
  }

  const session = query({
    prompt: messages,
    options: queryOptions,
  });
  console.log("[Agent] query() returned, starting consumption loop...");

  (async () => {
    try {
      sessionStatus = "running";
      phoneHome("session_running");
      for await (const message of session) {
        sessionMessageCount++;
        lastMessageTime = Date.now();

        // Capture session ID from first message for logging
        if (sessionMessageCount === 1) {
          if (message.session_id) {
            currentSessionId = message.session_id;
            console.log(`[Agent] Session ID: ${currentSessionId}`);
          }
          phoneHome("first_message", `session_id=${currentSessionId}`);
        }

        if (message.type === "assistant" && message.message?.content) {
          // Extract output snippet for logging
          let outputSnippet = "";
          for (const block of message.message.content) {
            if (block.type === "text") {
              outputSnippet = block.text.slice(0, 100);
              break;
            }
          }

          // Track token usage per turn
          const usage = (message.message as any).usage;
          if (usage) {
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;
            const cacheCreationTokens = usage.cache_creation_input_tokens || 0;

            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            totalCacheReadTokens += cacheReadTokens;
            totalCacheCreationTokens += cacheCreationTokens;

            // Calculate cost based on Sonnet 4.6 pricing: $3/MTok input, $15/MTok output
            // (Opus 4.6: $5/$25, Haiku 4.5: $1/$5)
            // Cache reads are 10% of input cost, cache creation is same as input
            // Note: This uses Sonnet pricing for all models - actual costs may vary
            const turnCost =
              (inputTokens * 3.0 / 1_000_000) +
              (outputTokens * 15.0 / 1_000_000) +
              (cacheReadTokens * 0.3 / 1_000_000) +
              (cacheCreationTokens * 3.0 / 1_000_000);

            totalCostUsd += turnCost;

            turnUsageLog.push({
              turn: sessionMessageCount,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
              costUsd: turnCost,
              promptSnippet: lastUserPrompt.slice(0, 100),
              outputSnippet,
            });

            console.log(`[Agent] Turn ${sessionMessageCount} usage: ${inputTokens} in / ${outputTokens} out / $${turnCost.toFixed(4)}`);
            console.log(`[Agent]   Prompt: ${lastUserPrompt.slice(0, 100)}`);
            console.log(`[Agent]   Output: ${outputSnippet}`);
          }

          for (const block of message.message.content) {
            if (block.type === "text") {
              lastAssistantText = block.text.slice(0, 500);
              console.log(`[Agent] ${block.text.slice(0, 200)}`);
            }
            if (block.type === "tool_use") {
              lastToolCall = `${block.name}(${JSON.stringify(block.input).slice(0, 100)})`;
              console.log(`[Agent] Tool: ${block.name}`);
            }
          }
        } else if (message.type === "user") {
          // Capture user message for next turn's logging
          const userMsg = message as SDKUserMessage;
          if (typeof userMsg.message.content === "string") {
            lastUserPrompt = userMsg.message.content;
          }
        } else if (message.type === "result") {
          const result = message as Record<string, unknown>;

          // Extract final usage totals from result message if available
          if (result.total_cost_usd) {
            totalCostUsd = result.total_cost_usd as number;
            console.log(`[Agent] Final cost from SDK: $${totalCostUsd.toFixed(2)}`);
          }

          console.log(`[Agent] Result message: ${JSON.stringify(result).slice(0, 300)}`);
          phoneHome("result", JSON.stringify(result).slice(0, 200));
        }
        // Periodic phone-home every 5th message so we can track progress
        if (sessionMessageCount % 5 === 0) {
          phoneHome("progress", `msgs=${sessionMessageCount} tool=${lastToolCall.slice(0, 80)}`);
        }
      }
      console.log("[Agent] Session ended normally");
      sessionStatus = "completed";
      sessionActive = false;
      phoneHome("session_completed", `msgs=${sessionMessageCount}`);

      // Report token usage
      await reportTokenUsage();

      // Exit the container so it stops using resources
      // The 15m sleepAfter is a safety net, but we should exit immediately when done
      console.log("[Agent] Exiting container after successful completion");
      clearInterval(heartbeatInterval);
      clearInterval(transcriptBackupInterval);
      clearInterval(timeoutWatchdog);
      process.exit(0);
    } catch (err) {
      console.error("[Agent] Session error:", err);
      sessionError = String(err);
      sessionStatus = "error";
      sessionActive = false;
      phoneHome("session_error", `${String(err).slice(0, 150)} | stderr=${lastStderr.slice(0, 100)}`);

      // Upload transcripts on error to capture work done before crash
      try {
        await uploadTranscripts(true);
      } catch (uploadErr) {
        console.error("[Agent] Failed to upload transcript after error:", uploadErr);
      }

      // Exit the container so it stops using resources
      console.log("[Agent] Exiting container after error");
      clearInterval(heartbeatInterval);
      clearInterval(transcriptBackupInterval);
      clearInterval(timeoutWatchdog);
      // Use exit code 1 for errors so monitoring can distinguish success vs failure
      process.exit(1);
    }
  })();
}

app.post("/event", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || key !== config.apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const event = await c.req.json<TicketEvent>();
  console.log(`[Agent] Event: ${event.type} from ${event.source}`);

  try {
    // Capture thread_ts from event so Slack tools reply in-thread
    if (event.slackThreadTs) {
      config.slackThreadTs = event.slackThreadTs;
    }

    await cloneRepos();

    if (!sessionActive) {
      const taskType: TaskPayload["type"] =
        event.type === "ticket_created"
          ? "ticket"
          : event.type === "slack_mention" || event.type === "slack_reply"
            ? "command"
            : event.type === "feedback"
              ? "feedback"
              : "ticket";
      const taskPayload: TaskPayload = {
        type: taskType,
        product: config.product,
        repos: config.repos,
        data: event.payload as TaskPayload["data"],
      };

      // Extract ticket metadata for Slack status updates
      if (taskType === "ticket") {
        const ticketData = event.payload as any;
        config.ticketIdentifier = ticketData.identifier;
        config.ticketTitle = ticketData.title;
      }

      const prompt = await buildPrompt(taskPayload, config.slackBotToken);
      await startSession(prompt);
    } else if (messageYielder) {
      const continuationPrompt = await buildEventPrompt(event, config.slackBotToken);
      messageYielder(userMessage(continuationPrompt));
    } else {
      return c.json({ error: "Session initializing" }, 503);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[Agent] Event handling error:", err);
    phoneHome("event_error", String(err).slice(0, 200));
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/health", (c) =>
  c.json({ ok: true, service: "ticket-agent-container" }),
);

app.get("/status", (c) =>
  c.json({
    service: "ticket-agent-container",
    ticketId: config.ticketId,
    product: config.product,
    sessionActive,
    sessionStatus,
    sessionMessageCount,
    sessionError,
    repoCloned,
  }),
);

app.post("/shutdown", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || key !== config.apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  console.log("[Agent] Shutdown requested - exiting container");
  phoneHome("shutdown_requested", `status=${sessionStatus} msgs=${sessionMessageCount}`);

  // Clear intervals immediately to prevent concurrent work during shutdown
  clearInterval(heartbeatInterval);
  clearInterval(transcriptBackupInterval);
  clearInterval(timeoutWatchdog);

  const SHUTDOWN_TIMEOUT_MS = 15000;

  // Perform shutdown work (upload transcripts, report tokens) with a bounded timeout
  const shutdownWork = (async () => {
    // Upload transcripts before shutdown
    await uploadTranscripts(true);

    // Report final token usage if session was active
    if (sessionActive || sessionMessageCount > 0) {
      await reportTokenUsage();
    }
  })();

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn(
        `[Agent] Shutdown work exceeded ${SHUTDOWN_TIMEOUT_MS}ms timeout; proceeding with exit`,
      );
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
  });

  try {
    await Promise.race([shutdownWork, timeoutPromise]);
  } finally {
    // Schedule process exit regardless of shutdown work outcome
    setTimeout(() => process.exit(0), 100);
  }

  // Return response after shutdown sequence has been initiated
  return c.json({ ok: true });
});

export default {
  port: 3000,
  fetch: app.fetch,
};

// Auto-resume: if container restarts with a ticket config, check for existing
// work branch and resume the session without waiting for an event.
// This fires after the server is listening, so /health can respond while we resume.
setTimeout(async () => {
  if (sessionActive) return; // Event already triggered a session

  try {
    await cloneRepos();
    const branch = await checkAndCheckoutWorkBranch();

    if (branch) {
      // Check orchestrator state before resuming — skip if ticket is inactive
      try {
        const statusRes = await fetch(
          `${config.workerUrl}/api/orchestrator/ticket-status/${encodeURIComponent(config.ticketId)}`,
          { headers: { "X-Internal-Key": config.apiKey } },
        );
        if (statusRes.ok) {
          const ticketStatus = (await statusRes.json()) as {
            agent_active?: number;
            status?: string;
          };
          const terminalStatuses = ["merged", "closed", "deferred", "failed"];
          if (
            ticketStatus.agent_active === 0 ||
            terminalStatuses.includes(ticketStatus.status || "")
          ) {
            console.log(
              `[Agent] Ticket ${config.ticketId} is inactive (agent_active=${ticketStatus.agent_active}, status=${ticketStatus.status}) — skipping auto-resume`,
            );
            phoneHome(
              "auto_resume_skipped",
              `reason=inactive,status=${ticketStatus.status}`,
            );
            process.exit(0);
            return;
          }
        }
      } catch (err) {
        // Fail-open: if we can't reach orchestrator, proceed with resume
        console.warn(
          "[Agent] Could not check orchestrator status, proceeding with resume:",
          err,
        );
      }

      console.log(`[Agent] Auto-resuming from branch: ${branch}`);
      phoneHome("auto_resume", `branch=${branch}`);

      // Get git state for context
      const logProc = Bun.spawn(["git", "log", "--oneline", "-10"]);
      const gitLog = await new Response(logProc.stdout).text();

      const statusProc = Bun.spawn(["git", "status", "--short"]);
      const gitStatus = await new Response(statusProc.stdout).text();

      // Check for existing PR
      const prProc = Bun.spawn(["gh", "pr", "view", "--json", "url,state,title", branch]);
      const prOutput = await new Response(prProc.stdout).text();
      const prExit = await prProc.exited;
      const prInfo = prExit === 0 ? prOutput.trim() : "No PR found";

      const resumePrompt = buildResumePrompt(branch, gitLog.trim(), gitStatus.trim(), prInfo);

      // Notify Slack about recovery
      if (config.slackChannel && config.slackBotToken) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.slackBotToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: config.slackChannel,
            text: `Container restarted — resuming work from branch \`${branch}\``,
            ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
          }),
        }).catch((err: Error) => console.error("[Agent] Failed to post recovery message:", err));
      }

      await startSession(resumePrompt);
    } else {
      console.log("[Agent] No existing work branch found — waiting for event");
    }
  } catch (err) {
    console.error("[Agent] Auto-resume failed:", err);
    phoneHome("auto_resume_failed", String(err).slice(0, 200));
  }
}, 5000); // Wait 5s for container to stabilize
