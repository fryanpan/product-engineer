/**
 * Product registry — typed helpers with DO-backed lookups.
 *
 * Product data lives in the Orchestrator DO's SQLite database.
 * This file provides cached lookups with lazy loading from the DO.
 */

export interface SlackPersona {
  username: string;
  icon_emoji?: string;
  icon_url?: string;
}

export interface ProductConfig {
  repos: string[];
  slack_channel: string;
  slack_channel_id?: string;
  triggers: {
    feedback?: { enabled: boolean; callback_url?: string };
    linear?: { enabled: boolean; project_name: string };
    slack?: { enabled: boolean };
  };
  secrets: Record<string, string>;
  slack_persona?: SlackPersona;
  mode?: "coding" | "research" | "flexible";
  preferred_backend?: string;
}

export interface CloudflareAIGateway {
  account_id: string;
  gateway_id: string;
}

export interface Registry {
  linear_team_id: string;
  linear_app_user_id: string;
  cloudflare_ai_gateway?: CloudflareAIGateway;
  products: Record<string, ProductConfig>;
}

// Module-level cache — persists per Worker isolate
let registryCache: Registry | null = null;

/**
 * Load registry from DO on first access, then cache for the life of the isolate.
 * Registry changes are rare, so stale-for-one-isolate is acceptable.
 */
export async function loadRegistry(orchestratorStub: DurableObjectStub): Promise<Registry> {
  if (registryCache) {
    return registryCache;
  }

  // Fetch from DO
  const [productsRes, settingsRes] = await Promise.all([
    orchestratorStub.fetch(new Request("http://internal/products")),
    orchestratorStub.fetch(new Request("http://internal/settings")),
  ]);

  const { products } = await productsRes.json<{ products: Record<string, ProductConfig> }>();
  const { settings } = await settingsRes.json<{ settings: Record<string, string> }>();

  const cloudflareAiGateway = settings.cloudflare_ai_gateway
    ? JSON.parse(settings.cloudflare_ai_gateway)
    : undefined;

  registryCache = {
    linear_team_id: settings.linear_team_id || "",
    linear_app_user_id: settings.linear_app_user_id || "",
    cloudflare_ai_gateway: cloudflareAiGateway,
    products,
  };

  return registryCache;
}

/**
 * Clear the cache — useful for testing or if you need to force a reload.
 * Not used in production.
 */
export function clearRegistryCache() {
  registryCache = null;
}

export async function getProduct(
  orchestratorStub: DurableObjectStub,
  name: string,
): Promise<ProductConfig | null> {
  const registry = await loadRegistry(orchestratorStub);
  return registry.products[name] || null;
}

export async function getProducts(
  orchestratorStub: DurableObjectStub,
): Promise<Record<string, ProductConfig>> {
  const registry = await loadRegistry(orchestratorStub);
  return registry.products;
}

export async function getProductByLinearProject(
  orchestratorStub: DurableObjectStub,
  projectName: string,
): Promise<{ name: string; config: ProductConfig } | null> {
  const registry = await loadRegistry(orchestratorStub);
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

export async function isOurTeam(
  orchestratorStub: DurableObjectStub,
  teamId: string,
): Promise<boolean> {
  const registry = await loadRegistry(orchestratorStub);
  return registry.linear_team_id === teamId;
}

export async function getLinearAppUserId(
  orchestratorStub: DurableObjectStub,
): Promise<string> {
  const registry = await loadRegistry(orchestratorStub);
  return registry.linear_app_user_id;
}

export async function getAIGatewayConfig(
  orchestratorStub: DurableObjectStub,
): Promise<CloudflareAIGateway | null> {
  const registry = await loadRegistry(orchestratorStub);
  return registry.cloudflare_ai_gateway || null;
}
