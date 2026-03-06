import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { linearWebhook } from "./webhooks";
import type { Bindings } from "./types";
import { createMockOrchestratorStub, TEST_REGISTRY, type MockRegistryData } from "./test-helpers";
import { clearRegistryCache } from "./registry";

// Mock orchestrator DO that captures events sent to it AND serves registry data
let sentEvents: unknown[] = [];

function createMockOrchestratorWithEvents(registryData: MockRegistryData) {
  const baseStub = createMockOrchestratorStub(registryData);

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

let mockOrchestratorStub: DurableObjectStub;

const mockOrchestratorNamespace = {
  idFromName: (_name: string) => "mock-id",
  get: (_id: unknown) => mockOrchestratorStub,
};

function makeApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route("/", linearWebhook);
  return app;
}

const TEST_WEBHOOK_SECRET = "test-linear-webhook-secret";

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    ORCHESTRATOR: mockOrchestratorNamespace as unknown as DurableObjectNamespace,
    TICKET_AGENT: {} as unknown as DurableObjectNamespace,
    API_KEY: "test",
    SLACK_BOT_TOKEN: "test",
    SLACK_APP_TOKEN: "test",
    SLACK_SIGNING_SECRET: "test",
    LINEAR_API_KEY: "test",
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

describe("linear webhook handler", () => {
  beforeEach(() => {
    sentEvents = [];
    clearRegistryCache();
    mockOrchestratorStub = createMockOrchestratorWithEvents(TEST_REGISTRY);
  });

  it("ignores non-Issue events", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "create",
      type: "Comment",
      data: {
        id: "c1",
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
        assignee: { id: "user-1", name: "Test Agent", email: "agent@example.com" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.product).toBe("test-app");

    expect(sentEvents).toHaveLength(1);
    const event = sentEvents[0] as Record<string, unknown>;
    expect(event.type).toBe("ticket_created");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.id).toBe("issue-124");
    expect(payload.title).toBe("Another issue");
    expect(payload.identifier).toBe("HT-43");
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
        assignee: { id: "user-1", name: "Test Agent", email: "agent@example.com" },
      },
    }, env);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.product).toBe("test-app");
    expect(sentEvents).toHaveLength(1);
  });

  it("triggers when assigned to agent by name (no email in payload)", async () => {
    const app = makeApp();
    const env = makeEnv();
    const res = await postWebhook(app, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-401",
        title: "Assigned by name",
        description: "",
        priority: 1,
        teamId: TEST_REGISTRY.linear_team_id,
        project: { id: "p1", name: "Test App" },
        assignee: { id: "user-1", name: "Test Agent" },
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
        assignee: { id: "user-1", name: "Test Agent", email: "agent@example.com" },
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
        assignee: { id: "user-1", name: "Test Agent", email: "agent@example.com" },
      },
    }, env);

    expect(res2.status).toBe(200);
    const json2 = await res2.json() as Record<string, unknown>;
    expect(json2.ignored).toBe(true);
    expect(json2.reason).toBe("action not relevant");
    expect(sentEvents).toHaveLength(0);
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
