/**
 * Product registry — maps product names to their repos, secrets, and channels.
 *
 * Linear integration uses a single team ("Team Bryan") with projects
 * mapping to products. Each Linear project name (e.g., "Health Tool")
 * maps to one or more repos.
 *
 * For now this is a static config bundled with the worker.
 * Could move to D1 or KV later for dynamic updates.
 */

export interface ProductConfig {
  repos: string[];
  slack_channel: string;     // Human-readable name (e.g., "#health-tool") — used for Slack API posts
  slack_channel_id?: string; // Slack channel ID (e.g., "C06ABC123") — used for matching Socket Mode events
  triggers: {
    feedback?: { enabled: boolean; callback_url?: string };
    linear?: { enabled: boolean; project_name: string };
    slack?: { enabled: boolean };
  };
  secrets: Record<string, string>; // logical name → Cloudflare secret binding name
}

export interface Registry {
  /** The Linear team ID that all products share ("Team Bryan"). */
  linear_team_id: string;
  products: Record<string, ProductConfig>;
}

export function loadRegistry(): Registry {
  return registry;
}

export function getProduct(name: string): ProductConfig | null {
  return registry.products[name] || null;
}

export function getProducts(): Record<string, ProductConfig> {
  return registry.products;
}

/**
 * Look up a product by Linear project name or ID.
 * Linear webhooks include project.name and project.id — we match on name
 * since it's human-readable and the user configures it.
 */
export function getProductByLinearProject(
  projectName: string,
): { name: string; config: ProductConfig } | null {
  const normalized = projectName.toLowerCase();
  for (const [name, config] of Object.entries(registry.products)) {
    if (
      config.triggers.linear?.enabled &&
      config.triggers.linear.project_name.toLowerCase() === normalized
    ) {
      return { name, config };
    }
  }
  return null;
}

/**
 * Check if a webhook belongs to our team.
 */
export function isOurTeam(teamId: string): boolean {
  return registry.linear_team_id === teamId;
}

const registry: Registry = {
  linear_team_id: "01328a7f-d761-4176-8bbf-004a397dc6f7", // Team Bryan
  products: {
    "health-tool": {
      repos: ["fryanpan/health-tool"],
      slack_channel: "#health-tool",
      triggers: {
        feedback: {
          enabled: true,
          callback_url: "https://ht-api.fryanpan.workers.dev",
        },
        linear: {
          enabled: true,
          project_name: "Health Tool",
        },
        slack: { enabled: true },
      },
      secrets: {
        GITHUB_TOKEN: "HEALTH_TOOL_GITHUB_TOKEN",
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        SLACK_APP_TOKEN: "SLACK_APP_TOKEN",
        LINEAR_API_KEY: "LINEAR_API_KEY",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
        NOTION_TOKEN: "NOTION_TOKEN",
        SENTRY_ACCESS_TOKEN: "SENTRY_ACCESS_TOKEN",
        CONTEXT7_API_KEY: "CONTEXT7_API_KEY",
      },
    },
    "bike-tool": {
      repos: ["fryanpan/bike-tool"],
      slack_channel: "#bike-tool",
      triggers: {
        linear: {
          enabled: true,
          project_name: "Bike Tool",
        },
        slack: { enabled: true },
      },
      secrets: {
        GITHUB_TOKEN: "BIKE_TOOL_GITHUB_TOKEN",
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        SLACK_APP_TOKEN: "SLACK_APP_TOKEN",
        LINEAR_API_KEY: "LINEAR_API_KEY",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
        NOTION_TOKEN: "NOTION_TOKEN",
        SENTRY_ACCESS_TOKEN: "SENTRY_ACCESS_TOKEN",
        CONTEXT7_API_KEY: "CONTEXT7_API_KEY",
      },
    },
  },
};
