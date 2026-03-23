import { describe, test, expect, mock } from "bun:test";
import { checkCIStatus, mergePR, parsePRUrl } from "./merge-gate";

const PR_URL = "https://github.com/acme-org/my-app/pull/42";

function mockFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let callIndex = 0;
  return mock(() => {
    const response = responses[callIndex++];
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    } as Response);
  });
}

describe("parsePRUrl", () => {
  test("parses a standard GitHub PR URL", () => {
    const result = parsePRUrl("https://github.com/acme-org/my-app/pull/42");
    expect(result).toEqual({ owner: "acme-org", repo: "my-app", prNumber: "42" });
  });

  test("returns null for invalid URL", () => {
    expect(parsePRUrl("https://example.com/foo")).toBeNull();
    expect(parsePRUrl("not-a-url")).toBeNull();
  });
});

describe("checkCIStatus", () => {
  test("returns passing when all checks succeed", async () => {
    const fetch = mockFetch([
      // PR details
      { ok: true, status: 200, body: { head: { sha: "abc123" }, mergeable: true, mergeable_state: "clean" } },
      // Commit status
      { ok: true, status: 200, body: { state: "success", total_count: 2, statuses: [
        { context: "ci/test", state: "success", description: "Tests passed" },
        { context: "ci/lint", state: "success", description: "Lint passed" },
      ] } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(true);
    expect(result.ciStatus).toBe("passing");
    expect(result.reason).toContain("passed");
  });

  test("returns pending when CI is still running", async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { head: { sha: "abc123" }, mergeable: true, mergeable_state: "unstable" } },
      { ok: true, status: 200, body: { state: "pending", total_count: 1, statuses: [
        { context: "ci/test", state: "pending", description: "Running..." },
      ] } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(false);
    expect(result.ciStatus).toBe("pending");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("returns failing when CI fails", async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { head: { sha: "abc123" }, mergeable: true, mergeable_state: "unstable" } },
      { ok: true, status: 200, body: { state: "failure", total_count: 2, statuses: [
        { context: "ci/test", state: "failure", description: "Tests failed" },
        { context: "ci/lint", state: "success", description: "Lint passed" },
      ] } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(false);
    expect(result.ciStatus).toBe("failing");
    expect(result.reason).toContain("ci/test");
  });

  test("falls back to mergeable_state when no commit statuses (checks-only CI)", async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { head: { sha: "abc123" }, mergeable: true, mergeable_state: "clean" } },
      { ok: true, status: 200, body: { state: "pending", total_count: 0, statuses: [] } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(true);
    expect(result.ciStatus).toBe("passing");
  });

  test("returns pending when no commit statuses and mergeable_state is blocked", async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { head: { sha: "abc123" }, mergeable: true, mergeable_state: "blocked" } },
      { ok: true, status: 200, body: { state: "pending", total_count: 0, statuses: [] } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(false);
    expect(result.ciStatus).toBe("pending");
  });

  test("retries when mergeable is null (GitHub still computing)", async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { head: { sha: "abc123" }, mergeable: null, mergeable_state: "unknown" } },
      { ok: true, status: 200, body: { state: "pending", total_count: 0, statuses: [] } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(false);
    expect(result.ciStatus).toBe("pending");
    expect(result.retryAfterMs).toBe(15_000);
  });

  test("handles invalid PR URL", async () => {
    const result = await checkCIStatus("https://invalid.com/foo", "gh-token");
    expect(result.ready).toBe(false);
    expect(result.ciStatus).toBe("none");
  });

  test("handles PR fetch failure", async () => {
    const fetch = mockFetch([
      { ok: false, status: 404, body: { message: "Not Found" } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("404");
  });

  test("handles commit status fetch failure", async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { head: { sha: "abc123" }, mergeable: true, mergeable_state: "clean" } },
      { ok: false, status: 401, body: { message: "Bad credentials" } },
    ]);

    const result = await checkCIStatus(PR_URL, "gh-token", fetch as any);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("401");
  });
});

describe("mergePR", () => {
  test("merges successfully", async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { sha: "merged123", merged: true } },
    ]);

    const result = await mergePR(PR_URL, "gh-token", fetch as any);
    expect(result.merged).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("handles merge conflict (409)", async () => {
    const fetch = mockFetch([
      { ok: false, status: 409, body: "Merge conflict" },
    ]);

    const result = await mergePR(PR_URL, "gh-token", fetch as any);
    expect(result.merged).toBe(false);
    expect(result.error).toContain("conflict");
  });

  test("handles not mergeable (405)", async () => {
    const fetch = mockFetch([
      { ok: false, status: 405, body: "Not allowed" },
    ]);

    const result = await mergePR(PR_URL, "gh-token", fetch as any);
    expect(result.merged).toBe(false);
    expect(result.error).toContain("not mergeable");
  });

  test("handles generic API error", async () => {
    const fetch = mockFetch([
      { ok: false, status: 500, body: "Internal Server Error" },
    ]);

    const result = await mergePR(PR_URL, "gh-token", fetch as any);
    expect(result.merged).toBe(false);
    expect(result.error).toContain("500");
  });

  test("handles invalid PR URL", async () => {
    const result = await mergePR("not-a-url", "gh-token");
    expect(result.merged).toBe(false);
    expect(result.error).toContain("Invalid PR URL");
  });
});
