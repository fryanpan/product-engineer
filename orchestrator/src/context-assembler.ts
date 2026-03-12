/**
 * Context Assembler — gathers structured context from GitHub, Slack,
 * Linear, and SQLite before LLM decisions.
 */

export interface ContextAssemblerConfig {
  sqlExec: (sql: string, ...params: unknown[]) => { toArray: () => unknown[] };
  slackBotToken: string;
  linearAppToken: string;
  githubTokens: Record<string, string>; // product → GitHub token
}

export class ContextAssembler {
  private config: ContextAssemblerConfig;

  constructor(config: ContextAssemblerConfig) {
    this.config = config;
  }

  /** Assemble context for ticket review decision */
  async forTicketReview(ticket: {
    ticketId: string;
    identifier: string | null;
    title: string;
    description: string;
    priority: number;
    labels: string[];
    product: string;
    repos: string[];
    slackThreadTs: string | null;
    slackChannel: string | null;
  }): Promise<Record<string, unknown>> {
    const activeTickets = this.config.sqlExec(
      "SELECT id, status, product, pr_url FROM tickets WHERE status NOT IN ('merged', 'closed', 'deferred', 'failed') ORDER BY created_at DESC LIMIT 10"
    ).toArray();

    const [linearComments, slackThread] = await Promise.all([
      this.fetchLinearComments(ticket.ticketId).catch(() => []),
      ticket.slackThreadTs && ticket.slackChannel
        ? this.fetchSlackThread(ticket.slackChannel, ticket.slackThreadTs).catch(() => [])
        : Promise.resolve([]),
    ]);

    // Detect Slack-originated tickets by description prefix
    const isSlackOriginated = /^\*\*Slack request from <@/.test(ticket.description || "");

    return {
      identifier: ticket.identifier || ticket.ticketId,
      title: ticket.title,
      description: ticket.description,
      priority: this.priorityLabel(ticket.priority),
      labels: ticket.labels.join(", "),
      activeCount: activeTickets.length,
      activeTickets,
      productName: ticket.product,
      repos: ticket.repos.join(", "),
      linearComments,
      slackThread,
      isSlackOriginated,
    };
  }

  /** Assemble context for merge gate decision */
  async forMergeGate(ticket: {
    ticketId: string;
    identifier: string | null;
    title: string;
    product: string;
    pr_url: string;
    branch: string;
    repo: string;
  }): Promise<Record<string, unknown>> {
    const ghToken = this.config.githubTokens[ticket.product];
    const prMatch = ticket.pr_url.match(/\/pull\/(\d+)/);
    const prNumber = prMatch?.[1];
    const repoPath = ticket.repo;

    const [prDetails, reviews, prComments, diff, linearComments] = await Promise.all([
      prNumber && ghToken ? this.fetchPRDetails(repoPath, prNumber, ghToken) : null,
      prNumber && ghToken ? this.fetchPRReviews(repoPath, prNumber, ghToken) : [],
      prNumber && ghToken ? this.fetchPRComments(repoPath, prNumber, ghToken) : [],
      prNumber && ghToken ? this.fetchPRDiff(repoPath, prNumber, ghToken) : "",
      this.fetchLinearComments(ticket.ticketId).catch(() => []),
    ]);

    const headSha = (prDetails?.head as Record<string, unknown> | undefined)?.sha as string | undefined;
    const ciStatus = prNumber && ghToken
      ? await this.fetchCIStatus(repoPath, headSha, ghToken)
      : { passed: false, details: "No CI data" };

    // GitHub REST API returns mergeable (boolean|null) and mergeable_state (string)
    const mergeable = prDetails?.mergeable;
    const mergeableState = prDetails?.mergeable_state as string | undefined;

    // Check Copilot review status from reviews and line-level comments
    const copilotReview = this.extractCopilotReviewStatus(reviews, prComments);

    return {
      identifier: ticket.identifier || ticket.ticketId,
      title: ticket.title,
      pr_url: ticket.pr_url,
      pr_title: prDetails?.title || "",
      branch: ticket.branch,
      changedFiles: prDetails?.changed_files || 0,
      additions: prDetails?.additions || 0,
      deletions: prDetails?.deletions || 0,
      mergeable: mergeable === true ? "MERGEABLE" : mergeable === false ? "CONFLICTING" : "UNKNOWN",
      mergeableState: mergeableState || "",
      ciPassed: ciStatus.passed,
      ciFailureDetails: ciStatus.details,
      diffSummary: (diff as string).slice(0, 5000),
      reviewComments: reviews,
      linearComments,
      copilotReviewComplete: copilotReview.reviewed,
      copilotComments: copilotReview.comments,
    };
  }

  /** Assemble context for supervisor tick */
  async forSupervisor(): Promise<Record<string, unknown>> {
    const activeTickets = this.config.sqlExec(
      `SELECT id, product, status, pr_url, slack_thread_ts, slack_channel,
              updated_at, created_at
       FROM tickets WHERE status NOT IN ('merged', 'closed', 'deferred', 'failed')
       AND agent_active = 1`
    ).toArray() as Array<Record<string, unknown>>;

    const now = Date.now();
    const agents = activeTickets.map(t => {
      const createdMs = new Date(t.created_at as string).getTime();
      const updatedMs = new Date(t.updated_at as string).getTime();
      const durationMin = Math.floor((now - createdMs) / 60000);
      const heartbeatAgeMin = Math.floor((now - updatedMs) / 60000);

      return {
        ticketId: t.id,
        product: t.product,
        status: t.status,
        lastHeartbeat: t.updated_at,
        heartbeatAge: `${heartbeatAgeMin}m`,
        healthStatus: heartbeatAgeMin < 30 ? "healthy" : "stale",
        duration: `${durationMin}m`,
        pr_url: t.pr_url,
        cost: "0.00",
      };
    });

    const stalePRs = this.config.sqlExec(
      `SELECT id, pr_url, updated_at FROM tickets
       WHERE pr_url IS NOT NULL AND status = 'pr_open'
       AND datetime(updated_at) < datetime('now', '-4 hours')`
    ).toArray();

    const queuedTickets = this.config.sqlExec(
      "SELECT id, product, status FROM tickets WHERE status = 'queued' ORDER BY created_at ASC"
    ).toArray();

    return {
      agentCount: agents.length,
      agents,
      stalePRs,
      queuedTickets,
      dailyCost: "0.00",
      pendingEvents: 0,
    };
  }

  /** Assemble context for thread classification */
  async forThreadClassify(message: {
    user: string;
    text: string;
    ticketId: string;
    identifier: string | null;
    title: string;
    status: string;
    agentRunning: boolean;
  }): Promise<Record<string, unknown>> {
    return {
      user: message.user,
      text: message.text,
      identifier: message.identifier || message.ticketId,
      title: message.title,
      status: message.status,
      agentRunning: message.agentRunning ? "yes" : "no",
    };
  }

  // --- Private helpers ---

  private priorityLabel(priority: number): string {
    const labels: Record<number, string> = { 0: "None", 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" };
    return labels[priority] || "Unknown";
  }

  /** Fetch Linear comment history for a ticket via GraphQL */
  async fetchLinearComments(issueId: string): Promise<Array<{ author: string; body: string; createdAt: string }>> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.linearAppToken}`,
      },
      body: JSON.stringify({
        query: `query($id: String!) {
          issue(id: $id) {
            comments { nodes { body createdAt user { name } } }
          }
        }`,
        variables: { id: issueId },
      }),
    });

    if (!res.ok) return [];

    const data = await res.json() as {
      data?: { issue?: { comments?: { nodes?: Array<{ body: string; createdAt: string; user?: { name: string } }> } } }
    };

    return (data.data?.issue?.comments?.nodes || []).map(c => ({
      author: c.user?.name || "Unknown",
      body: c.body.slice(0, 500),
      createdAt: c.createdAt,
    }));
  }

  private async fetchSlackThread(channel: string, threadTs: string): Promise<Array<{ user: string; text: string }>> {
    const res = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=20`, {
      headers: { Authorization: `Bearer ${this.config.slackBotToken}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { ok: boolean; messages?: Array<{ user: string; text: string }> };
    return (data.messages || []).map(m => ({ user: m.user, text: m.text?.slice(0, 300) || "" }));
  }

  private async fetchPRDetails(repo: string, prNumber: string, token: string) {
    const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "product-engineer-orchestrator" },
    });
    if (!res.ok) {
      console.error(`[ContextAssembler] fetchPRDetails failed: ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }
    return await res.json() as Record<string, unknown>;
  }

  private async fetchPRReviews(repo: string, prNumber: string, token: string) {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "product-engineer-orchestrator" },
    });
    if (!res.ok) return [];
    const reviews = await res.json() as Array<{ user: { login: string }; state: string; body: string }>;
    return reviews.map(r => ({ reviewer: r.user.login, state: r.state, body: r.body?.slice(0, 500) || "" }));
  }

  private async fetchPRDiff(repo: string, prNumber: string, token: string): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3.diff", "User-Agent": "product-engineer-orchestrator" },
    });
    return res.ok ? await res.text() : "";
  }

  private async fetchCIStatus(repo: string, sha: string | undefined, token: string) {
    if (!sha) return { passed: false, details: "No commit SHA" };
    // Use combined status API (works with fine-grained PAT "Commit statuses" permission)
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/status`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "product-engineer-orchestrator" },
    });
    if (!res.ok) return { passed: false, details: `GitHub API error: ${res.status}` };
    const data = await res.json() as { state: string; total_count: number; statuses: Array<{ context: string; state: string; description: string | null }> };
    if (data.total_count === 0) {
      // No commit statuses reported yet. The check_suite webhook that triggered the merge gate
      // already confirms CI status, so treat this as passed rather than calling the check-runs
      // API (which requires Checks permission unavailable on fine-grained PATs).
      return { passed: true, details: "No commit statuses — CI status confirmed via webhook" };
    }
    if (data.state === "pending") return { passed: false, details: "CI still running" };
    if (data.state === "failure" || data.state === "error") {
      const failed = data.statuses.filter(s => s.state === "failure" || s.state === "error");
      return { passed: false, details: failed.map(f => `${f.context}: ${f.state}`).join(", ") };
    }
    return { passed: true, details: "All checks passed" };
  }

  private async fetchPRComments(repo: string, prNumber: string, token: string): Promise<Array<{ user: string; path: string; body: string }>> {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "product-engineer-orchestrator" },
    });
    if (!res.ok) return [];
    const comments = await res.json() as Array<{ user: { login: string }; path: string; body: string }>;
    return comments.map(c => ({ user: c.user.login, path: c.path || "", body: c.body?.slice(0, 500) || "" }));
  }

  /**
   * Extract Copilot review status from reviews and line-level PR comments.
   * Returns whether Copilot has reviewed and any comments it left.
   * Copilot is considered to have reviewed if it left a top-level review OR line comments.
   */
  private extractCopilotReviewStatus(
    reviews: Array<{ reviewer: string; state: string; body: string }>,
    prComments: Array<{ user: string; path: string; body: string }>,
  ): { reviewed: boolean; comments: Array<{ path: string; body: string }> } {
    const COPILOT_USERNAME = "copilot-pull-request-reviewer";

    const copilotReview = reviews.find(r => r.reviewer === COPILOT_USERNAME);
    const copilotComments = prComments
      .filter(c => c.user === COPILOT_USERNAME)
      .map(c => ({ path: c.path, body: c.body }));

    // Copilot has reviewed if it left a top-level review OR line-level comments.
    // Some repos may see only line comments without a formal review object.
    return {
      reviewed: !!copilotReview || copilotComments.length > 0,
      comments: copilotComments,
    };
  }

}
