import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_ID } from './catalog';
import { reportRoute } from './evaluation';
import { seededRandom } from './random';
import { RuleEngine } from './rules';
import { sampleRoute, simulateRoute, SamplingInterruptedError } from './sampling';
import type { Item, PlanRequest, Route } from './types';

function item(rows: readonly (readonly [number, number])[], fpType: Item['fpType'] = 'NORMAL'): Item {
  return { baseId: '4:0', itemLevel: 100, corrupted: false, fpType,
    affixes: rows.map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: 73 })) };
}
function request(start: Item): PlanRequest {
  return { modelId: MODEL_ID, item: start, craftingContext: { playerLevel: 100 },
    target: { requirements: [4, 5].map((id) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) },
    constraints: {}, scoring: {}, search: { milliseconds: 10000, maxRoutes: 100, maxStates: 100000, macroStages: 12 } };
}

describe('direct sampling through the single production rule implementation', () => {
  it('repeats the same stream deterministically without using Math.random', () => {
    const a = seededRandom('repeat');
    const b = seededRandom('repeat');
    const different = seededRandom('different');
    const words = Array.from({ length: 1000 }, () => a());
    expect(words).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(words.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(words).not.toEqual(Array.from({ length: 1000 }, () => different()));
  });

  it('samples correlated extra tiers and refunds consistently with the independent 7710 witness', () => {
    const engine = new RuleEngine();
    const start = item([[7, 7], [10, 7], [2, 1]]);
    const draw = seededRandom('add-7710');
    let critical = 0;
    let junkUpgraded = 0;
    let free = 0;
    for (let i = 0; i < 10000; i++) {
      const result = engine.sample(start, 63, { kind: 'add', id: 4, glyph: 'hope' }, { playerLevel: 100 }, draw);
      expect(result.issues).toEqual([]);
      const outcome = result.outcome!;
      critical += Number(outcome.critical);
      free += Number(outcome.fp === 63);
      junkUpgraded += Number(outcome.item.affixes.some((row) => row.id === 2 && row.tier === 2));
      if (outcome.critical) expect(outcome.fp).toBe(63);
    }
    expect(Math.abs(critical / 10000 - 0.12)).toBeLessThan(0.02);
    expect(Math.abs(free / 10000 - 0.34)).toBeLessThan(0.025);
    expect(Math.abs(junkUpgraded / 10000 - 0.06)).toBeLessThan(0.015);
  });

  it('proves protection before sampling, even if the supplied draw would remove a permitted ID', () => {
    const result = new RuleEngine().sample(item([[4, 7], [5, 7], [7, 1], [10, 1]]), 63,
      { kind: 'removal', glyph: 'hope', acceptedIds: [7, 10] }, { playerLevel: 100 }, () => 0.999,
      { constraints: { protected: [{ id: 4, identity: true }] } });
    expect(result.outcome).toBeNull();
    expect(result.issues[0].code).toBe('PROTECTION_RISK');
  });

  it('settles a failed necessary seal and stops before any later action', () => {
    const input = { ...request(item([[4, 7], [5, 7], [7, 2], [10, 1]])),
      target: { requirements: [{ ids: [7], minTier: 2, maxTier: 2, slot: 'sealed' as const }] } };
    const route: Route = { id: 'abort', macros: [
      { kind: 'once', action: { kind: 'seal', id: 7 } }, { kind: 'once', action: { kind: 'add', id: 2, glyph: 'hope' } },
    ] };
    const result = simulateRoute(new RuleEngine(), input, route, 63, () => 0.999);
    expect(result.reason).toBe('REQUIRED_SEAL_FAILED');
    expect(result.attempts).toEqual([1, 0]);
    expect(result.spent).toBe(0); // Complete failed action received the critical refund.
  });

  it('handles FP0 success and refuses to turn a computational guard into failure', () => {
    const completed = request(item([[4, 7], [5, 7]]));
    expect(simulateRoute(new RuleEngine(), completed, { id: 'done', macros: [] }, 0, seededRandom('zero')).success).toBe(true);
    const impossible = request(item([[2, 7], [26, 7], [7, 1], [10, 1]]));
    const route: Route = { id: 'no-identity-change', macros: [{ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } }] };
    expect(() => simulateRoute(new RuleEngine(), impossible, route, 63, () => 0, 2)).toThrow(SamplingInterruptedError);
  });

  it('evaluates a complete curve with simultaneous statistical bounds, conservation and reproducibility', () => {
    const input: PlanRequest = { ...request(item([[4, 7], [5, 1], [7, 7], [10, 1]])), scoring: { maximumFp: 15 } };
    const route: Route = { id: 'havoc-sampled', macros: [{ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } }] };
    const options = { samplesPerFp: 128, seed: 'curve-witness' };
    const engine = new RuleEngine();
    const report = sampleRoute(engine, input, route, options);
    const exact = reportRoute(engine, input, route);
    expect(report.evaluationStatus).toBe('ESTIMATED');
    expect(report.sampling?.totalTrials).toBe(15 * 128);
    expect(report.score.lower).toBeLessThan(exact.score.upper);
    expect(report.score.upper).toBeGreaterThan(exact.score.lower);
    expect(report.consumption.reduce((sum, row) => sum + row.successEstimate! + row.failureEstimate!, 0)).toBeCloseTo(1, 12);
    expect(report.quantiles!.p95.upper).toBeLessThanOrEqual(15);
    expect(report.curve.every((row) => row.quantiles!.p95.upper <= row.initialFp)).toBe(true);
    expect(report.sampling!.unobservedAttemptMeanBound).toBeLessThan(1e-30);
    expect(sampleRoute(engine, input, route, options)).toEqual(report);
  });

  it('agrees with the independently implemented Python repeated-Redemption reference', () => {
    const reference = JSON.parse(readFileSync(new URL('../../research/7732-redemption-reference.json', import.meta.url), 'utf8'));
    const expected = reference.rows.find((row: { fpType: string; initialFp: number }) => row.fpType === 'NORMAL' && row.initialFp === 63);
    const input = request(item([[2, 7], [26, 7], [7, 3], [10, 2]]));
    const route: Route = { id: 'redemption-loop', macros: [{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'target' } }] };
    const engine = new RuleEngine();
    const draw = seededRandom('independent-redemption-cross-check');
    let hits = 0;
    let spent = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) {
      const result = simulateRoute(engine, input, route, 63, draw);
      hits += Number(result.success); spent += result.spent;
    }
    const p = expected.estimatedSuccessProbability;
    const allowance = 5 * Math.sqrt(p * (1 - p) * (1 / n + 1 / expected.samples));
    expect(Math.abs(hits / n - p)).toBeLessThan(allowance);
    expect(Math.abs(spent / n - expected.actualFpSpent.mean)).toBeLessThan(0.8);
    const first = simulateRoute(engine, input, route, 63, seededRandom('coupled'));
    const blood = simulateRoute(engine, { ...input, item: { ...input.item, fpType: 'BLOOD' } }, route, 63, seededRandom('coupled'));
    expect(blood).toEqual(first);
  });
});
