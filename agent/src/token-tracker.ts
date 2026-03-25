/**
 * TokenTracker — tracks per-turn token usage, calculates costs, and reports summaries.
 *
 * Sonnet 4.6 pricing:
 *   Input:          $3.00  / MTok
 *   Output:         $15.00 / MTok
 *   Cache read:     $0.30  / MTok
 *   Cache creation: $3.00  / MTok
 */

// ── Pricing constants (per token) ──────────────────────────────────────────
const INPUT_COST_PER_TOKEN = 3.0 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15.0 / 1_000_000;
const CACHE_READ_COST_PER_TOKEN = 0.3 / 1_000_000;
const CACHE_CREATION_COST_PER_TOKEN = 3.0 / 1_000_000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface TurnUsage {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  model?: string;
  promptSnippet?: string;
  outputSnippet?: string;
}

export interface TokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  turns: number;
  model?: string;
  turnLog: TurnUsage[];
}

export interface ReportOptions {
  taskUUID: string;
  workerUrl: string;
  apiKey: string;
  slackBotToken: string;
  slackChannel: string;
  slackThreadTs?: string;
  sessionMessageCount?: number;
  model?: string;
}

// ── Implementation ─────────────────────────────────────────────────────────

export class TokenTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheCreationTokens = 0;
  private totalCostUsd = 0;
  private turnLog: TurnUsage[] = [];
  private model?: string;

  /** Record a single assistant turn's token usage. */
  recordTurn(input: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    model?: string;
    promptSnippet?: string;
    outputSnippet?: string;
  }): void {
    const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = input;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCacheReadTokens += cacheReadTokens;
    this.totalCacheCreationTokens += cacheCreationTokens;

    // Store model from first turn (all turns in a session use the same model)
    if (!this.model && input.model) {
      this.model = input.model;
    }

    const turnCost =
      inputTokens * INPUT_COST_PER_TOKEN +
      outputTokens * OUTPUT_COST_PER_TOKEN +
      cacheReadTokens * CACHE_READ_COST_PER_TOKEN +
      cacheCreationTokens * CACHE_CREATION_COST_PER_TOKEN;

    this.totalCostUsd += turnCost;

    this.turnLog.push({
      turn: this.turnLog.length + 1,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd: turnCost,
      model: input.model,
      promptSnippet: input.promptSnippet,
      outputSnippet: input.outputSnippet,
    });

    console.log(
      `[Agent] Turn ${this.turnLog.length} usage: ${inputTokens} in / ${outputTokens} out / $${turnCost.toFixed(4)}`,
    );
  }

  /** Override the calculated total cost with the SDK-provided final cost. */
  overrideCost(costUsd: number): void {
    this.totalCostUsd = costUsd;
    console.log(`[Agent] Final cost from SDK: $${costUsd.toFixed(2)}`);
  }

  /** Reset all tracking state (used by project leads between sessions). */
  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
    this.totalCostUsd = 0;
    this.turnLog = [];
    this.model = undefined;
  }

  /** Return a snapshot of current totals and per-turn log. */
  getSummary(): TokenSummary {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheCreationTokens: this.totalCacheCreationTokens,
      totalCostUsd: this.totalCostUsd,
      turns: this.turnLog.length,
      model: this.model,
      turnLog: [...this.turnLog],
    };
  }

  /** Format a Slack-friendly usage summary message. */
  formatSlackSummary(): string {
    const formattedCost = this.totalCostUsd.toFixed(2);
    const formattedInputTokens = (this.totalInputTokens / 1000).toFixed(1);
    const formattedOutputTokens = (this.totalOutputTokens / 1000).toFixed(1);

    let msg = `📊 **Token Usage Summary**\n\n`;
    if (this.model) {
      msg += `**Model:** ${this.model}\n`;
    }
    msg += `**Total Cost:** $${formattedCost}\n`;
    msg += `**Input:** ${formattedInputTokens}K tokens ($${(this.totalInputTokens * INPUT_COST_PER_TOKEN).toFixed(2)})\n`;
    msg += `**Output:** ${formattedOutputTokens}K tokens ($${(this.totalOutputTokens * OUTPUT_COST_PER_TOKEN).toFixed(2)})\n`;

    if (this.totalCacheReadTokens > 0) {
      msg += `**Cache Read:** ${(this.totalCacheReadTokens / 1000).toFixed(1)}K tokens ($${(this.totalCacheReadTokens * CACHE_READ_COST_PER_TOKEN).toFixed(2)})\n`;
    }
    if (this.totalCacheCreationTokens > 0) {
      msg += `**Cache Creation:** ${(this.totalCacheCreationTokens / 1000).toFixed(1)}K tokens ($${(this.totalCacheCreationTokens * CACHE_CREATION_COST_PER_TOKEN).toFixed(2)})\n`;
    }

    msg += `**Conversation Turns:** ${this.turnLog.length}\n\n`;

    // Top 3 most expensive turns
    const topTurns = [...this.turnLog]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 3);

    if (topTurns.length > 0) {
      msg += `**Most Expensive Turns:**\n`;
      for (const turn of topTurns) {
        msg += `• Turn ${turn.turn}: $${turn.costUsd.toFixed(4)} (${turn.inputTokens} in / ${turn.outputTokens} out)\n`;
        if (turn.promptSnippet) {
          msg += `  Prompt: "${turn.promptSnippet}${turn.promptSnippet.length >= 100 ? "..." : ""}"\n`;
        }
        if (turn.outputSnippet) {
          msg += `  Output: "${turn.outputSnippet}${turn.outputSnippet.length >= 100 ? "..." : ""}"\n`;
        }
      }
    }

    return msg;
  }

  /** Report token usage to the orchestrator API and post a summary to Slack. */
  async report(options: ReportOptions): Promise<void> {
    try {
      const summary = this.getSummary();

      console.log(
        `[Agent] Reporting token usage: ${summary.totalInputTokens} in / ${summary.totalOutputTokens} out / $${summary.totalCostUsd.toFixed(2)}`,
      );

      // Post to orchestrator API
      const usagePayload = {
        taskUUID: options.taskUUID,
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
        totalCacheReadTokens: summary.totalCacheReadTokens,
        totalCacheCreationTokens: summary.totalCacheCreationTokens,
        totalCostUsd: summary.totalCostUsd,
        turns: summary.turns,
        sessionMessageCount: options.sessionMessageCount ?? summary.turns,
        model: options.model ?? summary.model,
      };

      const apiRes = await fetch(`${options.workerUrl}/api/internal/token-usage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": options.apiKey,
        },
        body: JSON.stringify(usagePayload),
      });

      if (!apiRes.ok) {
        console.error(`[Agent] Failed to report token usage: ${apiRes.status}`);
      } else {
        console.log("[Agent] Token usage reported successfully");
      }

      // Post summary to Slack
      const slackMessage = this.formatSlackSummary();

      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: options.slackChannel,
          text: slackMessage,
          ...(options.slackThreadTs && { thread_ts: options.slackThreadTs }),
        }),
      });

      console.log("[Agent] Token usage posted to Slack");
    } catch (err) {
      console.error("[Agent] Failed to report token usage:", err);
    }
  }
}
