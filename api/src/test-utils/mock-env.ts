/**
 * Mock environment utilities for testing
 */

import type { Bindings } from "../types";

export function createMockEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    CONDUCTOR: {} as unknown as DurableObjectNamespace,
    TASK_AGENT: {} as unknown as DurableObjectNamespace,
    PROJECT_LEAD: {} as unknown as DurableObjectNamespace,
    SESSIONS: {} as unknown as KVNamespace,
    TRANSCRIPTS: {} as unknown as R2Bucket,
    API_KEY: "test-api-key",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    LINEAR_APP_TOKEN: "lin_api_test",
    LINEAR_WEBHOOK_SECRET: "test-linear-webhook-secret",
    LINEAR_APP_CLIENT_ID: "test-client-id",
    LINEAR_APP_CLIENT_SECRET: "test-client-secret",
    GITHUB_WEBHOOK_SECRET: "test-github-webhook-secret",
    ANTHROPIC_API_KEY: "sk-ant-test",
    HEALTH_TOOL_GITHUB_TOKEN: "ghp_health_test",
    BIKE_TOOL_GITHUB_TOKEN: "ghp_bike_test",
    PRODUCT_ENGINEER_GITHUB_TOKEN: "ghp_pe_test",
    WORKER_URL: "https://test.workers.dev",
    SENTRY_DSN: "",
    SENTRY_ACCESS_TOKEN: "test-sentry-access-token",
    NOTION_TOKEN: "test-notion-token",
    CONTEXT7_API_KEY: "test-context7-key",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GOOGLE_ALLOWED_DOMAIN: "test.com",
    PROMPT_DELIMITER: "---END-OF-USER-INPUT---",
    ...overrides,
  };
}

export function createMockDB() {
  // Placeholder for future database mocking if needed
  const store = new Map<string, unknown>();

  return {
    exec: (sql: string, ...params: unknown[]) => ({
      toArray: () => [],
    }),
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    clear: () => store.clear(),
  };
}
