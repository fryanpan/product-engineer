#!/usr/bin/env bun
/**
 * Configure Linear for all products in the registry
 *
 * Matches product slugs to Linear project names and updates trigger configuration
 */

const WORKER_URL = process.env.WORKER_URL;
const API_KEY = process.env.API_KEY;

if (!WORKER_URL) {
  console.error("❌ WORKER_URL environment variable is required");
  process.exit(1);
}

if (!API_KEY) {
  console.error("❌ API_KEY environment variable is required");
  process.exit(1);
}

// Mapping from product slug to Linear project name
const LINEAR_PROJECT_MAPPING: Record<string, string> = {
  "bike-tool": "Bike Tool",
  "blog-assistant": "Blog Assistant",
  "health-tool": "Health Tool",
  "nonprofit-impact": "Nonprofit Impact",
  "personal-crm": "personal-crm",
  "personal-finance": "Personal Finance",
  "product-engineer": "Product Engineer",
};

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

  return fetch(url, {
    ...options,
    headers,
  });
}

async function updateProductLinear(slug: string, projectName: string): Promise<void> {
  // Get current config
  const getRes = await apiRequest(`/api/products/${slug}`);
  if (!getRes.ok) {
    console.error(`❌ Failed to get ${slug}: ${getRes.status}`);
    return;
  }

  const { product } = await getRes.json() as { product: ProductConfig };

  // Update triggers to include Linear configuration
  const updatedConfig: ProductConfig = {
    ...product,
    triggers: {
      ...product.triggers,
      linear: {
        enabled: true,
        project_name: projectName,
      },
    },
  };

  // Update product
  const updateRes = await apiRequest(`/api/products/${slug}`, {
    method: "PUT",
    body: JSON.stringify({ config: updatedConfig }),
  });

  if (!updateRes.ok) {
    console.error(`❌ Failed to update ${slug}: ${updateRes.status}`);
    return;
  }

  console.log(`✅ ${slug} → Linear project: "${projectName}"`);
}

async function main() {
  console.log("🔧 Configuring Linear for all products...\n");

  let updated = 0;
  let skipped = 0;

  for (const [slug, projectName] of Object.entries(LINEAR_PROJECT_MAPPING)) {
    await updateProductLinear(slug, projectName);
    updated++;
  }

  // List products that weren't in the mapping
  const listRes = await apiRequest("/api/products");
  if (listRes.ok) {
    const { products } = await listRes.json() as { products: Record<string, ProductConfig> };
    for (const slug of Object.keys(products)) {
      if (!LINEAR_PROJECT_MAPPING[slug]) {
        console.log(`⚠️  ${slug} - No Linear project mapping (skipped)`);
        skipped++;
      }
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`✅ Updated ${updated} products with Linear configuration`);
  if (skipped > 0) {
    console.log(`⚠️  Skipped ${skipped} products (no Linear project mapping)`);
  }
  console.log("\nRun verification:");
  console.log("  bun run scripts/manage-registry.ts verify");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
