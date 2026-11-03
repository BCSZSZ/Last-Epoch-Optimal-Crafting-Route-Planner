import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuleEngine } from './rules';
import type { Item } from './types';

const reference: {
  seal: { rawChancePercent: { exalted: number[][]; ordinary: number[][] } };
  fp: { rows: Record<Item['fpType'], string[][]>; displayedMeanFp: Record<Item['fpType'], string>;
    displayedCriticalPercent: Record<Item['fpType'], string> };
  havoc: { cases: { currentTiers: number[]; displayedChancePercent: string; displayedAttempts: string;
    displayedMeanFp: string; displayedUntilTargetFp: string }[] };
} = JSON.parse(readFileSync(new URL('../../research/reference-calculators.json', import.meta.url), 'utf8'));

function item(rows: number[][], fpType: Item['fpType'] = 'NORMAL'): Item {
  return { baseId: '4:0', itemLevel: 100, fpType, corrupted: false,
    affixes: rows.map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: 128 })) };
}

function matchesRounded(actual: number, displayed: string, scale = 1): void {
  const digits = (displayed.split('.')[1] ?? '').length;
  expect(Math.abs(actual - Number(displayed) / scale)).toBeLessThanOrEqual(0.5 * 10 ** -digits / scale + 1e-12);
}

describe('applicable published calculator outputs, supplementary to local native evidence', () => {
  it('matches all 32 published sealing thresholds with native probability saturation', () => {
    const engine = new RuleEngine();
    for (const exalted of [false, true]) for (let count = 1; count <= 4; count++) for (let tier = 1; tier <= 4; tier++) {
      const initial = item([4, 5, 7, 10].slice(0, count).map((id, i) => [id, i === 0 ? tier : 1]));
      const input: Item = exalted ? { ...initial, affixes: [...initial.affixes, { id: 26, tier: 8, slot: 'primordial', roll: 128 }] } : initial;
      const expected = reference.seal.rawChancePercent[exalted ? 'exalted' : 'ordinary'][tier - 1][count - 1] / 100;
      expect(engine.sealChance(input, 4)).toBeCloseTo(Math.min(1, expected), 12);
    }
  });

  it('matches the complete displayed upgrade-cost PMF for Normal, Ice and Blood at high FP', () => {
    const engine = new RuleEngine();
    for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
      const distribution = engine.transition(item([[4, 1], [7, 7], [10, 1]], fpType), 63,
        { kind: 'upgrade', id: 4, glyph: 'hope' }, { playerLevel: 100 });
      expect(distribution.issues).toEqual([]);
      const pmf = Array<number>(10).fill(0);
      let critical = 0;
      for (const outcome of distribution.outcomes) { pmf[63 - outcome.fp] += outcome.probability; critical += Number(outcome.critical) * outcome.probability; }
      let cdf = 0;
      for (const [index, row] of reference.fp.rows[fpType].entries()) {
        cdf += pmf[index];
        matchesRounded(pmf[index], row[1].replace('%', ''), 100);
        matchesRounded(cdf, row[2].replace('%', ''), 100);
      }
      matchesRounded(pmf.reduce((sum, p, cost) => sum + p * cost, 0), reference.fp.displayedMeanFp[fpType]);
      matchesRounded(critical, reference.fp.displayedCriticalPercent[fpType], 100);
    }
  });

  it('matches repeated-tier, unequal-tier and three-T7 Havoc reference cases', () => {
    const engine = new RuleEngine();
    for (const entry of reference.havoc.cases) {
      const initial = item([4, 5, 7, 10].map((id, index) => [id, entry.currentTiers[index]]));
      const distribution = engine.transition(initial, 63, { kind: 'havoc', glyph: 'hope' }, { playerLevel: 100 });
      expect(distribution.issues).toEqual([]);
      let probability = 0;
      let cost = 0;
      for (const outcome of distribution.outcomes) {
        if ([4, 5].every((id) => outcome.item.affixes.some((row) => row.id === id && row.tier === 7))) probability += outcome.probability;
        cost += outcome.probability * (63 - outcome.fp);
      }
      matchesRounded(probability, entry.displayedChancePercent, 100);
      matchesRounded(cost, entry.displayedMeanFp);
      // These two are infinite-budget reference quantities, never the actual finite-F macro report.
      matchesRounded(1 / probability, entry.displayedAttempts);
      matchesRounded(cost / probability, entry.displayedUntilTargetFp);
    }
  });
});
