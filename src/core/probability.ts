import type { FpType } from './types';
import { exact, Interval, ONE, ZERO, ratio } from './interval';

export interface Mass<T> { readonly value: T; readonly probability: number }

export function sum(values: Iterable<number>): number {
  // Compensated summation also makes large weighted pools reproducible.
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const adjusted = value - compensation;
    const next = total + adjusted;
    compensation = (next - total) - adjusted;
    total = next;
  }
  return total;
}

export function assertUnitMass(probabilities: Iterable<number>): number {
  const values = [...probabilities];
  if (values.some((p) => !Number.isFinite(p) || p < 0)) throw new Error('概率包含无效值');
  const mass = sum(values);
  if (Math.abs(mass - 1) > 1e-10) throw new Error(`概率质量不守恒：${mass}`);
  return mass;
}

/** The lucky reroll uses [1, firstCost), not a new draw from the original range. */
export function nominalCost(upperExclusive: number, lucky: number): readonly Mass<number>[] {
  if (!Number.isInteger(upperExclusive) || upperExclusive <= 1) throw new Error('无效费用上界');
  const masses = new Float64Array(upperExclusive);
  const first = 1 / (upperExclusive - 1);
  for (let cost = 1; cost < upperExclusive; cost++) {
    masses[cost] += first * (1 - lucky);
    if (cost === 1) masses[1] += first * lucky;
    else for (let lower = 1; lower < cost; lower++) masses[lower] += first * lucky / (cost - 1);
  }
  const result = Array.from(masses, (probability, value) => ({ value, probability })).filter((row) => row.probability > 0);
  assertUnitMass(result.map((row) => row.probability));
  return result;
}

export function preservedFp(before: number, charged: number, chance: number): readonly Mass<number>[] {
  if (charged >= before) return [{ value: charged, probability: 1 }];
  if (charged < 2 && before > 2) {
    return charged === 0 ? [
      { value: 2, probability: chance },
      { value: 1, probability: (1 - chance) * chance },
      { value: 0, probability: (1 - chance) ** 2 },
    ] : [
      { value: 2, probability: chance },
      { value: charged, probability: 1 - chance },
    ];
  }
  if (charged === 0 && before > 1) return [
    { value: 1, probability: chance }, { value: 0, probability: 1 - chance },
  ];
  return [{ value: charged, probability: 1 }];
}

export function costKernel(before: number, upperExclusive: number, fpType: FpType, hope: boolean,
  parameters: { hope: number; ice: number; luckyCost: number; lowFpPreservation: number }): readonly Mass<number>[] {
  const free = 1 - (1 - (hope ? parameters.hope : 0)) * (1 - (fpType === 'ICE' ? parameters.ice : 0));
  const outcomes = new Map<number, number>();
  const add = (fp: number, p: number) => outcomes.set(fp, (outcomes.get(fp) ?? 0) + p);
  if (free > 0) add(before, free);
  for (const cost of nominalCost(upperExclusive, parameters.luckyCost)) {
    for (const final of preservedFp(before, Math.max(0, before - cost.value), parameters.lowFpPreservation)) {
      add(final.value, (1 - free) * cost.probability * final.probability);
    }
  }
  const result = [...outcomes].map(([value, probability]) => ({ value, probability })).filter((row) => row.probability > 0);
  assertUnitMass(result.map((row) => row.probability));
  return result;
}

/** Same fee law with an arithmetic enclosure for every probability. */
export function boundedCostKernel(before: number, upperExclusive: number, fpType: FpType, hope: boolean,
  parameters: { hope: number; ice: number; luckyCost: number; lowFpPreservation: number }): readonly (Mass<number> & { bounds: Interval })[] {
  const free = exact(hope ? parameters.hope : 0).complement()
    .mul(exact(fpType === 'ICE' ? parameters.ice : 0).complement()).complement();
  const costs = Array.from({ length: upperExclusive }, () => ZERO);
  const first = ratio(1, upperExclusive - 1);
  const lucky = exact(parameters.luckyCost);
  for (let cost = 1; cost < upperExclusive; cost++) {
    costs[cost] = costs[cost].add(first.mul(lucky.complement()));
    if (cost === 1) costs[1] = costs[1].add(first.mul(lucky));
    else for (let lower = 1; lower < cost; lower++) {
      costs[lower] = costs[lower].add(first.mul(lucky).div(exact(cost - 1)));
    }
  }
  const results = new Map<number, Interval>();
  const add = (fp: number, bounds: Interval) => results.set(fp, (results.get(fp) ?? ZERO).add(bounds));
  add(before, free);
  const preserve = exact(parameters.lowFpPreservation);
  for (let cost = 1; cost < costs.length; cost++) {
    const charged = Math.max(0, before - cost);
    const base = free.complement().mul(costs[cost]);
    if (charged < 2 && before > 2) {
      add(2, base.mul(preserve));
      if (charged === 0) {
        add(1, base.mul(preserve.complement()).mul(preserve));
        add(0, base.mul(preserve.complement()).mul(preserve.complement()));
      } else add(charged, base.mul(preserve.complement()));
    } else if (charged === 0 && before > 1) {
      add(1, base.mul(preserve));
      add(0, base.mul(preserve.complement()));
    } else add(charged, base.mul(ONE));
  }
  return [...results].filter(([, bounds]) => bounds.upper > 0).map(([value, bounds]) => ({ value, probability: bounds.midpoint, bounds }));
}

export function tierPermutations(tiers: readonly number[]): readonly (readonly number[])[] {
  const counts = new Map<number, number>();
  for (const tier of tiers) counts.set(tier, (counts.get(tier) ?? 0) + 1);
  const values = [...counts.keys()].sort((a, b) => a - b);
  const result: number[][] = [];
  const walk = (prefix: number[]) => {
    if (prefix.length === tiers.length) { result.push(prefix); return; }
    for (const value of values) {
      const left = counts.get(value) ?? 0;
      if (left === 0) continue;
      counts.set(value, left - 1);
      walk([...prefix, value]);
      counts.set(value, left);
    }
  };
  walk([]);
  return result;
}
