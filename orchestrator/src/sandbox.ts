/**
 * Sandbox launcher — creates a Cloudflare Container and runs the PE agent.
 *
 * Adapted from health-tool's agent-trigger.ts, generalized for any product.
 * The sandbox:
 * 1. Clones the product's repo(s)
 * 2. Runs the generic PE agent with task payload + secrets
 * 3. Cleans up on completion or failure
 */

import { type Sandbox as SandboxType } from "@cloudflare/sandbox";
import type { ProductConfig } from "./registry";

export interface SandboxEnv {
  Sandbox: DurableObjectNamespace<SandboxType>;
  [key: string]: unknown; // Secret bindings resolved at runtime
}

export interface LaunchOptions {
  taskId: string;
  product: string;
  productConfig: ProductConfig;
  taskPayload: unknown;
  env: SandboxEnv;
  slackThreadTs?: string;
}

export async function launchSandbox(options: LaunchOptions): Promise<void> {
  const { taskId, product, productConfig, taskPayload, env, slackThreadTs } =
    options;

  const { getSandbox } = await import("@cloudflare/sandbox");

  const sandbox = getSandbox(env.Sandbox, `${product}-${taskId}`, {
    sleepAfter: "15m",
  });

  // Resolve secrets from env bindings
  const secrets = resolveSecrets(productConfig.secrets, env);

  try {
    // Configure git auth via .netrc
    await sandbox.writeFile(
      "/root/.netrc",
      `machine github.com\nlogin x-access-token\npassword ${secrets.GITHUB_TOKEN}\n`,
    );
    await sandbox.exec("chmod 600 /root/.netrc");

    // Clone all repos for this product
    for (const repo of productConfig.repos) {
      const repoName = repo.split("/").pop()!;
      await sandbox.exec(
        `git clone https://github.com/${repo}.git /workspace/${repoName}`,
        { timeout: 120_000 },
      );
    }

    // Determine the primary repo (first one) as the working directory
    const primaryRepo = productConfig.repos[0].split("/").pop()!;

    // Build the full task payload for the agent
    const fullPayload = {
      ...taskPayload as Record<string, unknown>,
      product,
      repos: productConfig.repos,
    };

    // Run the PE agent
    const orchestratorUrl = env.ORCHESTRATOR_URL as string || "";
    const orchestratorApiKey = env.API_KEY as string || "";

    const result = await sandbox.exec(
      "cd /app/agent && bun src/index.ts",
      {
        cwd: `/workspace/${primaryRepo}`,
        timeout: 600_000,
        env: {
          TASK_PAYLOAD: JSON.stringify(fullPayload),
          ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY,
          GITHUB_TOKEN: secrets.GITHUB_TOKEN,
          SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
          SLACK_APP_TOKEN: secrets.SLACK_APP_TOKEN || "",
          SLACK_THREAD_TS: slackThreadTs || "",
          LINEAR_API_KEY: secrets.LINEAR_API_KEY,
          SLACK_CHANNEL: productConfig.slack_channel,
          ORCHESTRATOR_URL: orchestratorUrl,
          ORCHESTRATOR_API_KEY: orchestratorApiKey,
        },
      },
    );

    if (!result.success) {
      // Sanitize stderr to avoid leaking secrets
      const secretValues = Object.values(secrets).filter(Boolean);
      let sanitized = result.stderr;
      for (const secret of secretValues) {
        sanitized = sanitized.replaceAll(secret, "[REDACTED]");
      }
      sanitized = sanitized
        .replace(/x-access-token:[^\s@]+@/g, "x-access-token:[REDACTED]@")
        .replace(/password\s+\S+/g, "password [REDACTED]");
      throw new Error(
        `PE agent exited with code ${result.exitCode}: ${sanitized}`,
      );
    }
  } finally {
    await sandbox.destroy();
  }
}

function resolveSecrets(
  secretMap: Record<string, string>,
  env: SandboxEnv,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [logicalName, bindingName] of Object.entries(secretMap)) {
    const value = env[bindingName];
    if (typeof value === "string" && value) {
      resolved[logicalName] = value;
    } else {
      console.warn(
        `[Sandbox] Secret ${logicalName} (binding: ${bindingName}) not found in env`,
      );
      resolved[logicalName] = "";
    }
  }
  return resolved;
}
