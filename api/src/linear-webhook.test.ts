import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { linearWebhook } from "./webhooks";
import type { Bindings } from "./types";
import { createMockConductorStub, TEST_REGISTRY, type MockRegistryData } from "./test-helpers";
import { clearRegistryCache } from "./registry";

// Mock conductor DO that captures events sent to it AND serves registry data
let sentEvents: unknown[] = [];

function createMockConductorWithEvents(registryData: MockRegistryData) {
  const baseStub = createMockConductorStub(registryData);

  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);

      // Handle event forwarding
      if (url.pathname === "/event") {
        const body = await req.json();
        sentEvents.push(body);
        return Response.json({ ok: true });
      }

      // Delegate to base stub for registry lookups
      return baseStub.fetch(req);
    },
  } as unknown as DurableObjectStub;
}

let mockConductorStub: DurableObjectStub;

const mockConductorNamespace = {
  idFromName: (_name: string) => "mock-id",
  get: (_id: unknown) => mockConductorStub,
};

function makeApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route("/", linearWebhook);
  return app;
}

const TEST_WEBHOOK_SECRET = "test-linear-webhook-secret";

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    CONDUCTOR: mockConductorNamespace as unknown as DurableObjectNamespace,
    TASK_AGENT: {} as unknown as DurableObjectNamespace,
    API_KEY: "test",
    SLACK_BOT_TOKEN: "test",
    SLACK_APP_TOKEN: "test",
    SLACK_SIGNING_SECRET: "test",
    LINEAR_APP_TOKEN: "test",
    LINEAR_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    GITHUB_WEBHOOK_SECRET: "test",
    ANTHROPIC_API_KEY: "test",
    HEALTH_TOOL_GITHUB_TOKEN: "test",
    BIKE_TOOL_GITHUB_TOKEN: "test",
    PRODUCT_ENGINEER_GITHUB_TOKEN: "test",
    ...overrides,
  };
}

async function hmacSign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postWebhook(app: ReturnType<typeof makeApp>, body: unknown, env: Bindings) {
  const rawBody = JSON.stringify(body);
  const signature = await hmacSign(rawBody, env.LINEAR_WEBHOOK_SECRET);
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": signature,
      },
      body: rawBody,
    },
    env,
  );
}

// Mock global fetch for Linear GraphQL comment fetching
let originalFetch: typeof globalThis.fetch;
let fetchSpy: ReturnType<typeof spyOn>;

describe("linear webhook handler", () => {
  beforeEach(() => {
    sentEvents = [];
    clearRegistryCache();
    mockConductorStub = createMockConductorWithEvents(TEST_REGISTRY);

    // Intercept fetch calls to Linear GraphQL API to prevent real HTTP calls
    originalFetch = globalThis.fetch;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url === "https://api.linear.app/graphql" && init?.body) {
        const body = JSON.parse(init.body as string);
        // Mock comment query responses
        if (body.query?.includes("comments")) {
          return Response.json({
            data: {
              issue: {
                comments: {
                  nodes: [
                    { body: "First comment", user: { name: "Alice" }, createdAt: "2026-03-01T10:00:00.000Z" },
                    { body: "Second comment", user: null, createdAt: "2026-03-01T11:00:00.000Z" },
                  ],
                },
              },
            },
          });
        }
      }
      // Pass through other fetch calls
      return originalFetch(input as RequestInfo, init);
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("ignores non-Issue/non-Comment events", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Project",
      data: {
        id: "p1",
        title: "test",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect(sentEvents).toHaveLength(0);
  });

  it("ignores comments from the agent itself", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-1",
        body: "Agent posted this",
        issue: { id: "issue-100", identifier: "PE-1", title: "Test issue" },
        user: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("our own comment");
    expect(sentEvents).toHaveLength(0);
  });

  it("ignores comments on untracked tickets", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-2",
        body: "A user comment",
        issue: { id: "untracked-issue", identifier: "PE-99", title: "Untracked" },
        user: { name: "Some User", email: "user@example.com" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("task not tracked");
    expect(sentEvents).toHaveLength(0);
  });

  it("forwards comments on tracked tickets", async () => {
    // Override the mock to handle ticket-status requests
    mockConductorStub = {
      fetch: async (req: Request) => {
        const url = new URL(req.url);

        if (url.pathname === "/event") {
          const body = await req.json();
          sentEvents.push(body);
          return Response.json({ ok: true });
        }

        if (url.pathname.startsWith("/ticket-status/")) {
          const ticketId = decodeURIComponent(url.pathname.slice("/ticket-status/".length));
          if (ticketId === "tracked-issue") {
            return Response.json({ status: "in_progress", product: "test-app", agent_active: 1 });
          }
          return Response.json({ error: "not found" }, { status: 404 });
        }

        // Delegate to base stub for registry lookups
        const baseStub = createMockConductorWithEvents(TEST_REGISTRY);
        return baseStub.fetch(req);
      },
    } as unknown as DurableObjectStub;

    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-3",
        body: "Please also fix the footer",
        issue: { id: "tracked-issue", identifier: "PE-10", title: "Fix the header" },
        user: { name: "Bryan", email: "bryan@example.com" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.taskUUID).toBe("tracked-issue");

    expect(sentEvents).toHaveLength(1);
    const event = sentEvents[0] as Record<string, unknown>;
    expect(event.type).toBe("linear_comment");
    expect(event.source).toBe("linear");
    expect(event.taskUUID).toBe("tracked-issue");
    expect(event.product).toBe("test-app");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.comment_id).toBe("comment-3");
    expect(payload.body).toBe("Please also fix the footer");
    expect(payload.author).toBe("Bryan");
    expect(payload.issue_identifier).toBe("PE-10");
  });

  it("ignores issues from unknown teams", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Issue",
      data: {
        id: "i1",
        title: "test",
        description: "",
        priority: 1,
        teamId: "unknown-team-id",
        project: { id: "p1", name: "Test App" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect((json as Record<string, unknown>).reason).toBe("not our team");
    expect(sentEvents).toHaveLength(0);
  });

  it("ignores issues without a project", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Issue",
      data: {
        id: "i2",
        title: "test",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        // no project field
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect((json as Record<string, unknown>).reason).toContain("no project");
    expect(sentEvents).toHaveLength(0);
  });

  it("ignores issues created without agent assignment", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-123",
        identifier: "HT-42",
        title: "Fix the login bug",
        description: "Users cannot log in",
        priority: 2,
        teamId: TEST_REGISTRY.linear_team_id,
        labelIds: ["label-a"],
        project: { id: "p1", name: "Test App" },
        // No assignee - should be ignored
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);
  });

  it("forwards event when created with agent assignment", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-124",
        identifier: "HT-43",
        title: "Another issue",
        description: "Test with assignment on create",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        labelIds: [],
        project: { id: "p1", name: "Test App" },
        assignee: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.product).toBe("test-app");

    expect(sentEvents).toHaveLength(1);
    const event = sentEvents[0] as Record<string, unknown>;
    expect(event.type).toBe("task_created");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.id).toBe("issue-124");
    expect(payload.title).toBe("Another issue");
    expect(payload.identifier).toBe("HT-43");
  });

  it("forwards event when identifier is missing", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-125",
        // No identifier field - testing optional field
        title: "Issue without identifier",
        description: "Test handling of missing identifier",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        labelIds: [],
        project: { id: "p1", name: "Test App" },
        assignee: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.product).toBe("test-app");

    expect(sentEvents).toHaveLength(1);
    const event = sentEvents[0] as Record<string, unknown>;
    expect(event.type).toBe("task_created");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.id).toBe("issue-125");
    expect(payload.title).toBe("Issue without identifier");
    // identifier should be undefined when not present in webhook
    expect(payload.identifier).toBeUndefined();
  });

  it("ignores non-create/update actions even with agent assignment", async () => {
    const app = makeApp();
    const env = makeEnv();

    // "remove" action should be ignored even if assigned to agent
    const res = await postWebhook(app, {
      action: "remove",
      type: "Issue",
      data: {
        id: "issue-126",
        title: "Removed issue",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        assignee: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);
  });

  it("ignores status changes that aren't agent assignment", async () => {
    const app = makeApp();
    const env = makeEnv();

    // "update" with state "In Progress" (no assignment) should be ignored
    const res1 = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-200",
        title: "Progress issue",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        state: { name: "In Progress" },
      },
    }, env);

    expect(res1.status).toBe(200);
    const json1 = await res1.json() as Record<string, unknown>;
    expect(json1.ignored).toBe(true);
    expect(json1.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);

    // "update" with state "Done" should be ignored
    const res2 = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-201",
        title: "Done issue",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        state: { name: "Done" },
      },
    }, env);

    expect(res2.status).toBe(200);
    const json2 = await res2.json() as Record<string, unknown>;
    expect(json2.ignored).toBe(true);
    expect(json2.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);

    // "remove" action should be ignored
    const res3 = await postWebhook(app, {
      action: "remove",
      type: "Issue",
      data: {
        id: "issue-202",
        title: "Removed issue",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
      },
    }, env);

    expect(res3.status).toBe(200);
    const json3 = await res3.json() as Record<string, unknown>;
    expect(json3.ignored).toBe(true);
    expect(sentEvents).toHaveLength(0);
  });

  it("triggers when ticket is assigned to agent identity", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-400",
        title: "Assigned to agent",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        assignee: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.product).toBe("test-app");
    expect(sentEvents).toHaveLength(1);
  });

  it("triggers when app is delegated (not assignee)", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-401",
        title: "Delegated to agent",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        assignee: { id: "human-user", name: "Human User" },
        delegate: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.product).toBe("test-app");
    expect(sentEvents).toHaveLength(1);
  });

  it("ignores assignment to other users", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-402",
        title: "Assigned to someone else",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        assignee: { id: "user-2", name: "Someone Else", email: "other@example.com" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);
  });

  it("ignores terminal states even when assigned to agent", async () => {
    const app = makeApp();
    const env = makeEnv();

    // Moving to Done state should not trigger, even if assigned to agent
    const res1 = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-500",
        title: "Completed task",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        state: { name: "Done" },
        assignee: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res1.status).toBe(200);
    const json1 = await res1.json() as Record<string, unknown>;
    expect(json1.ignored).toBe(true);
    expect(json1.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);

    // Canceled state should also be ignored
    const res2 = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-501",
        title: "Canceled task",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        state: { name: "Canceled" },
        assignee: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res2.status).toBe(200);
    const json2 = await res2.json() as Record<string, unknown>;
    expect(json2.ignored).toBe(true);
    expect(json2.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);
  });

  it("includes comments in forwarded task_created event", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-with-comments",
        identifier: "HT-50",
        title: "Issue with comments",
        description: "Test comments",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        labelIds: [],
        project: { id: "p1", name: "Test App" },
        assignee: { id: "app-user-001", name: "Test Agent" },
      },
    }, env);

    expect(res.status).toBe(200);
    expect(sentEvents).toHaveLength(1);
    const event = sentEvents[0] as Record<string, unknown>;
    const payload = event.payload as Record<string, unknown>;
    const comments = payload.comments as Array<{ user: string; body: string; createdAt: string }>;
    expect(comments).toHaveLength(2);
    expect(comments[0].user).toBe("Alice");
    expect(comments[0].body).toBe("First comment");
    // Null user should fall back to "Unknown"
    expect(comments[1].user).toBe("Unknown");
  });

  it("ignores issues from unknown Linear projects", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-300",
        title: "Unknown project issue",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p99", name: "Unknown Product" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ignored).toBe(true);
    expect((json as Record<string, unknown>).reason).toContain("unknown project");
    expect(sentEvents).toHaveLength(0);
  });
});
