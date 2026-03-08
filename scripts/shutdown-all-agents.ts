#!/usr/bin/env bun
/**
 * Emergency shutdown script - marks all agents as inactive and triggers cleanup.
 *
 * Usage:
 *   export API_KEY=your-api-key
 *   bun run scripts/shutdown-all-agents.ts
 */

const WORKER_URL = "https://product-engineer.fryansoftware.workers.dev";
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("❌ API_KEY environment variable is required");
  process.exit(1);
}

interface StatusResponse {
  activeAgents: Array<{
    id: string;
    product: string;
    status: string;
    last_heartbeat: string | null;
  }>;
  summary: {
    totalActive: number;
  };
}

async function getStatus(): Promise<StatusResponse> {
  const response = await fetch(`${WORKER_URL}/api/orchestrator/status`, {
    headers: { "X-API-Key": API_KEY },
  });

  if (!response.ok) {
    throw new Error(`Failed to get status: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function cleanupInactive(): Promise<any> {
  const response = await fetch(`${WORKER_URL}/api/orchestrator/cleanup-inactive`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY },
  });

  if (!response.ok) {
    throw new Error(`Failed to cleanup: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function main() {
  console.log("🔍 Checking current system status...\n");

  const statusBefore = await getStatus();
  console.log(`�� Current state:`);
  console.log(`   Active agents: ${statusBefore.summary.totalActive}`);

  if (statusBefore.activeAgents.length > 0) {
    console.log(`\n   Active agents:`);
    for (const agent of statusBefore.activeAgents) {
      console.log(`   - ${agent.id} (${agent.product}) - ${agent.status}`);
    }
  }

  if (statusBefore.summary.totalActive === 0) {
    console.log("\n��� No active agents found. Nothing to clean up.");
    return;
  }

  console.log(`\n⚠️  WARNING: This will attempt to shut down ALL agent containers.`);
  console.log(`   Note: The current /cleanup-inactive endpoint only handles agents`);
  console.log(`   that are already marked inactive. To shut down ALL agents including`);
  console.log(`   active ones, you'll need to deploy the new /shutdown-all endpoint first.\n`);

  console.log(`🧹 Running cleanup on inactive agents...\n`);

  const cleanupResult = await cleanupInactive();
  console.log(`\n�� Cleanup result:`);
  console.log(`   Total processed: ${cleanupResult.total}`);
  console.log(`   Successful: ${cleanupResult.successful}`);
  console.log(`   Failed: ${cleanupResult.total - cleanupResult.successful}`);

  if (cleanupResult.results && cleanupResult.results.length > 0) {
    const failed = cleanupResult.results.filter((r: any) => !r.success);
    if (failed.length > 0) {
      console.log(`\n   Failed shutdowns:`);
      for (const result of failed) {
        console.log(`   - ${result.ticketId}: ${result.error}`);
      }
    }
  }

  // Check status again
  console.log(`\n🔍 Checking status after cleanup...\n`);
  const statusAfter = await getStatus();
  console.log(`📊 Final state:`);
  console.log(`   Active agents: ${statusAfter.summary.totalActive}`);

  if (statusAfter.summary.totalActive > 0) {
    console.log(`\n⚠️  ${statusAfter.summary.totalActive} agents are still active.`);
    console.log(`   These agents were not marked inactive, so cleanup-inactive couldn't process them.`);
    console.log(`\n   To force shutdown ALL agents, you need to:`);
    console.log(`   1. Deploy the code changes that add the /shutdown-all endpoint`);
    console.log(`   2. Run: curl -X POST -H "X-API-Key: $API_KEY" ${WORKER_URL}/api/orchestrator/shutdown-all`);
  } else {
    console.log(`\n✅ All agents have been shut down successfully!`);
  }
}

main().catch((error) => {
  console.error("❌ Error:", error.message);
  process.exit(1);
});
