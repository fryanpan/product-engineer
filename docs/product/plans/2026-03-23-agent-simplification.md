# Agent Simplification + Slack Echo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decompose the monolithic `server.ts` (1026 lines, 13 mixed concerns) into focused modules, simplify `tools.ts`, and add automatic Slack echo of all SDK messages/tool uses without consuming LLM tokens.

**Architecture:** Extract server.ts into 4 focused modules (token tracking, transcript management, lifecycle/watchdogs, Slack echo). Simplify tools.ts by extracting the 92-line `update_task_status` into composable helpers. Add a Slack echo layer in the SDK consumption loop that auto-posts assistant messages and tool uses to the Slack thread.

**Tech Stack:** TypeScript, Bun, Agent SDK, Slack API

---

## Current State

### server.ts (1026 lines) — 13 mixed concerns:
1. HTTP server (Hono routes)
2. Session state machine (idle → cloning → starting → running → completed/error)
3. Event handling (POST /event dispatch)
4. Repo cloning + branch checkout
5. Plugin loading
6. Prompt building
7. Token usage tracking + reporting (lines 64-148, 650-688)
8. Transcript management (lines 157-240)
9. Heartbeat + phone-home (lines 48-61, 243-261)
10. Timeout watchdogs (lines 263-300)
11. Shutdown/signal handlers (lines 314-325)
12. Auto-resume logic (lines 942-1026)
13. SDK consumption loop (lines 623-804)

### tools.ts (645 lines) — mixed granularity:
- Pure I/O (good): `notify_slack`, `ask_question`, `fetch_slack_file` — thin API wrappers
- Logic-heavy (needs simplification): `update_task_status` (92 lines doing 3 things: orchestrator update + Linear state update + Slack message update)
- Already factored well: `check_ci_status`, `merge_pr` (delegate to merge-gate.ts)
- Conductor tools (fine): `list_tasks`, `spawn_task`, `send_message_to_task`

---

## Task 1: Extract Token Tracking to `agent/src/token-tracker.ts`

**Files:**
- Create: `agent/src/token-tracker.ts`
- Create: `agent/src/token-tracker.test.ts`
- Modify: `agent/src/server.ts` (remove lines 64-148, 392-408, 650-688)

**Step 1: Write the failing test**

```typescript
// agent/src/token-tracker.test.ts
import { describe, test, expect } from "bun:test";
import { TokenTracker } from "./token-tracker";

describe("TokenTracker", () => {
  test("starts with zero totals", () => {
    const tracker = new TokenTracker();
    const summary = tracker.getSummary();
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.turns).toBe(0);
  });

  test("records turn usage", () => {
    const tracker = new TokenTracker();
    tracker.recordTurn({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      promptSnippet: "test prompt",
      outputSnippet: "test output",
    });
    const summary = tracker.getSummary();
    expect(summary.turns).toBe(1);
    expect(summary.totalInputTokens).toBe(1000);
    expect(summary.totalOutputTokens).toBe(500);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
  });

  test("formats Slack summary", () => {
    const tracker = new TokenTracker();
    tracker.recordTurn({
      inputTokens: 10000, outputTokens: 2000,
      cacheReadTokens: 5000, cacheCreationTokens: 1000,
    });
    const msg = tracker.formatSlackSummary();
    expect(msg).toContain("Token Usage Summary");
    expect(msg).toContain("Total Cost");
  });

  test("reset clears all state", () => {
    const tracker = new TokenTracker();
    tracker.recordTurn({ inputTokens: 100, outputTokens: 50 });
    tracker.reset();
    expect(tracker.getSummary().turns).toBe(0);
  });

  test("overrideCost replaces calculated cost", () => {
    const tracker = new TokenTracker();
    tracker.recordTurn({ inputTokens: 100, outputTokens: 50 });
    tracker.overrideCost(5.0);
    expect(tracker.getSummary().totalCostUsd).toBe(5.0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/token-tracker.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// agent/src/token-tracker.ts

interface TurnInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptSnippet?: string;
  outputSnippet?: string;
}

interface TurnRecord {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  promptSnippet?: string;
  outputSnippet?: string;
}

interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  turns: number;
}

/** Calculates per-turn cost using Sonnet 4.6 pricing as baseline. */
function calculateTurnCost(t: TurnInput): number {
  return (
    (t.inputTokens * 3.0) / 1_000_000 +
    (t.outputTokens * 15.0) / 1_000_000 +
    ((t.cacheReadTokens || 0) * 0.3) / 1_000_000 +
    ((t.cacheCreationTokens || 0) * 3.0) / 1_000_000
  );
}

export class TokenTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheCreationTokens = 0;
  private totalCostUsd = 0;
  private turnLog: TurnRecord[] = [];

  recordTurn(input: TurnInput): void {
    const cost = calculateTurnCost(input);
    this.totalInputTokens += input.inputTokens;
    this.totalOutputTokens += input.outputTokens;
    this.totalCacheReadTokens += input.cacheReadTokens || 0;
    this.totalCacheCreationTokens += input.cacheCreationTokens || 0;
    this.totalCostUsd += cost;

    this.turnLog.push({
      turn: this.turnLog.length + 1,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens || 0,
      cacheCreationTokens: input.cacheCreationTokens || 0,
      costUsd: cost,
      promptSnippet: input.promptSnippet,
      outputSnippet: input.outputSnippet,
    });
  }

  overrideCost(cost: number): void {
    this.totalCostUsd = cost;
  }

  getSummary(): UsageSummary {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheCreationTokens: this.totalCacheCreationTokens,
      totalCostUsd: this.totalCostUsd,
      turns: this.turnLog.length,
    };
  }

  formatSlackSummary(): string {
    const s = this.getSummary();
    const lines: string[] = [
      `📊 **Token Usage Summary**\n`,
      `**Total Cost:** $${s.totalCostUsd.toFixed(2)}`,
      `**Input:** ${(s.totalInputTokens / 1000).toFixed(1)}K tokens ($${((s.totalInputTokens * 3.0) / 1_000_000).toFixed(2)})`,
      `**Output:** ${(s.totalOutputTokens / 1000).toFixed(1)}K tokens ($${((s.totalOutputTokens * 15.0) / 1_000_000).toFixed(2)})`,
    ];

    if (s.totalCacheReadTokens > 0) {
      lines.push(`**Cache Read:** ${(s.totalCacheReadTokens / 1000).toFixed(1)}K tokens ($${((s.totalCacheReadTokens * 0.3) / 1_000_000).toFixed(2)})`);
    }
    if (s.totalCacheCreationTokens > 0) {
      lines.push(`**Cache Creation:** ${(s.totalCacheCreationTokens / 1000).toFixed(1)}K tokens ($${((s.totalCacheCreationTokens * 3.0) / 1_000_000).toFixed(2)})`);
    }

    lines.push(`**Conversation Turns:** ${s.turns}\n`);

    // Top 3 most expensive turns
    const topTurns = [...this.turnLog].sort((a, b) => b.costUsd - a.costUsd).slice(0, 3);
    if (topTurns.length > 0) {
      lines.push(`**Most Expensive Turns:**`);
      for (const t of topTurns) {
        lines.push(`• Turn ${t.turn}: $${t.costUsd.toFixed(4)} (${t.inputTokens} in / ${t.outputTokens} out)`);
        if (t.promptSnippet) lines.push(`  Prompt: "${t.promptSnippet}${t.promptSnippet.length >= 100 ? "..." : ""}"`);
        if (t.outputSnippet) lines.push(`  Output: "${t.outputSnippet}${t.outputSnippet.length >= 100 ? "..." : ""}"`);
      }
    }

    return lines.join("\n");
  }

  /** Report usage to orchestrator + Slack. */
  async report(config: { workerUrl: string; apiKey: string; ticketUUID: string; slackBotToken: string; slackChannel: string; slackThreadTs?: string | null; sessionMessageCount: number }): Promise<void> {
    const s = this.getSummary();
    console.log(`[Agent] Reporting token usage: ${s.totalInputTokens} in / ${s.totalOutputTokens} out / $${s.totalCostUsd.toFixed(2)}`);

    // Report to orchestrator
    try {
      await fetch(`${config.workerUrl}/api/internal/token-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": config.apiKey },
        body: JSON.stringify({ ticketUUID: config.ticketUUID, ...s, sessionMessageCount: config.sessionMessageCount }),
      });
    } catch (err) {
      console.error("[Agent] Failed to report token usage:", err);
    }

    // Post to Slack
    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.slackBotToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: config.slackChannel,
          text: this.formatSlackSummary(),
          ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
        }),
      });
    } catch (err) {
      console.error("[Agent] Failed to post token usage to Slack:", err);
    }
  }

  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
    this.totalCostUsd = 0;
    this.turnLog = [];
  }
}
```

**Step 4: Run tests**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/token-tracker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add agent/src/token-tracker.ts agent/src/token-tracker.test.ts
git commit -m "refactor: extract TokenTracker from server.ts"
```

---

## Task 2: Extract Transcript Management to `agent/src/transcripts.ts`

**Files:**
- Create: `agent/src/transcripts.ts`
- Modify: `agent/src/server.ts` (remove lines 157-240, 303-311)

**Step 1: Write the failing test**

```typescript
// agent/src/transcripts.test.ts
import { describe, test, expect, mock } from "bun:test";
import { TranscriptManager } from "./transcripts";

describe("TranscriptManager", () => {
  test("constructs with config", () => {
    const mgr = new TranscriptManager({
      agentUuid: "test-uuid",
      workerUrl: "http://localhost",
      apiKey: "key",
      ticketUUID: "ticket-1",
    });
    expect(mgr).toBeTruthy();
  });

  test("getTranscriptDir returns correct path", () => {
    const mgr = new TranscriptManager({
      agentUuid: "test-uuid",
      workerUrl: "http://localhost",
      apiKey: "key",
      ticketUUID: "ticket-1",
    });
    const dir = mgr.getTranscriptDir();
    expect(dir).toContain(".claude/projects/");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/transcripts.test.ts`

**Step 3: Write the implementation**

Extract `getTranscriptDir()`, `findAllTranscripts()`, `uploadTranscripts()`, and `uploadedSizes` map into a `TranscriptManager` class.

```typescript
// agent/src/transcripts.ts

interface TranscriptConfig {
  agentUuid: string;
  workerUrl: string;
  apiKey: string;
  ticketUUID: string;
}

export class TranscriptManager {
  private uploadedSizes = new Map<string, number>();
  private config: TranscriptConfig;

  constructor(config: TranscriptConfig) {
    this.config = config;
  }

  getTranscriptDir(): string {
    const home = process.env.HOME || "/home/agent";
    const cwd = process.cwd().replace(/\//g, "-");
    return `${home}/.claude/projects/${cwd}`;
  }

  async findAllTranscripts(): Promise<string[]> {
    try {
      const sessionDir = this.getTranscriptDir();
      const proc = Bun.spawn(["ls", "-1", sessionDir]);
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) return [];
      return output.trim().split("\n").filter(f => f.endsWith(".jsonl")).map(f => `${sessionDir}/${f}`);
    } catch {
      return [];
    }
  }

  async upload(force = false): Promise<void> {
    try {
      const files = await this.findAllTranscripts();
      if (files.length === 0) {
        console.log("[Agent] No transcript files found to upload");
        return;
      }

      for (const path of files) {
        try {
          const file = Bun.file(path);
          const currentSize = file.size;
          const prevSize = this.uploadedSizes.get(path) ?? 0;
          if (!force && currentSize === prevSize) continue;

          const basename = path.split("/").pop()!;
          const r2Key = `${this.config.agentUuid}-${basename}`;
          console.log(`[Agent] Uploading transcript ${basename} (${currentSize} bytes, was ${prevSize})...`);

          const transcriptContent = await file.text();
          this.uploadedSizes.set(path, currentSize);

          const uploadRes = await fetch(`${this.config.workerUrl}/api/internal/upload-transcript`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Key": this.config.apiKey },
            body: JSON.stringify({ ticketUUID: this.config.ticketUUID, r2Key, transcript: transcriptContent }),
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
}
```

**Step 4: Run tests**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/transcripts.test.ts`

**Step 5: Commit**

```bash
git add agent/src/transcripts.ts agent/src/transcripts.test.ts
git commit -m "refactor: extract TranscriptManager from server.ts"
```

---

## Task 3: Extract Slack Echo to `agent/src/slack-echo.ts`

**Files:**
- Create: `agent/src/slack-echo.ts`
- Create: `agent/src/slack-echo.test.ts`
- Modify: `agent/src/server.ts` (add echo calls in SDK consumption loop)

This is the "echo every message and tool use to Slack" feature. It runs in the SDK consumption loop (server.ts lines 627-723) and posts formatted summaries to Slack without consuming any LLM tokens — it's pure code, not a tool.

**Step 1: Write the failing test**

```typescript
// agent/src/slack-echo.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { SlackEcho, type SlackEchoConfig } from "./slack-echo";

describe("SlackEcho", () => {
  let fetchCalls: Array<{ url: string; body: any }>;
  let echoConfig: SlackEchoConfig;

  beforeEach(() => {
    fetchCalls = [];
    echoConfig = {
      slackBotToken: "xoxb-test",
      slackChannel: "C123",
      slackThreadTs: "1234567890.123456",
      fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: url.toString(), body });
        return new Response(JSON.stringify({ ok: true }));
      },
    };
  });

  test("echoAssistantText posts formatted text to Slack", async () => {
    const echo = new SlackEcho(echoConfig);
    await echo.echoAssistantText("Working on the implementation now.");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.text).toContain("Working on the implementation now.");
    expect(fetchCalls[0].body.thread_ts).toBe("1234567890.123456");
  });

  test("echoToolUse posts tool summary to Slack", async () => {
    const echo = new SlackEcho(echoConfig);
    await echo.echoToolUse("Bash", { command: "bun test" });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.text).toContain("Bash");
  });

  test("skips echo when no thread_ts", async () => {
    echoConfig.slackThreadTs = undefined;
    const echo = new SlackEcho(echoConfig);
    await echo.echoAssistantText("test");
    expect(fetchCalls).toHaveLength(0);
  });

  test("debounces rapid text messages", async () => {
    const echo = new SlackEcho(echoConfig);
    // Fire 3 rapid texts — should batch
    echo.echoAssistantText("msg 1");
    echo.echoAssistantText("msg 2");
    await echo.echoAssistantText("msg 3");
    // Should batch into fewer calls
    expect(fetchCalls.length).toBeLessThanOrEqual(2);
  });

  test("truncates long text", async () => {
    const echo = new SlackEcho(echoConfig);
    const longText = "x".repeat(5000);
    await echo.echoAssistantText(longText);
    expect(fetchCalls[0].body.text.length).toBeLessThan(3100);
  });

  test("formats tool input as compact summary", async () => {
    const echo = new SlackEcho(echoConfig);
    await echo.echoToolUse("Edit", {
      file_path: "/workspace/repo/src/foo.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    expect(fetchCalls[0].body.text).toContain("Edit");
    expect(fetchCalls[0].body.text).toContain("foo.ts");
  });

  test("silently catches fetch errors", async () => {
    echoConfig.fetchFn = async () => { throw new Error("network error"); };
    const echo = new SlackEcho(echoConfig);
    // Should not throw
    await echo.echoAssistantText("test");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/slack-echo.test.ts`

**Step 3: Write the implementation**

```typescript
// agent/src/slack-echo.ts

export interface SlackEchoConfig {
  slackBotToken: string;
  slackChannel: string;
  slackThreadTs?: string | null;
  slackPersona?: { username?: string; icon_emoji?: string; icon_url?: string };
  fetchFn?: typeof fetch;
}

const MAX_TEXT_LENGTH = 3000;

/** Format tool input as a compact one-line summary. */
function formatToolInput(name: string, input: Record<string, unknown>): string {
  // Tool-specific compact formats
  if (name === "Bash" && input.command) {
    return `\`$ ${String(input.command).slice(0, 200)}\``;
  }
  if (name === "Read" && input.file_path) {
    const file = String(input.file_path).split("/").slice(-2).join("/");
    return `📄 ${file}`;
  }
  if ((name === "Edit" || name === "Write") && input.file_path) {
    const file = String(input.file_path).split("/").slice(-2).join("/");
    return `✏️ ${file}`;
  }
  if (name === "Glob" && input.pattern) {
    return `🔍 \`${input.pattern}\``;
  }
  if (name === "Grep" && input.pattern) {
    return `🔍 \`${input.pattern}\``;
  }
  if (name === "Agent" && input.description) {
    return `🤖 ${input.description}`;
  }

  // Generic: show first 150 chars of JSON
  const json = JSON.stringify(input);
  return json.length > 150 ? json.slice(0, 150) + "…" : json;
}

/**
 * Echoes Agent SDK messages and tool uses to a Slack thread.
 *
 * This is a fire-and-forget layer — errors are silently caught.
 * No LLM tokens are consumed; this runs in pure code.
 */
export class SlackEcho {
  private config: SlackEchoConfig;
  private fetchFn: typeof fetch;
  private pendingText: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;

  constructor(config: SlackEchoConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn || fetch;
  }

  /** Update thread_ts (e.g., after first Slack post creates the thread). */
  setThreadTs(ts: string): void {
    this.config.slackThreadTs = ts;
  }

  /** Echo assistant text to Slack thread. Debounced to batch rapid messages. */
  async echoAssistantText(text: string): Promise<void> {
    if (!this.config.slackThreadTs) return;
    if (!text.trim()) return;

    this.pendingText.push(text);

    // Debounce: wait DEBOUNCE_MS for more text before posting
    if (this.flushTimer) clearTimeout(this.flushTimer);

    return new Promise<void>((resolve) => {
      this.flushTimer = setTimeout(async () => {
        const batch = this.pendingText.splice(0);
        if (batch.length === 0) { resolve(); return; }

        let combined = batch.join("\n\n");
        if (combined.length > MAX_TEXT_LENGTH) {
          combined = combined.slice(0, MAX_TEXT_LENGTH) + "\n…(truncated)";
        }

        await this.post(`💬 ${combined}`);
        resolve();
      }, this.DEBOUNCE_MS);
    });
  }

  /** Echo a tool use to Slack thread. Posted immediately (no debounce). */
  async echoToolUse(toolName: string, input: Record<string, unknown>): Promise<void> {
    if (!this.config.slackThreadTs) return;

    // Skip echoing our own Slack tools to avoid recursion
    if (["notify_slack", "ask_question", "update_task_status"].includes(toolName)) return;

    const summary = formatToolInput(toolName, input);
    await this.post(`🔧 *${toolName}* ${summary}`);
  }

  /** Flush any pending debounced text immediately. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.pendingText.splice(0);
    if (batch.length === 0) return;

    let combined = batch.join("\n\n");
    if (combined.length > MAX_TEXT_LENGTH) {
      combined = combined.slice(0, MAX_TEXT_LENGTH) + "\n…(truncated)";
    }
    await this.post(`💬 ${combined}`);
  }

  private async post(text: string): Promise<void> {
    try {
      const persona = this.config.slackPersona || {};
      await this.fetchFn("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: this.config.slackChannel,
          text,
          thread_ts: this.config.slackThreadTs,
          ...(persona.username && { username: persona.username }),
          ...(persona.icon_emoji && { icon_emoji: persona.icon_emoji }),
          ...(persona.icon_url && { icon_url: persona.icon_url }),
        }),
      });
    } catch (err) {
      // Fire-and-forget — don't let echo errors affect the agent
      console.error("[SlackEcho] Failed to post:", err);
    }
  }
}
```

**Step 4: Run tests**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/slack-echo.test.ts`

**Step 5: Commit**

```bash
git add agent/src/slack-echo.ts agent/src/slack-echo.test.ts
git commit -m "feat: add SlackEcho for automatic SDK message echoing to Slack threads"
```

---

## Task 4: Extract `update_task_status` helpers in `tools.ts`

**Files:**
- Create: `agent/src/status-updater.ts`
- Create: `agent/src/status-updater.test.ts`
- Modify: `agent/src/tools.ts` (replace 92-line inline with calls to StatusUpdater)

The `update_task_status` tool currently does 3 things in 92 lines:
1. POST to orchestrator `/api/internal/status`
2. GraphQL mutation to Linear API (look up workflow states, then update)
3. Update top-level Slack message with status emoji

Extract these into a `StatusUpdater` class with 3 focused methods.

**Step 1: Write the failing test**

```typescript
// agent/src/status-updater.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { StatusUpdater, type StatusUpdaterConfig } from "./status-updater";

describe("StatusUpdater", () => {
  let fetchCalls: Array<{ url: string; body: any }>;
  let config: StatusUpdaterConfig;

  beforeEach(() => {
    fetchCalls = [];
    config = {
      workerUrl: "http://localhost",
      apiKey: "test-key",
      ticketUUID: "uuid-1",
      slackBotToken: "xoxb-test",
      slackChannel: "C123",
      slackThreadTs: "123.456",
      ticketIdentifier: "PE-1",
      ticketTitle: "Test ticket",
      fetchFn: async (url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        fetchCalls.push({ url: url.toString(), body });
        // Mock Linear GraphQL responses
        if (url.toString().includes("linear.app")) {
          if (body.query?.includes("issue(id")) {
            return new Response(JSON.stringify({
              data: { issue: { team: { states: { nodes: [
                { id: "state-1", name: "In Progress" },
                { id: "state-2", name: "In Review" },
                { id: "state-3", name: "Done" },
              ] } } } }
            }));
          }
          return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }));
        }
        return new Response(JSON.stringify({ ok: true }));
      },
    };
  });

  test("updateOrchestrator sends status to worker", async () => {
    const updater = new StatusUpdater(config);
    await updater.updateOrchestrator("in_progress");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.status).toBe("in_progress");
    expect(fetchCalls[0].body.ticketUUID).toBe("uuid-1");
  });

  test("updateLinear maps status to workflow state", async () => {
    const updater = new StatusUpdater({ ...config, linearAppToken: "lin-token" });
    await updater.updateLinear("in_progress", "uuid-1");
    expect(fetchCalls).toHaveLength(2); // lookup + mutation
    expect(fetchCalls[1].body.variables.stateId).toBe("state-1");
  });

  test("updateSlackStatus formats emoji and text", async () => {
    const updater = new StatusUpdater(config);
    await updater.updateSlackStatus("pr_open");
    const call = fetchCalls.find(c => c.url.includes("chat.update"));
    expect(call?.body.text).toContain("👀");
    expect(call?.body.text).toContain("IN REVIEW");
  });

  test("updateSlackStatus uses ✅ for merged", async () => {
    const updater = new StatusUpdater(config);
    await updater.updateSlackStatus("merged");
    const call = fetchCalls.find(c => c.url.includes("chat.update"));
    expect(call?.body.text).toContain("✅");
  });

  test("skips Linear update when no token", async () => {
    const updater = new StatusUpdater(config); // no linearAppToken
    await updater.updateLinear("in_progress", "uuid-1");
    expect(fetchCalls).toHaveLength(0);
  });

  test("skips Slack update when no thread_ts", async () => {
    const updater = new StatusUpdater({ ...config, slackThreadTs: undefined });
    await updater.updateSlackStatus("in_progress");
    expect(fetchCalls).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/status-updater.test.ts`

**Step 3: Write the implementation**

```typescript
// agent/src/status-updater.ts

export interface StatusUpdaterConfig {
  workerUrl: string;
  apiKey: string;
  ticketUUID: string;
  slackBotToken: string;
  slackChannel: string;
  slackThreadTs?: string | null;
  linearAppToken?: string;
  ticketIdentifier?: string;
  ticketTitle?: string;
  fetchFn?: typeof fetch;
}

const LINEAR_STATE_MAP: Record<string, string> = {
  in_progress: "In Progress",
  pr_open: "In Review",
  in_review: "In Review",
  needs_revision: "In Progress",
  merged: "Done",
  closed: "Done",
  deferred: "Canceled",
  failed: "Canceled",
  asking: "In Progress",
};

const STATUS_DISPLAY: Record<string, { emoji: string; text: string }> = {
  merged: { emoji: "✅", text: "DONE" },
  closed: { emoji: "✅", text: "DONE" },
  pr_open: { emoji: "👀", text: "IN REVIEW" },
  in_review: { emoji: "👀", text: "IN REVIEW" },
  failed: { emoji: "❌", text: "FAILED" },
};

export class StatusUpdater {
  private config: StatusUpdaterConfig;
  private fetchFn: typeof fetch;

  constructor(config: StatusUpdaterConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn || fetch;
  }

  async updateOrchestrator(status: string, pr_url?: string): Promise<void> {
    try {
      await this.fetchFn(`${this.config.workerUrl}/api/internal/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": this.config.apiKey },
        body: JSON.stringify({ ticketUUID: this.config.ticketUUID, status, pr_url }),
      });
    } catch (err) {
      console.error("[Agent] Failed to update orchestrator status:", err);
    }
  }

  async updateLinear(status: string, ticketId: string): Promise<void> {
    if (!this.config.linearAppToken) return;

    const linearState = LINEAR_STATE_MAP[status] || "In Progress";
    try {
      const stateRes = await this.fetchFn("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.linearAppToken}` },
        body: JSON.stringify({
          query: `query($issueId: String!) { issue(id: $issueId) { team { states { nodes { id name } } } } }`,
          variables: { issueId: ticketId },
        }),
      });
      const stateData = (await stateRes.json()) as any;
      const states = stateData.data?.issue?.team?.states?.nodes || [];
      const targetState = states.find((s: any) => s.name === linearState);

      if (!targetState) {
        console.warn(`[Agent] Could not find Linear state "${linearState}" for ticket ${ticketId}`);
        return;
      }

      await this.fetchFn("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.linearAppToken}` },
        body: JSON.stringify({
          query: `mutation($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } }`,
          variables: { issueId: ticketId, stateId: targetState.id },
        }),
      });
      console.log(`[Agent] Updated Linear ticket ${ticketId} to ${linearState}`);
    } catch (err) {
      console.error("[Agent] Failed to update Linear ticket:", err);
    }
  }

  async updateSlackStatus(status: string): Promise<void> {
    if (!this.config.slackThreadTs) return;

    const display = STATUS_DISPLAY[status] || { emoji: "⏳", text: status.replace(/_/g, " ").toUpperCase() };
    const ticketId = this.config.ticketIdentifier || this.config.ticketUUID;
    let summary = this.config.ticketTitle || "Working on task";
    if (summary.length > 100) {
      const firstSentence = summary.match(/^[^.!?]+[.!?]/);
      summary = firstSentence ? firstSentence[0] : summary.slice(0, 100) + "...";
    }

    try {
      await this.fetchFn("https://slack.com/api/chat.update", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.slackBotToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.slackChannel,
          ts: this.config.slackThreadTs,
          text: `${display.emoji} ${display.text} - ${ticketId}: ${summary}`,
        }),
      });
    } catch (err) {
      console.error("[Agent] Failed to update Slack message:", err);
    }
  }

  /** Run all 3 updates in parallel. */
  async updateAll(status: string, opts?: { pr_url?: string; ticketId?: string }): Promise<void> {
    const ticketId = opts?.ticketId || this.config.ticketUUID;
    await Promise.all([
      this.updateOrchestrator(status, opts?.pr_url),
      this.updateLinear(status, ticketId),
      this.updateSlackStatus(status),
    ]);
  }
}
```

**Step 4: Run tests**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test src/status-updater.test.ts`

**Step 5: Commit**

```bash
git add agent/src/status-updater.ts agent/src/status-updater.test.ts
git commit -m "refactor: extract StatusUpdater from tools.ts update_task_status"
```

---

## Task 5: Wire New Modules into `server.ts` and `tools.ts`

**Files:**
- Modify: `agent/src/server.ts` (replace inline code with module calls)
- Modify: `agent/src/tools.ts` (replace 92-line update_task_status with StatusUpdater)

**Step 1: Update tools.ts to use StatusUpdater**

Replace the 92-line `update_task_status` handler (lines 170-312) with:

```typescript
import { StatusUpdater } from "./status-updater";

// Inside createTools():
const statusUpdater = new StatusUpdater({
  workerUrl: config.workerUrl,
  apiKey: config.apiKey,
  ticketUUID: config.ticketUUID,
  slackBotToken: config.slackBotToken,
  slackChannel: config.slackChannel,
  slackThreadTs: config.slackThreadTs,
  linearAppToken: config.linearAppToken,
  ticketIdentifier: config.ticketIdentifier,
  ticketTitle: config.ticketTitle,
});

const updateTaskStatus = tool(
  "update_task_status",
  "Update the task's status. Call this at every state transition.",
  {
    status: z.enum(["in_progress", "pr_open", "in_review", "needs_revision", "merged", "closed", "deferred", "failed", "asking"]),
    reason: z.string().optional(),
    pr_url: z.string().optional(),
    linear_ticket_id: z.string().optional(),
  },
  async ({ status, reason, pr_url, linear_ticket_id }) => {
    const ticketId = linear_ticket_id || config.ticketUUID;
    console.log(`[Agent] Status update: ${status}`, JSON.stringify({ reason, pr_url, ticketId }));
    // Update slackThreadTs reference in case it changed
    statusUpdater.config.slackThreadTs = config.slackThreadTs;
    await statusUpdater.updateAll(status, { pr_url, ticketId });
    return { content: [{ type: "text" as const, text: `Task status updated to ${status}` }] };
  },
);
```

**Step 2: Update server.ts to use TokenTracker and TranscriptManager**

Replace inline token tracking with:
```typescript
import { TokenTracker } from "./token-tracker";
import { TranscriptManager } from "./transcripts";
import { SlackEcho } from "./slack-echo";

const tokenTracker = new TokenTracker();
const transcriptMgr = new TranscriptManager({
  agentUuid,
  workerUrl: config.workerUrl,
  apiKey: config.apiKey,
  ticketUUID: config.ticketUUID,
});
```

**Step 3: Add Slack echo in SDK consumption loop**

In the `for await (const message of session)` loop, add echo calls:

```typescript
// After creating tools, before query():
const slackEcho = new SlackEcho({
  slackBotToken: config.slackBotToken,
  slackChannel: config.slackChannel,
  slackThreadTs: config.slackThreadTs,
  slackPersona: config.slackPersona,
});

// Inside the consumption loop:
if (message.type === "assistant" && message.message?.content) {
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.trim()) {
      slackEcho.echoAssistantText(block.text);  // fire-and-forget
    }
    if (block.type === "tool_use") {
      slackEcho.echoToolUse(block.name, block.input as Record<string, unknown>);
    }
  }
}
```

**Step 4: Run all agent tests**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add agent/src/server.ts agent/src/tools.ts
git commit -m "refactor: wire TokenTracker, TranscriptManager, SlackEcho, StatusUpdater into server.ts and tools.ts"
```

---

## Task 6: Final cleanup — remove dead code from server.ts

**Files:**
- Modify: `agent/src/server.ts` (remove now-extracted functions and variables)

Remove:
- `reportTokenUsage()` function (replaced by `tokenTracker.report()`)
- `getTranscriptDir()`, `findAllTranscripts()`, `uploadTranscripts()`, `uploadedSizes` (replaced by `transcriptMgr`)
- Token tracking variables (`totalInputTokens`, `totalOutputTokens`, etc., `turnUsageLog`)
- Inline token calculation in consumption loop (replaced by `tokenTracker.recordTurn()`)

**Step 1: Verify line count reduction**

Run: `wc -l agent/src/server.ts`
Expected: ~650 lines (down from 1026)

**Step 2: Run full test suite**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/agent && bun test`
Expected: All tests pass

**Step 3: Run API tests too**

Run: `cd /Users/bryanchan/dev/product-engineer/.claude/worktrees/adoring-goldwasser/api && bun test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add agent/src/server.ts
git commit -m "refactor: remove dead code from server.ts after module extraction"
```

---

## Summary of Changes

| File | Before | After | Delta |
|------|--------|-------|-------|
| `server.ts` | 1026 lines | ~650 lines | -376 |
| `tools.ts` | 645 lines | ~570 lines | -75 |
| `token-tracker.ts` | (new) | ~120 lines | +120 |
| `transcripts.ts` | (new) | ~80 lines | +80 |
| `slack-echo.ts` | (new) | ~120 lines | +120 |
| `status-updater.ts` | (new) | ~100 lines | +100 |
| Tests | (new) | ~200 lines | +200 |

**Net effect:** server.ts shrinks by ~35%, tools.ts shrinks by ~12%. Each new module is <120 lines with a single responsibility. Slack echo adds zero-token observability. All logic-heavy code is independently testable.
