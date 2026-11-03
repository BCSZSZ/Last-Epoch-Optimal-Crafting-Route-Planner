import { describe, expect, it } from 'vitest';
import { exact, Interval, nextDown, nextUp, ONE, ratio, ZERO } from './interval';
import { boundedCostKernel } from './probability';
import { Catalog } from './catalog';
import { RuleEngine } from './rules';
import type { Item } from './types';

describe('arithmetic enclosures', () => {
  it('finds neighboring values through zero, negative values and infinities', () => {
    expect(nextUp(0)).toBe(Number.MIN_VALUE);
    expect(nextDown(0)).toBe(-Number.MIN_VALUE);
    expect(nextUp(-1)).toBeGreaterThan(-1);
    expect(nextDown(-1)).toBeLessThan(-1);
    expect(nextUp(Infinity)).toBe(Infinity);
    expect(nextDown(-Infinity)).toBe(-Infinity);
    expect(nextUp(nextDown(1))).toBe(1);
    expect(nextDown(nextUp(-1))).toBe(-1);
  });

  it('encloses hand rational values and preserves exact absorbing coefficients', () => {
    const sixth = ratio(1, 2).mul(ratio(1, 3));
    expect(sixth.lower).toBeLessThan(1 / 6);
    expect(sixth.upper).toBeGreaterThan(1 / 6);
    const one = sixth.mul(exact(6));
    expect(one.lower).toBeLessThanOrEqual(1);
    expect(one.upper).toBeGreaterThanOrEqual(1);
    expect(ONE.mul(ONE).complement()).toBe(ZERO);
    expect(ZERO.mul(ratio(1, 3))).toBe(ZERO);
    expect(() => ONE.div(new Interval(-1, 1))).toThrow();
  });

  it('encloses full fee mass and cannot manufacture a free paid-only craft', () => {
    const catalog = new Catalog();
    for (const type of ['NORMAL', 'ICE', 'BLOOD'] as const) {
      for (const hope of [false, true]) for (let fp = 1; fp <= 63; fp++) {
        const kernel = boundedCostKernel(fp, 20, type, hope, catalog.model.parameters);
        const total = kernel.reduce((value, row) => value.add(row.bounds), ZERO);
        expect(total.lower).toBeLessThanOrEqual(1);
        expect(total.upper).toBeGreaterThanOrEqual(1);
      }
    }
    expect(boundedCostKernel(63, 20, 'NORMAL', false, catalog.model.parameters).some((row) => row.value === 63)).toBe(false);
  });

  it('encloses an independent exact one-cast Redemption Fraction', () => {
    const start: Item = { baseId: '4:0', itemLevel: 100, fpType: 'NORMAL', corrupted: false,
      affixes: [[2, 7], [26, 7], [7, 3], [10, 2]].map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: 0 })) };
    const result = new RuleEngine().transition(start, 1, { kind: 'redemption', glyph: 'none' }, { playerLevel: 100 });
    const success = result.outcomes.filter((row) => [4, 5].every((id) => row.item.affixes.some((affix) => affix.id === id && affix.tier === 7)))
      .reduce((value, row) => value.add(new Interval(row.probabilityBounds.lower, row.probabilityBounds.upper)), ZERO);
    const witness = 140737488355328 / 16257994501799281;
    expect(success.lower).toBeLessThan(witness);
    expect(success.upper).toBeGreaterThan(witness);
    expect(success.width).toBeLessThan(1e-14);
  });
});
