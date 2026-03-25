/**
 * Shared env var resolution for container DOs (TaskAgent, ProjectLead).
 *
 * Both agent types need the same base set of environment variables resolved
 * from platform config + per-product secrets. Role-specific vars are passed
 * as `extraVars`.
 */

import type { CloudflareAIGateway } from "./registry";

export interface ContainerEnvConfig {
  product: string;
  repos: string[];
  slackChannel: string;
  secrets: Record<string, string>;
  model?: string;
  mode?: "coding" | "research" | "flexible";
  slackPersona?: { username: string; icon_emoji?: string; icon_url?: string };
}

/**
 * Resolve the full set of env vars for a container agent.
 *
 * @param config  - Agent config (product, repos, secrets, etc.)
 * @param env     - Platform env bindings (secrets store values)
 * @param gatewayConfig - AI Gateway config (pass null to disable)
 * @param extraVars - Role-specific vars (e.g., TASK_UUID, AGENT_ROLE)
 */
export function resolveContainerEnvVars(
  config: ContainerEnvConfig,
  env: Record<string, string>,
  gatewayConfig?: CloudflareAIGateway | null,
  extraVars?: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {
    PRODUCT: config.product,
    REPOS: JSON.stringify(config.repos),
    SLACK_CHANNEL: config.slackChannel,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || "",
    LINEAR_APP_TOKEN: env.LINEAR_APP_TOKEN || "",
    SENTRY_DSN: env.SENTRY_DSN || "",
    WORKER_URL: env.WORKER_URL || "",
    API_KEY: env.API_KEY || "",
    MODEL: config.model || "",
    MODE: config.mode || "coding",
    SLACK_PERSONA: config.slackPersona ? JSON.stringify(config.slackPersona) : "",
    PROMPT_DELIMITER: env.PROMPT_DELIMITER || "",
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID || "",
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY || "",
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID || "",
  };

  // Resolve per-product secrets from env bindings (before extraVars so role-specific
  // vars like TASK_UUID can't be overridden by a secret with the same key)
  for (const [logicalName, bindingName] of Object.entries(config.secrets)) {
    const value = env[bindingName];
    if (value) {
      vars[logicalName] = value;
    } else {
      console.warn(`[container-env] Secret not found: ${logicalName} (binding: ${bindingName})`);
      vars[logicalName] = "";
    }
  }

  // Spread role-specific vars last — these take precedence over everything
  if (extraVars) {
    Object.assign(vars, extraVars);
  }

  // gh CLI reads GH_TOKEN for headless auth
  if (vars.GITHUB_TOKEN) {
    vars.GH_TOKEN = vars.GITHUB_TOKEN;
  }

  // Cloudflare AI Gateway — route all Anthropic API traffic through gateway
  if (gatewayConfig) {
    vars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gatewayConfig.account_id)}/${encodeURIComponent(gatewayConfig.gateway_id)}/anthropic`;
  }

  return vars;
}
