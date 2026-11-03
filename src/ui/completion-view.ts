import { completionRecommendation } from '../core/policy';

/** Do not round a strictly passing/failing value onto a neutral threshold in the UI. */
export function completionPercent(value: { readonly lower: number; readonly upper: number }): string {
  const rounded = Number(((value.lower + value.upper) * 50).toFixed(2));
  const decision = completionRecommendation(value);
  if (decision === 'RECOMMENDED' && rounded <= 65) return '>65%';
  if (decision === 'NOT_RECOMMENDED' && rounded >= 25) return '<25%';
  return value.upper - value.lower < 1e-5 ? `${rounded.toFixed(2)}%` : `${(value.lower * 100).toFixed(1)}–${(value.upper * 100).toFixed(1)}%`;
}
