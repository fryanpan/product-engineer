/**
 * Test helpers for mocking the registry and conductor.
 */

export interface MockRegistryData {
  linear_team_id: string;
  linear_app_user_id: string;
  cloudflare_ai_gateway?: { account_id: string; gateway_id: string };
  products: Record<string, any>;
}

/**
 * Create a mock conductor stub that returns test registry data.
 */
export function createMockConductorStub(registryData: MockRegistryData): DurableObjectStub {
  return {
    fetch: async (req: Request) => {
      const url = new URL(req.url);

      if (url.pathname === "/products") {
        return Response.json({ products: registryData.products });
      }

      if (url.pathname === "/settings") {
        const settings: Record<string, string> = {
          linear_team_id: registryData.linear_team_id,
          linear_app_user_id: registryData.linear_app_user_id,
        };

        if (registryData.cloudflare_ai_gateway) {
          settings.cloudflare_ai_gateway = JSON.stringify(registryData.cloudflare_ai_gateway);
        }

        return Response.json({ settings });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  } as unknown as DurableObjectStub;
}

/**
 * Default test registry with fictional data.
 */
export const TEST_REGISTRY: MockRegistryData = {
  linear_team_id: "00000000-0000-0000-0000-000000000001",
  linear_app_user_id: "app-user-001",
  products: {
    "test-app": {
      repos: ["test-org/test-app"],
      slack_channel: "#test-app",
      slack_channel_id: "C000000APP1",
      triggers: {
        linear: { enabled: true, project_name: "Test App" },
        slack: { enabled: true },
      },
      secrets: {
        GITHUB_TOKEN: "TEST_GITHUB_TOKEN",
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        LINEAR_APP_TOKEN: "LINEAR_APP_TOKEN",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
    },
    "another-app": {
      repos: ["test-org/another-app"],
      slack_channel: "#another-app",
      slack_channel_id: "C000000APP2",
      triggers: {
        linear: { enabled: true, project_name: "Another App" },
        slack: { enabled: true },
      },
      secrets: {
        GITHUB_TOKEN: "TEST_GITHUB_TOKEN",
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        LINEAR_APP_TOKEN: "LINEAR_APP_TOKEN",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
    },
    "multi-repo-app": {
      repos: ["test-org/frontend", "test-org/backend"],
      slack_channel: "#multi-repo",
      triggers: {
        linear: { enabled: true, project_name: "Multi Repo" },
        slack: { enabled: true },
      },
      secrets: {
        GITHUB_TOKEN: "TEST_GITHUB_TOKEN",
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        LINEAR_APP_TOKEN: "LINEAR_APP_TOKEN",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
    },
  },
};
