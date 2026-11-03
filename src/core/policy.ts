import policy from './policy.json';

/** Product cutoff on the untruncated FP mean conditioned on final operation success. */
export const MAXIMUM_SUCCESS_FP = policy.maximumSuccessFp;
export const REFERENCE_FP = policy.referenceFp;
export type CompletionRecommendation = 'RECOMMENDED' | 'NOT_RECOMMENDED' | 'NEUTRAL' | 'UNRESOLVED';

export function completionRecommendation(probability: { readonly lower: number; readonly upper: number },
  limits: { readonly notRecommendedBelow?: number; readonly recommendedAbove?: number } = policy): CompletionRecommendation {
  const lower = limits.notRecommendedBelow ?? policy.notRecommendedBelow, upper = limits.recommendedAbove ?? policy.recommendedAbove;
  if (probability.upper < lower) return 'NOT_RECOMMENDED';
  if (probability.lower > upper) return 'RECOMMENDED';
  if (probability.lower >= lower && probability.upper <= upper) return 'NEUTRAL';
  return 'UNRESOLVED';
}

/** Pre-policy snapshots used100FP. Replay their original policy with their archived model. */
export function maximumSuccessFp(model: { readonly modelId: string; readonly practicalPolicy?: { readonly maximumSuccessFp: number } }): number {
  return model.practicalPolicy?.maximumSuccessFp ?? 100;
}
