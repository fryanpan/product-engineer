/**
 * Merge gate logic for the ticket agent.
 *
 * Agents manage their own PR lifecycle: checking CI status and merging PRs
 * directly, rather than delegating to the orchestrator's LLM-based merge gate.
 *
 * Uses commit statuses API first, then falls back to the PR's mergeable_state
 * to handle repos that use GitHub Actions check runs. Fine-grained PATs don't
 * have the "Checks" permission, so we can't query check-runs directly.
 */

export interface MergeGateResult {
  ready: boolean;
  reason: string;
  ciStatus: "pending" | "passing" | "failing" | "none";
  retryAfterMs?: number;
}

export interface MergeResult {
  merged: boolean;
  error?: string;
}

/** Parse owner, repo, and PR number from a GitHub PR URL. */
export function parsePRUrl(prUrl: string): { owner: string; repo: string; prNumber: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], prNumber: match[3] };
}

/**
 * Check CI status for a PR by fetching the combined commit status for the head SHA.
 *
 * Flow:
 * 1. Fetch PR details to get head SHA
 * 2. Fetch combined commit status for that SHA
 * 3. Return result with ciStatus and readiness
 */
export async function checkCIStatus(
  prUrl: string,
  githubToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<MergeGateResult> {
  const parsed = parsePRUrl(prUrl);
  if (!parsed) {
    return { ready: false, reason: `Invalid PR URL: ${prUrl}`, ciStatus: "none" };
  }

  const { owner, repo, prNumber } = parsed;
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "product-engineer-agent",
  };

  // Step 1: Get PR head SHA
  const prRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
  if (!prRes.ok) {
    return { ready: false, reason: `Failed to fetch PR: ${prRes.status}`, ciStatus: "none" };
  }

  const prData = await prRes.json() as { head: { sha: string }; mergeable: boolean | null; mergeable_state: string };
  const headSha = prData.head.sha;

  // Step 2: Fetch combined commit status via statuses API (NOT check-runs)
  const statusRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`, { headers });
  if (!statusRes.ok) {
    return { ready: false, reason: `Failed to fetch commit status: ${statusRes.status}`, ciStatus: "none" };
  }

  const statusData = await statusRes.json() as {
    state: string;
    total_count: number;
    statuses: Array<{ context: string; state: string; description: string | null }>;
  };

  // Check commit statuses (covers repos that report via status API)
  if (statusData.total_count > 0) {
    if (statusData.state === "pending") {
      return {
        ready: false,
        reason: "CI is still running",
        ciStatus: "pending",
        retryAfterMs: 60_000, // Retry in 60 seconds
      };
    }

    if (statusData.state === "failure" || statusData.state === "error") {
      const failed = statusData.statuses
        .filter(s => s.state === "failure" || s.state === "error")
        .map(f => `${f.context}: ${f.state}`)
        .join(", ");
      return { ready: false, reason: `CI failed: ${failed}`, ciStatus: "failing" };
    }

    // state === "success"
    return { ready: true, reason: "All CI checks passed", ciStatus: "passing" };
  }

  // No commit statuses — repo may use GitHub Actions check runs instead.
  // Fall back to the PR's mergeable_state which reflects all required checks
  // (both statuses and check runs) without needing the check-runs API.
  // Note: fine-grained PATs don't have "Checks" permission, so we can't query
  // check-runs directly. The mergeable_state is set by GitHub after evaluating
  // branch protection rules including required checks.
  if (prData.mergeable === null) {
    // GitHub hasn't computed mergeability yet — retry shortly
    return { ready: false, reason: "GitHub is computing mergeability — retry shortly", ciStatus: "pending", retryAfterMs: 15_000 };
  }

  if (prData.mergeable_state === "clean") {
    return { ready: true, reason: "All required checks passed (via mergeable_state)", ciStatus: "passing" };
  }

  if (prData.mergeable_state === "blocked") {
    return { ready: false, reason: "Required checks pending or failing", ciStatus: "pending", retryAfterMs: 60_000 };
  }

  if (prData.mergeable_state === "unstable") {
    return { ready: false, reason: "Some checks failed (non-blocking)", ciStatus: "failing" };
  }

  // No CI statuses and no blocking merge state — no CI configured
  return { ready: true, reason: "No CI configured — ready to merge", ciStatus: "none" };
}

/**
 * Merge a PR via GitHub API using squash merge.
 */
export async function mergePR(
  prUrl: string,
  githubToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<MergeResult> {
  const parsed = parsePRUrl(prUrl);
  if (!parsed) {
    return { merged: false, error: `Invalid PR URL: ${prUrl}` };
  }

  const { owner, repo, prNumber } = parsed;

  const mergeRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "product-engineer-agent",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ merge_method: "squash" }),
  });

  if (mergeRes.ok) {
    return { merged: true };
  }

  const errorText = await mergeRes.text();

  if (mergeRes.status === 405 || mergeRes.status === 409) {
    return { merged: false, error: `Merge conflict or branch not mergeable: ${errorText}` };
  }

  return { merged: false, error: `GitHub API error ${mergeRes.status}: ${errorText}` };
}
