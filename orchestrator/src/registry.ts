/**
 * Product registry — maps product names to their repos, secrets, and channels.
 *
 * For now this is a static config bundled with the worker.
 * Could move to D1 or KV later for dynamic updates.
 */

export interface ProductConfig {
  repos: string[];
  slack_channel: string;
  triggers: {
    feedback?: { enabled: boolean; callback_url?: string };
    linear?: { enabled: boolean; team_id: string };
    slack?: { enabled: boolean };
  };
  secrets: Record<string, string>; // logical name → Cloudflare secret binding name
}

export interface Registry {
  products: Record<string, ProductConfig>;
}

/**
 * Load the product registry.
 * Currently reads from the static config. The env parameter allows
 * per-product secrets to be resolved at runtime.
 */
export function loadRegistry(): Registry {
  return registry;
}

export function getProduct(name: string): ProductConfig | null {
  return registry.products[name] || null;
}

export function getProductByLinearTeam(teamId: string): { name: string; config: ProductConfig } | null {
  for (const [name, config] of Object.entries(registry.products)) {
    if (config.triggers.linear?.enabled && config.triggers.linear.team_id === teamId) {
      return { name, config };
    }
  }
  return null;
}

const registry: Registry = {
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
          team_id: "01328a7f-d761-4176-8bbf-004a397dc6f7",
        },
        slack: { enabled: true },
      },
      secrets: {
        GITHUB_TOKEN: "HEALTH_TOOL_GITHUB_TOKEN",
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        SLACK_APP_TOKEN: "SLACK_APP_TOKEN",
        LINEAR_API_KEY: "LINEAR_API_KEY",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
    },
    "bike-tool": {
      repos: ["fryanpan/bike-tool"],
      slack_channel: "#bike-tool",
      triggers: {
        linear: {
          enabled: true,
          team_id: "8bbe24c2-4d5b-4062-b9af-0a33c5c670d2",
        },
        slack: { enabled: true },
      },
      secrets: {
        GITHUB_TOKEN: "BIKE_TOOL_GITHUB_TOKEN",
        SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
        SLACK_APP_TOKEN: "SLACK_APP_TOKEN",
        LINEAR_API_KEY: "LINEAR_API_KEY",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
    },
  },
};
