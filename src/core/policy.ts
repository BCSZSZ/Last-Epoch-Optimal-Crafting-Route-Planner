import policy from './policy.json';

/** Product cutoff on the untruncated FP mean conditioned on final operation success. */
export const MAXIMUM_SUCCESS_FP = policy.maximumSuccessFp;

/** Pre-policy snapshots used100FP. Replay their original policy with their archived model. */
export function maximumSuccessFp(model: { readonly modelId: string; readonly practicalPolicy?: { readonly maximumSuccessFp: number } }): number {
  return model.practicalPolicy?.maximumSuccessFp ?? 100;
}
