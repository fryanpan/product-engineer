#!/usr/bin/env bun
/**
 * Registry Management Script
 *
 * Usage:
 *   # List all products
 *   bun run scripts/manage-registry.ts list
 *
 *   # Get a specific product
 *   bun run scripts/manage-registry.ts get <product-slug>
 *
 *   # Delete a product
 *   bun run scripts/manage-registry.ts delete <product-slug>
 *
 *   # Verify Slack/Linear configuration
 *   bun run scripts/manage-registry.ts verify
 *
 * Environment variables:
 *   WORKER_URL - The deployed Worker URL (e.g., https://product-engineer.your-subdomain.workers.dev)
 *   API_KEY - Required API key for admin endpoint authentication
 */

const WORKER_URL = process.env.WORKER_URL;
const API_KEY = process.env.API_KEY;

if (!WORKER_URL) {
  console.error("❌ WORKER_URL environment variable is required");
  console.error("   Set it to your deployed Worker URL (e.g., https://product-engineer.your-subdomain.workers.dev)");
  process.exit(1);
}

if (!API_KEY) {
  console.error("❌ API_KEY environment variable is required");
  console.error("   Admin endpoints require X-API-Key authentication");
  process.exit(1);
}

type ProductConfig = {
  repos: string[];
  slack_channel: string;
  slack_channel_id?: string;
  secrets: Record<string, string>;
  triggers: {
    feedback?: { enabled: boolean; callback_url?: string };
    linear?: { enabled: boolean; project_name: string };
    slack?: { enabled: boolean };
  };
};

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${WORKER_URL}${path}`;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    ...options.headers,
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  // Special case 401 to provide clearer error message
  if (res.status === 401) {
    console.error("❌ Authentication failed: Invalid or missing API_KEY");
    console.error("   Ensure API_KEY is set and matches the Worker's configured key");
    process.exit(1);
  }

  return res;
}

async function listProducts(): Promise<void> {
  console.log("📋 Listing all products...\n");

  const res = await apiRequest("/api/products");
  if (!res.ok) {
    console.error(`❌ Failed to list products: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const data = await res.json() as { products: Record<string, ProductConfig> };
  const products = data.products;

  if (Object.keys(products).length === 0) {
    console.log("No products registered.");
    return;
  }

  console.log(`Found ${Object.keys(products).length} product(s):\n`);

  for (const [slug, config] of Object.entries(products)) {
    console.log(`📦 ${slug}`);
    console.log(`   Repos: ${config.repos.join(", ")}`);
    console.log(`   Slack: ${config.slack_channel_id || config.slack_channel || "not configured"}`);
    console.log(`   Linear: ${config.triggers.linear?.project_name || "not configured"}`);
    console.log(`   Triggers: Linear=${config.triggers.linear?.enabled ?? false}, Feedback=${config.triggers.feedback?.enabled ?? false}, Slack=${config.triggers.slack?.enabled ?? false}`);
    console.log();
  }
}

async function getProduct(slug: string): Promise<void> {
  console.log(`🔍 Getting product: ${slug}\n`);

  const res = await apiRequest(`/api/products/${slug}`);
  if (!res.ok) {
    if (res.status === 404) {
      console.error(`❌ Product not found: ${slug}`);
    } else {
      console.error(`❌ Failed to get product: ${res.status} ${res.statusText}`);
    }
    process.exit(1);
  }

  const data = await res.json() as { product: ProductConfig };
  console.log(JSON.stringify(data.product, null, 2));
}

async function deleteProduct(slug: string): Promise<void> {
  console.log(`🗑️  Deleting product: ${slug}\n`);

  const res = await apiRequest(`/api/products/${slug}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    if (res.status === 404) {
      console.error(`❌ Product not found: ${slug}`);
    } else {
      console.error(`❌ Failed to delete product: ${res.status} ${res.statusText}`);
    }
    process.exit(1);
  }

  console.log(`✅ Product deleted: ${slug}`);
}

async function verifyConfiguration(): Promise<void> {
  console.log("🔍 Verifying Slack and Linear configuration for all products...\n");

  const res = await apiRequest("/api/products");
  if (!res.ok) {
    console.error(`❌ Failed to list products: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const data = await res.json() as { products: Record<string, ProductConfig> };
  const products = data.products;

  if (Object.keys(products).length === 0) {
    console.log("No products registered.");
    return;
  }

  const issues: string[] = [];

  for (const [slug, config] of Object.entries(products)) {
    console.log(`\n📦 ${slug}`);
    console.log("─".repeat(50));

    // Check repos
    if (!config.repos || config.repos.length === 0) {
      issues.push(`${slug}: No repos configured`);
      console.log("❌ Repos: Not configured");
    } else {
      console.log(`✅ Repos: ${config.repos.join(", ")}`);
    }

    // Check Slack configuration
    const hasSlackChannel = config.slack_channel || config.slack_channel_id;
    if (!hasSlackChannel) {
      issues.push(`${slug}: Slack channel not configured`);
      console.log("❌ Slack: Not configured");
    } else {
      console.log(`✅ Slack: ${config.slack_channel_id || config.slack_channel}`);

      // Check if Slack trigger is enabled
      const slackTriggerEnabled = config.triggers.slack?.enabled ?? false;
      if (!slackTriggerEnabled) {
        console.log("⚠️  Slack trigger is disabled");
      }
    }

    // Check Linear configuration
    const hasLinearConfig = config.triggers.linear?.project_name;
    if (!hasLinearConfig) {
      issues.push(`${slug}: Linear configuration missing`);
      console.log("❌ Linear: Not configured (missing triggers.linear.project_name)");
    } else {
      console.log(`✅ Linear Project Name: ${config.triggers.linear.project_name}`);

      // Check if Linear trigger is enabled
      const linearTriggerEnabled = config.triggers.linear?.enabled ?? false;
      if (!linearTriggerEnabled) {
        console.log("⚠️  Linear trigger is disabled");
      }
    }

    // Check secrets
    if (!config.secrets || Object.keys(config.secrets).length === 0) {
      issues.push(`${slug}: No secrets configured`);
      console.log("❌ Secrets: Not configured");
    } else {
      console.log(`✅ Secrets: ${Object.keys(config.secrets).join(", ")}`);

      // Check for common required secrets
      const requiredSecrets = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"];
      const missingSecrets = requiredSecrets.filter(s => !config.secrets[s]);
      if (missingSecrets.length > 0) {
        issues.push(`${slug}: Missing secrets: ${missingSecrets.join(", ")}`);
        console.log(`⚠️  Missing recommended secrets: ${missingSecrets.join(", ")}`);
      }
    }
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  if (issues.length === 0) {
    console.log("✅ All products are properly configured!");
  } else {
    console.log(`⚠️  Found ${issues.length} configuration issue(s):\n`);
    issues.forEach(issue => console.log(`   • ${issue}`));
    console.log("\nRecommended actions:");
    console.log("1. Review the issues above");
    console.log("2. Update product configurations using the admin API");
    console.log("3. Re-run this verification to confirm fixes");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error("❌ Missing command");
    console.error("\nUsage:");
    console.error("  bun run scripts/manage-registry.ts list");
    console.error("  bun run scripts/manage-registry.ts get <product-slug>");
    console.error("  bun run scripts/manage-registry.ts delete <product-slug>");
    console.error("  bun run scripts/manage-registry.ts verify");
    process.exit(1);
  }

  try {
    switch (command) {
      case "list":
        await listProducts();
        break;

      case "get":
        if (!args[1]) {
          console.error("❌ Missing product slug");
          console.error("Usage: bun run scripts/manage-registry.ts get <product-slug>");
          process.exit(1);
        }
        await getProduct(args[1]);
        break;

      case "delete":
        if (!args[1]) {
          console.error("❌ Missing product slug");
          console.error("Usage: bun run scripts/manage-registry.ts delete <product-slug>");
          process.exit(1);
        }
        await deleteProduct(args[1]);
        break;

      case "verify":
        await verifyConfiguration();
        break;

      default:
        console.error(`❌ Unknown command: ${command}`);
        console.error("\nAvailable commands: list, get, delete, verify");
        process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

main();
