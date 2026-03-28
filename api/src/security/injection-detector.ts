/**
 * Injection detection for LLM prompt injection attacks.
 *
 * Uses the vard library (pattern-based, <1ms) for detection of known attack
 * vectors: instruction override, role manipulation, delimiter injection,
 * system prompt leakage, and encoding attacks.
 *
 * Also checks for a secret per-environment prompt delimiter — if user input
 * contains the delimiter, it's an attempt to break out of the input boundary.
 * The delimiter is set via the PROMPT_DELIMITER secret (never checked in).
 */

import vard from "@andersmyrmel/vard";

const MAX_CONTENT_LENGTH = 100_000;

export interface InjectionDetection {
  pattern: string;
  matched: string;
}

export interface FieldDetection extends InjectionDetection {
  field: string;
}

/**
 * Create a vard validator configured with optional custom delimiter.
 * The delimiter is a secret per-environment string that wraps untrusted input
 * in prompts. If it appears in user input, it's an injection attempt.
 */
function createValidator(promptDelimiter?: string) {
  let v = vard
    .strict()
    .block("instructionOverride")
    .block("roleManipulation")
    .block("delimiterInjection")
    .block("systemPromptLeak")
    .block("encoding")
    .threshold(0.8)
    .maxLength(MAX_CONTENT_LENGTH);

  // Add secret delimiter as a custom delimiter to detect
  if (promptDelimiter) {
    v = v.delimiters([promptDelimiter]);
  }

  return v;
}

// Module-level validator — initialized without delimiter, reconfigured via configure()
let validator = createValidator();

/**
 * Configure the injection detector with an environment-specific prompt delimiter.
 * Call once at startup with the PROMPT_DELIMITER secret.
 */
export function configure(promptDelimiter?: string) {
  validator = createValidator(promptDelimiter);
}

/**
 * Scan a single string for injection patterns.
 * Returns the first detection found, or null if clean.
 */
export function detectInjection(text: string): InjectionDetection | null {
  if (!text) return null;

  if (text.length > MAX_CONTENT_LENGTH) {
    return { pattern: "content_too_long", matched: `length=${text.length}` };
  }

  if (text.includes("\0")) {
    return { pattern: "null_byte", matched: "\\x00" };
  }

  const result = validator.safeParse(text);
  if (!result.safe) {
    const threat = result.threats[0];
    return {
      pattern: threat.type,
      matched: threat.match,
    };
  }

  return null;
}

/**
 * Recursively scan all string fields in an object for injection patterns.
 * Returns an array of detections with the field path where each was found.
 */
export function scanEventFields(obj: unknown, prefix = "", depth = 0): FieldDetection[] {
  const MAX_DEPTH = 20;
  const results: FieldDetection[] = [];

  if (depth > MAX_DEPTH || obj === null || obj === undefined) return results;

  if (typeof obj === "string") {
    const detection = detectInjection(obj);
    if (detection) {
      results.push({ ...detection, field: prefix });
    }
    return results;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...scanEventFields(obj[i], `${prefix}[${i}]`, depth + 1));
    }
    return results;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      results.push(...scanEventFields(value, fieldPath, depth + 1));
    }
  }

  return results;
}
