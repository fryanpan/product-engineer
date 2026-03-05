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
import { loadConfig, type TaskPayload, type TicketEvent } from "./config";
import { createTools } from "./tools";
import { buildPrompt, buildEventPrompt } from "./prompt";
import { buildMcpServers } from "./mcp";

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

function userMessage(content: string): SDKUserMessage {
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

// Find the most recent transcript file for the current session
async function findCurrentTranscript(): Promise<string | null> {
  try {
    const home = process.env.HOME || "/home/agent";
    const cwd = process.cwd().replace(/\//g, "-");
    const sessionDir = `${home}/.claude/projects/${cwd}`;

    // Check if directory exists
    const dirExists = await Bun.file(sessionDir).exists().catch(() => false);
    if (!dirExists) {
      return null;
    }

    // List all .jsonl files in the directory
    const proc = Bun.spawn(["ls", "-1t", sessionDir]);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return null;
    }

    // Find the most recent transcript file
    // Files can be named: <session-id>.jsonl or agent-<hash>.jsonl
    const files = output.trim().split("\n").filter(Boolean);
    const transcriptFiles = files.filter(f => f.endsWith(".jsonl"));

    if (transcriptFiles.length === 0) {
      return null;
    }

    // Return the most recent (first in time-sorted list)
    return `${sessionDir}/${transcriptFiles[0]}`;
  } catch (err) {
    console.error("[Agent] Error finding transcript:", err);
    return null;
  }
}

// Upload transcript to R2 via the worker
async function uploadTranscript(transcriptPath?: string) {
  try {
    // If no path provided, find the current session's transcript
    const path = transcriptPath || await findCurrentTranscript();
    if (!path) {
      console.log("[Agent] No transcript file found to upload");
      return;
    }

    console.log(`[Agent] Uploading transcript from ${path}...`);
    const transcriptContent = await Bun.file(path).text();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const r2Key = `${config.ticketId}-${timestamp}.jsonl`;

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
      console.error(`[Agent] Transcript upload failed: ${uploadRes.status} — ${errorText}`);
      return;
    }

    console.log(`[Agent] Transcript uploaded successfully: ${r2Key}`);
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

// Periodic transcript backup every 5 minutes to capture work-in-progress
const transcriptBackupInterval = setInterval(() => {
  if (sessionStatus === "completed" || sessionStatus === "error") {
    clearInterval(transcriptBackupInterval);
    return;
  }
  if (sessionStatus === "running" && sessionActive) {
    console.log("[Agent] Periodic transcript backup...");
    uploadTranscript().catch((err) => console.error("[Agent] Periodic backup failed:", err));
  }
}, 300_000); // 5 minutes

// Signal handlers to upload transcript on container shutdown
async function handleShutdown(signal: string) {
  console.log(`[Agent] Received ${signal}, uploading transcript before shutdown...`);
  clearInterval(heartbeatInterval);
  clearInterval(transcriptBackupInterval);
  await uploadTranscript();
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

// Check if a session exists for this ticket and return the session ID
async function findExistingSession(): Promise<string | null> {
  try {
    const home = process.env.HOME || "/home/agent";
    const sessionDir = `${home}/.claude/projects`;

    // Check if the sessions directory exists (R2 mount should have created it)
    const dirExists = await Bun.file(sessionDir).exists().catch(() => false);
    if (!dirExists) {
      console.log("[Agent] No session directory found — starting fresh");
      return null;
    }

    // List files in the session directory
    const proc = Bun.spawn(["ls", "-1", sessionDir]);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.log("[Agent] Failed to list session directory");
      return null;
    }

    // Look for session files matching this ticket ID
    // Session files are typically named like: <ticket-id>-<timestamp>-<session-id>
    const files = output.trim().split("\n").filter(Boolean);
    const sessionFiles = files.filter(f => f.startsWith(config.ticketId) && f.endsWith(".jsonl"));

    if (sessionFiles.length === 0) {
      console.log("[Agent] No existing session files found");
      return null;
    }

    // Use the most recent session file (last in sorted order)
    const latestSession = sessionFiles.sort().pop()!;
    console.log(`[Agent] Found existing session file: ${latestSession}`);

    // Extract session ID from filename if possible
    // Filename format varies, but we can try to parse it
    // For now, return a marker that we found a session
    return latestSession;
  } catch (err) {
    console.error("[Agent] Error checking for existing session:", err);
    return null;
  }
}

async function startSession(initialPrompt: string) {
  if (sessionActive) return;
  sessionStatus = "starting_session";

  // Check for existing session to resume
  const existingSession = await findExistingSession();
  const isResuming = existingSession !== null;

  if (isResuming) {
    console.log(`[Agent] Resuming existing session from: ${existingSession}`);
    phoneHome("deploy_recovery", `resuming session: ${existingSession}`);

    // Notify Slack about recovery
    const recoveryMessage = `🔄 **Container restarted — resuming work**\n\nRecovering from deploy. Session files found: \`${existingSession}\`\n\nContinuing where I left off...`;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: config.slackChannel,
        text: recoveryMessage,
        ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
      }),
    }).catch((err) => console.error("[Agent] Failed to post recovery message to Slack:", err));
  } else {
    console.log("[Agent] Starting fresh session");
  }

  console.log("[Agent] Creating tools and MCP servers...");
  const { tools } = createTools(config);
  const toolServer = createSdkMcpServer({ name: "pe-tools", tools });
  const externalMcpServers = buildMcpServers();
  console.log(`[Agent] MCP servers: ${Object.keys(externalMcpServers).join(", ")}`);

  const messages = createMessageGenerator();
  // messageYielder is now assigned — safe to mark session active
  sessionActive = true;

  if (isResuming) {
    // When resuming, tell the agent to continue where it left off
    messageYielder!(userMessage("Your container was restarted during a deploy. Please continue where you left off. Check your previous work (git status, git log) and resume the task."));
    console.log("[Agent] Resume continuation prompt queued");
  } else {
    messageYielder!(userMessage(initialPrompt));
    console.log(`[Agent] Initial prompt queued (${initialPrompt.length} chars)`);
  }

  phoneHome("session_starting", `prompt_chars=${initialPrompt.length} resuming=${isResuming}`);
  console.log("[Agent] Starting Agent SDK query()...");

  // Build query options
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
            // Upload transcript to R2 when session ends
            await uploadTranscript(input.transcript_path);
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

  // Resume the most recent session if we found existing session files
  if (isResuming) {
    queryOptions.continue = true;
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
    } catch (err) {
      console.error("[Agent] Session error:", err);
      sessionError = String(err);
      sessionStatus = "error";
      sessionActive = false;
      phoneHome("session_error", `${String(err).slice(0, 150)} | stderr=${lastStderr.slice(0, 100)}`);

      // Upload transcript on error to capture work done before crash
      try {
        await uploadTranscript();
      } catch (uploadErr) {
        console.error("[Agent] Failed to upload transcript after error:", uploadErr);
      }
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
          : event.type === "slack_mention"
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

      const prompt = buildPrompt(taskPayload);
      await startSession(prompt);
    } else if (messageYielder) {
      const continuationPrompt = buildEventPrompt(event);
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

export default {
  port: 3000,
  fetch: app.fetch,
};
