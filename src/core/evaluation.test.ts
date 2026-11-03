import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Catalog, MODEL_ID } from './catalog';
import { reportRoute, RouteEvaluator, SamplingRequiredError } from './evaluation';
import { Interval, ZERO } from './interval';
import { RuleEngine } from './rules';
import type { Item, Macro, PlanRequest, Route } from './types';

const catalog = new Catalog();
const engine = new RuleEngine(catalog);
const read = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const payload = read('research/7710-route-cases.json');
const references = read('research/7710-route-results.json').profiles.find((row: { id: string }) => row.id === 'display_parameters_iid').scenarios;

function request(item: Item, ids: number[] = [4, 5]): PlanRequest {
  return { modelId: MODEL_ID, item, craftingContext: { playerLevel: 100 },
    target: { requirements: ids.map((id) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) },
    constraints: {}, scoring: {}, search: { milliseconds: 10000, maxRoutes: 100, macroStages: 12, maxStates: 100000 } };
}

function simple(rows: number[][], fpType: Item['fpType'] = 'NORMAL'): Item {
  return { baseId: '4:0', itemLevel: 100, fpType, corrupted: false,
    affixes: rows.map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: 73 })) };
}

function translate(steps: string[], a: number, b: number): Macro[] {
  const side = catalog.side(b);
  if (side === 2) throw new Error('Example requires ordinary side');
  const selector = { side, excludedIds: [a, b], minTier: 1, maxTier: 4 };
  return steps.map((step): Macro => {
    if (step === 'ADD_A' || step === 'ADD_B') return { kind: 'once', action: { kind: 'add', id: step === 'ADD_A' ? a : b, glyph: 'hope' } };
    if (step === 'SEAL_CURRENT_JUNK') return { kind: 'seal', selector: { ...selector, maxTier: steps.includes('PREPARE_HAVOC') ? 1 : 4 } };
    if (step === 'PREPARE_HAVOC') return { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' },
      until: { kind: 'exists', selector: { ...selector, maxTier: 1 } } };
    return { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
  });
}

describe('complete fixed routes using production atomic rules', () => {
  for (const caseIndex of [0, 1]) for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
    it(`matches the independent Python full-route curve: case${caseIndex}/${fpType}`, () => {
      const example = payload.cases[caseIndex];
      const source = example.routes[0];
      const start = simple(example.initialAffixes.map((row: { id: number; tier: number }) => [row.id, row.tier]), fpType);
      const input = request(start, [example.targetAId, example.targetBId]);
      const route: Route = { id: source.id, macros: translate(source.steps, example.targetAId, example.targetBId) };
      const report = reportRoute(engine, input, route);
      const expected = references.find((row: { caseId: string; routeId: string; fpType: string }) => row.caseId === example.id && row.routeId === source.id && row.fpType === fpType);
      for (let fp = 0; fp <= 63; fp++) {
        const actual = report.curve[fp];
        const target = expected.points[fp];
        const p = (target.successProbability.lower + target.successProbability.upper) / 2;
        expect(actual.successProbability.lower).toBeLessThanOrEqual(p + 1e-13);
        expect(actual.successProbability.upper).toBeGreaterThanOrEqual(p - 1e-13);
        expect(actual.successProbability.upper - actual.successProbability.lower).toBeLessThan(1e-9);
        expect((actual.expectedFp.lower + actual.expectedFp.upper) / 2).toBeCloseTo((target.expectedActualFpSpent.lower + target.expectedActualFpSpent.upper) / 2, 9);
      }
      expect(report.attemptsByMacro).toHaveLength(source.steps.length);
      const stageCost = report.macroStatistics.reduce((sum, row) => sum + (row.expectedFp.lower + row.expectedFp.upper) / 2, 0);
      expect(stageCost).toBeCloseTo((report.expectedFp.lower + report.expectedFp.upper) / 2, 9);
      expect(report.macroStatistics.every((row) => row.executedProbability.lower <= row.reachedProbability.upper)).toBe(true);
      expect(report.consumption).toHaveLength(64);
    });
  }

  it('matches every existing-A pattern including x7 and the invalid x0 recipe', () => {
    const fixtures = read('research/common-pattern-cases.json');
    const expected = read('research/common-pattern-results.json').profiles[0].scenarios;
    for (const example of [...fixtures.cases, ...fixtures.negativeCases]) {
      const start = simple(example.initialAffixes.map((row: { id: number; tier: number }) => [row.id, row.tier]));
      const route: Route = { id: example.routes[0].id, macros: translate(example.routes[0].steps, example.targetAId, example.targetBId) };
      const input = request(start, [example.targetAId, example.targetBId]);
      const report = reportRoute(engine, input, route);
      const reference = expected.find((row: { caseId: string; fpType: string }) => row.caseId === example.id && row.fpType === 'NORMAL');
      expect((report.score.lower + report.score.upper) / 2).toBeCloseTo((reference.scoreUniformFp1To63.lower + reference.scoreUniformFp1To63.upper) / 2, 10);
      for (let fp = 0; fp <= 63; fp++) {
        const actual = report.curve[fp].successProbability;
        const target = reference.points[fp].successProbability;
        expect((actual.lower + actual.upper) / 2).toBeCloseTo((target.lower + target.upper) / 2, 10);
      }
    }
  });

  it('has no subsequent actions after a necessary seal fails or Removal misses', () => {
    const start = simple([[4, 7], [5, 7], [7, 2], [10, 1]]);
    const target = { requirements: [{ ids: [7], minTier: 2, maxTier: 2, slot: 'sealed' as const }] };
    const route: Route = { id: 'seal_then_impossible_add', macros: [
      { kind: 'once', action: { kind: 'seal', id: 7 } },
      { kind: 'once', action: { kind: 'add', id: 7, glyph: 'hope' } },
    ] };
    const evaluated = new RouteEvaluator(engine, { ...request(start), target }, route).evaluate(1);
    expect(evaluated.attempts[1].upper).toBe(0);
    expect(evaluated.reasons.get('REQUIRED_SEAL_FAILED')?.midpoint).toBeCloseTo(0.31, 12);
    const removal: Route = { id: 'remove_then_add', macros: [
      { kind: 'once', action: { kind: 'removal', glyph: 'none', acceptedIds: [] } },
      { kind: 'once', action: { kind: 'add', id: 2, glyph: 'hope' } },
    ] };
    const missed = new RouteEvaluator(engine, { ...request(start), target }, removal).evaluate(1);
    expect(missed.attempts[1].upper).toBe(0);
    expect(missed.reasons.get('UNACCEPTED_REMOVAL')?.midpoint).toBeCloseTo(1, 12);
  });

  it('distinguishes reaching a later stage at FP0 from executing it after a T2 seal', () => {
    const start = simple([[4, 7], [5, 7], [7, 2], [10, 1]]);
    const input: PlanRequest = { ...request(start), scoring: { maximumFp: 1 }, target: { requirements: [
      { ids: [7], minTier: 2, maxTier: 2, slot: 'sealed' }, { ids: [8], minTier: 1, slot: 'ordinary' },
    ] } };
    const route: Route = { id: 'hand-calculated-stage-rewards', macros: [
      { kind: 'once', action: { kind: 'seal', id: 7 } }, { kind: 'once', action: { kind: 'add', id: 8, glyph: 'hope' } },
    ] };
    const report = reportRoute(engine, input, route);
    const first = report.macroStatistics[0];
    const next = report.macroStatistics[1];
    const middle = (value: { lower: number; upper: number }) => (value.lower + value.upper) / 2;
    expect(middle(first.reachedProbability)).toBeCloseTo(1, 12);
    expect(middle(first.executedProbability)).toBeCloseTo(1, 12);
    // Successful seal pays the final FP; failed seal is settled, and a 12% critical can refund it.
    expect(middle(first.expectedFp)).toBeCloseTo(1 - 0.31 * 0.12, 12);
    expect(middle(next.reachedProbability)).toBeCloseTo(0.69, 12);
    expect(next.executedProbability.upper).toBe(0);
    expect(next.expectedFp.upper).toBe(0);
    expect(next.expectedFpGivenReached?.upper).toBe(0);
    expect(next.expectedAttemptsGivenReached?.upper).toBe(0);
  });

  it('counts a skipped macro once on entry and never mutates the cached following stage', () => {
    const input = { ...request(simple([[4, 2], [7, 7], [10, 1]]), [4]), scoring: { maximumFp: 10 },
      target: { requirements: [{ ids: [4], minTier: 5, slot: 'ordinary' as const }] } };
    const route: Route = { id: 'skip-then-add', macros: [
      { kind: 'upgrade', id: 4, tier: 2, glyph: 'hope' },
      { kind: 'once', action: { kind: 'add', id: 5, glyph: 'hope' } },
    ] };
    const evaluator = new RouteEvaluator(engine, input, route);
    const first = evaluator.evaluate(10);
    expect(first.reached.map((value) => value.midpoint)).toEqual([1, 1]);
    expect(first.executed.map((value) => value.midpoint)).toEqual([0, 1]);
    expect(first.spent[0].upper).toBe(0);
    expect(first.spent[1].lower).toBeGreaterThan(0);
    expect(evaluator.evaluate(10)).toEqual(first);
    const complete = new RouteEvaluator(engine, { ...input, target: { requirements: [{ ids: [4], minTier: 2, slot: 'ordinary' }] } }, route).evaluate(10);
    expect(complete.reached.every((value) => value.upper === 0)).toBe(true);
  });

  it('counts success at FP0 before exhaustion, including the empty route', () => {
    const achieved = simple([[4, 7], [5, 7]]);
    const empty: Route = { id: 'done', macros: [] };
    const evaluated = new RouteEvaluator(engine, request(achieved), empty).evaluate(0);
    expect(evaluated.success[0].midpoint).toBe(1);
    const pending = simple([[4, 7], [5, 1], [7, 7], [10, 1]]);
    const havoc: Route = { id: 'one', macros: [{ kind: 'once', action: { kind: 'havoc', glyph: 'none' } }] };
    const result = new RouteEvaluator(engine, request(pending), havoc).evaluate(1);
    expect(result.success[0].midpoint).toBeCloseTo(1 / 5, 13);
  });

  it('retains explicit attempt limits and never turns Redemption into a fixed-p geometric loop', () => {
    const start = simple([[2, 7], [26, 7], [7, 3], [10, 2]]);
    const route: Route = { id: 'redemption', macros: [{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'target' } }] };
    expect(() => new RouteEvaluator(engine, request(start), route).evaluate(1)).toThrow(SamplingRequiredError);
    const limited = new RouteEvaluator(engine, { ...request(start), constraints: { maxAttempts: 1 } }, route).evaluate(1);
    const success = limited.success.reduce((value, row) => value.add(row), ZERO);
    expect(success.midpoint).toBeCloseTo(0.00865650977675952, 13);
    expect(limited.attempts[0].midpoint).toBeCloseTo(1, 13);
  });

  it('returns total and success-conditional consumption distributions with coherent moments', () => {
    const start = simple([[4, 7], [5, 1], [7, 7], [10, 1]]);
    const route: Route = { id: 'havoc', macros: [{ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } }] };
    const report = reportRoute(engine, request(start), route);
    const total = report.consumption.reduce((value, row) => value.add(new Interval(row.success.lower, row.success.upper)).add(new Interval(row.failure.lower, row.failure.upper)), ZERO);
    expect(total.lower).toBeLessThanOrEqual(1);
    expect(total.upper).toBeGreaterThanOrEqual(1);
    expect(report.successQuantiles?.p50.upper).toBeLessThanOrEqual(report.successQuantiles!.p95.upper);
    expect(report.expectedFpGivenSuccess!.upper).toBeLessThanOrEqual(63 + 1e-9);
  });
});
