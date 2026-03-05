/**
 * Model selection based on ticket complexity analysis
 *
 * Analyzes ticket metadata to determine the appropriate Claude model:
 * - Haiku 4.5: Simple, low-priority tasks
 * - Sonnet 4.6: Standard tasks (default)
 * - Opus 4.6: Complex, high-priority tasks requiring deep reasoning
 */

export type ComplexityLevel = "low" | "medium" | "high";

export interface TicketComplexityFactors {
  priority?: number; // 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low
  title?: string;
  description?: string;
  labels?: string[];
}

/**
 * Analyze ticket complexity based on available metadata
 */
export function analyzeComplexity(factors: TicketComplexityFactors): ComplexityLevel {
  let score = 0;
  const text = `${factors.title || ""} ${factors.description || ""}`.toLowerCase();

  // Priority-based scoring (most important factor)
  if (factors.priority !== undefined) {
    if (factors.priority === 1) score += 3; // Urgent
    else if (factors.priority === 2) score += 2; // High
    else if (factors.priority === 3) score += 0; // Normal
    else if (factors.priority === 4) score -= 1; // Low
  }

  // High-complexity keywords
  const highComplexityKeywords = [
    "architecture", "refactor", "migration", "security",
    "performance", "optimization", "redesign", "rewrite",
    "infrastructure", "scale", "distributed", "system design",
    "authentication", "authorization", "encryption", "vulnerability"
  ];

  // Low-complexity keywords
  const lowComplexityKeywords = [
    "typo", "fix typo", "update text", "change wording",
    "fix link", "update link", "add link", "update docs",
    "add comment", "formatting", "whitespace", "indentation"
  ];

  // Check for complexity indicators
  for (const keyword of highComplexityKeywords) {
    if (text.includes(keyword)) {
      score += 2;
      break; // Only count once
    }
  }

  for (const keyword of lowComplexityKeywords) {
    if (text.includes(keyword)) {
      score -= 2;
      break; // Only count once
    }
  }

  // Description length (longer descriptions often indicate complexity)
  const descLength = (factors.description || "").length;
  if (descLength > 1000) score += 1;
  else if (descLength < 200) score -= 1;

  // Label-based scoring
  const labelText = (factors.labels || []).join(" ").toLowerCase();
  if (labelText.includes("bug")) score -= 1;
  if (labelText.includes("feature")) score += 1;
  if (labelText.includes("urgent") || labelText.includes("critical")) score += 2;
  if (labelText.includes("trivial") || labelText.includes("minor")) score -= 2;

  // Convert score to complexity level
  if (score >= 3) return "high";
  if (score <= -2) return "low";
  return "medium";
}

/**
 * Select the appropriate Claude model based on complexity
 */
export function selectModel(complexity: ComplexityLevel): string {
  switch (complexity) {
    case "low":
      return "haiku"; // Fast, cheap for simple tasks
    case "high":
      return "opus"; // Best quality for complex tasks
    case "medium":
    default:
      return "sonnet"; // Balanced default
  }
}

/**
 * Analyze ticket and select appropriate model
 */
export function selectModelForTicket(factors: TicketComplexityFactors): {
  model: string;
  complexity: ComplexityLevel;
  reason: string;
} {
  const complexity = analyzeComplexity(factors);
  const model = selectModel(complexity);

  const reasons = {
    low: "Simple task - using Haiku 4.5 for fast, cost-effective execution",
    medium: "Standard task - using Sonnet 4.6 for balanced performance",
    high: "Complex task - using Opus 4.6 for best quality and deep reasoning",
  };

  return {
    model,
    complexity,
    reason: reasons[complexity],
  };
}
