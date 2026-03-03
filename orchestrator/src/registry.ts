/**
 * Product registry — typed helpers over registry.json.
 *
 * Product data lives in registry.json (easy to edit, no TypeScript).
 * This file provides typed lookups.
 */

import data from "./registry.json";

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
}

export interface Registry {
  linear_team_id: string;
  products: Record<string, ProductConfig>;
}

const registry = data as Registry;

export function loadRegistry(): Registry {
  return registry;
}

export function getProduct(name: string): ProductConfig | null {
  return registry.products[name] || null;
}

export function getProducts(): Record<string, ProductConfig> {
  return registry.products;
}

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

export function isOurTeam(teamId: string): boolean {
  return registry.linear_team_id === teamId;
}
