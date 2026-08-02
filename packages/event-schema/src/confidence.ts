import type { ConfidenceLabel, SourceTier } from "./events.js";

/** Authority weight per source tier — the dominant factor in confidence. */
export const TIER_WEIGHT: Record<SourceTier, number> = {
  A: 1.0,
  B: 0.92,
  C: 0.75,
  D: 0.55,
  E: 0.3,
};

export interface ConfidenceInputs {
  tier: SourceTier;
  /** Age of the newest supporting record, in seconds. */
  age_seconds: number;
  /** Max acceptable age for this record type, in seconds. */
  max_age_seconds: number;
  /** Number of independent corroborating sources (>= 1). */
  corroborating_sources: number;
  /** 1 = precise geometry, down to 0.5 for city-wide scope. */
  geographic_precision?: number;
  /** 1 = all sources agree, down to 0.4 when actively disputed. */
  consistency?: number;
}

/**
 * Transparent multiplicative confidence score in [0, 1].
 *
 * confidence = authority × freshness × corroboration × precision × consistency
 *
 * The numeric score is INTERNAL — for ranking and label derivation only.
 * Users see labels (see confidenceLabel), never percentages, because this
 * formula is transparent but uncalibrated.
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  const authority = TIER_WEIGHT[inputs.tier];

  // Linear decay to 0.35 at max age, hard floor 0.2 beyond it.
  const ageRatio = Math.min(inputs.age_seconds / Math.max(inputs.max_age_seconds, 1), 2);
  const freshness = ageRatio <= 1 ? 1 - 0.65 * ageRatio : 0.2;

  // 1 source → 0.85, 2 → 0.95, 3+ → 1.0
  const n = Math.max(1, inputs.corroborating_sources);
  const corroboration = n >= 3 ? 1 : n === 2 ? 0.95 : 0.85;

  const precision = inputs.geographic_precision ?? 1;
  const consistency = inputs.consistency ?? 1;

  const score = authority * freshness * corroboration * precision * consistency;
  return Math.max(0, Math.min(1, score));
}

/**
 * User-facing label. Tier gates the ceiling: only tier A/B records can be
 * "official"; a tier E record can never exceed "unverified" regardless of score.
 */
export function confidenceLabel(score: number, tier: SourceTier): ConfidenceLabel {
  if (tier === "E") return "unverified";
  if (score >= 0.8 && (tier === "A" || tier === "B")) return "official";
  if (score >= 0.6) return "verified";
  if (score >= 0.4) return "developing";
  return "unverified";
}
