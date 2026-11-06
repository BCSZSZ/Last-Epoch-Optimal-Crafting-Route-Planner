import { describe, expect, it } from 'vitest';
import { exampleRequest } from './examples';
import { macroStep } from './evaluation';
import { IntrinsicWorkspace, evaluateIntrinsic, practicalDecision } from './intrinsic';
import { hierarchyFixtures } from './hierarchy-fixtures';
import { compileTemplates } from './hierarchy';
import { plan } from './planner';
import { seededRandom } from './random';
import { RuleEngine } from './rules';
import type { DemandDistribution } from './rules';
import { targetReached } from './target';
import type { AtomicAction, FpType, Item, Macro, PlanRequest, Route } from './types';

const middle = (value: { lower: number; upper: number }) => (value.lower + value.upper) / 2;
const final: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
function guarded(): Route {
  const selector = { side: 0 as const, excludedIds: [4, 5], minTier: 1, maxTier: 1, sealable: true };
  return { id: '7710-guarded', macros: [add(4), { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector } },
    { kind: 'seal', selector }, add(5), final] };
}

describe('joint reward projection and intrinsic reference calculations', () => {
  for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) it(`${fpType}: agrees with all-63 atomic projections and the independent 7710 mean`, () => {
    const engine = new RuleEngine();
    const request = { ...exampleRequest(), item: { ...exampleRequest().item, fpType } };
    const action: AtomicAction = { kind: 'add', id: 4, glyph: 'hope' };
    const projected = engine.demandTransition(request.item, action, request.craftingContext);
    const full = engine.transition(request.item, 63, action, request.craftingContext);
    const fp = full.outcomes.reduce((sum, row) => sum + row.probability * (63 - row.fp), 0);
    expect(projected.issues).toEqual([]);
    expect(projected.outcomes.reduce((sum, row) => sum + middle(row.probability), 0)).toBeCloseTo(1, 12);
    expect(projected.outcomes.reduce((sum, row) => sum + middle(row.fpMoment), 0)).toBeCloseTo(fp, 12);
    const result = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), guarded());
    const expected: Record<FpType, number> = { NORMAL: 48.8048922892, ICE: 34.16342460245, BLOOD: 49.91787674745 };
    expect(result.score).toEqual({ lower: 1, upper: 1 });
    expect(middle(result.expectedFpGivenSuccess!)).toBeCloseTo(expected[fpType], 7);
  });

  it('does not discard the 20%-success, 1FP route when the prefix mean is 120.2FP', () => {
    class SelectionEngine extends RuleEngine {
      override demandTransition(item: Item, action: AtomicAction): DemandDistribution {
        if (action.kind === 'upgrade') return { issues: [], outcomes: [
          { item: { ...item, affixes: [{ id: 4, tier: 3, slot: 'ordinary', roll: null }] }, abort: null,
            probability: { lower: 0.8, upper: 0.8 }, fpMoment: { lower: 120, upper: 120 } },
          { item: { ...item, affixes: [{ id: 4, tier: 2, slot: 'ordinary', roll: null }] }, abort: null,
            probability: { lower: 0.2, upper: 0.2 }, fpMoment: { lower: 0.2, upper: 0.2 } },
        ] };
        return { issues: [], outcomes: [{ item, abort: 'REQUIRED_SEAL_FAILED', probability: { lower: 1, upper: 1 }, fpMoment: { lower: 0, upper: 0 } }] };
      }
    }
    const base = exampleRequest(), request: PlanRequest = { ...base, item: { ...base.item, affixes: [{ id: 4, tier: 1, slot: 'ordinary', roll: null }] },
      target: { requirements: [{ ids: [4], minTier: 2, maxTier: 2, slot: 'ordinary' }] } };
    const result = evaluateIntrinsic(new IntrinsicWorkspace(new SelectionEngine(), request), { id: 'selection', macros: [
      { kind: 'once', action: { kind: 'upgrade', id: 4, glyph: 'hope' } }, add(5)] });
    expect(result.intrinsic.decision).toBe('RETAINED');
    expect(result.scoreEstimate).toBeCloseTo(0.2, 10);
    expect(middle(result.expectedFpGivenSuccess!)).toBeCloseTo(1, 10);
  });

  it('matches an independent trajectory evaluator, with no balance truncation or post-NG actions', () => {
    const request = exampleRequest(), route = guarded(), engine = new RuleEngine(), draw = seededRandom('intrinsic-independent-walk');
    const expected = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), route);
    let sum = 0, squares = 0;
    const trials = 12000;
    for (let sample = 0; sample < trials; sample++) {
      let item = request.item, stage = 0, spent = 0, guard = 0;
      while (!targetReached(item, request.target) && stage < route.macros.length && guard++ < 10000) {
        const step = macroStep(route.macros[stage], item, request, engine);
        if (step === 'SKIP') { stage++; continue; }
        if (step === 'INAPPLICABLE') throw new Error('Independent guard route was inapplicable');
        const result = engine.sample(item, 63, step.action, request.craftingContext, draw);
        if (!result.outcome || result.outcome.abort) throw new Error('Independent guard route unexpectedly failed');
        spent += 63 - result.outcome.fp; item = result.outcome.item;
        if (step.advance) stage++;
      }
      expect(guard).toBeLessThan(10000);
      sum += spent; squares += spent ** 2;
    }
    const estimate = sum / trials, se = Math.sqrt((squares / trials - estimate ** 2) / trials);
    expect(Math.abs(estimate - middle(expected.expectedFpGivenSuccess!))).toBeLessThan(6 * se);
  }, 30000);
});

describe('pruning, coverage and execution limits', () => {
  it('passes exact threshold equality and keeps numerical uncertainty unresolved', () => {
    expect(practicalDecision({ lower: 0.15, upper: 0.15 }, { lower: 65, upper: 65 })).toBe('RETAINED');
    expect(practicalDecision({ lower: 0.149, upper: 0.1499 }, { lower: 10, upper: 10 })).toBe('ABANDONED');
    expect(practicalDecision({ lower: 1, upper: 1 }, { lower: 65.0001, upper: 66 })).toBe('ABANDONED');
    expect(practicalDecision({ lower: 0.1499, upper: 0.1501 }, { lower: 64, upper: 66 })).toBe('UNRESOLVED');
    expect(practicalDecision({ lower: 1, upper: 1 }, { lower: 64.9999, upper: 65.0001 })).toBe('UNRESOLVED');
  });
  it('agrees with complete evaluation without prefix pruning for all 28 labels', async () => {
    for (const { label, request } of hierarchyFixtures()) {
      const withPruning = await plan(request, { now: () => 0 });
      const without = await plan(request, { now: () => 0, disableCertifiedPruning: true });
      expect(withPruning.primary?.route.id, label).toBe(without.primary?.route.id);
      expect(withPruning.primary?.scoreEstimate, label).toBeCloseTo(without.primary!.scoreEstimate, 10);
      expect(middle(withPruning.primary!.expectedFpGivenSuccess!), label).toBeCloseTo(middle(without.primary!.expectedFpGivenSuccess!), 8);
    }
  });
  it('retains the legal 16.67% bulk-removal route that sequential removal/addition would prune', async () => {
    const request = hierarchyFixtures().find((row) => row.label === '200-N4-S1')!.request;
    const report = await plan(request, { now: () => 0 });
    expect(report.primary!.scoreEstimate).toBeCloseTo(1 / 6, 10);
    const risks=report.primary!.route.macros.filter(m=>m.kind==='removal'||m.kind==='once'&&m.action.kind==='add');
    expect(risks.slice(0,2).map(m=>m.kind)).toEqual(['removal','removal']);
  });
  it('reports execution limits as incomplete, not abandoned', async () => {
    const request = { ...exampleRequest(), search: { ...exampleRequest().search, maxStates: 1, maxRoutes: 1 } };
    const result = await plan(request, { now: () => 0, intrinsicRoutes: [guarded()] });
    expect(result.searchStatus).toBe('INCOMPLETE');
    expect(result.unresolvedRoutes).toBe(1);
    expect(result.abandoned).toHaveLength(0);
  });
  it('rejects an ordinary target trapped in the sealed slot before allocating search states', async () => {
    const base = exampleRequest('7713-existing');
    const request = { ...base, item: { ...base.item, affixes: [...base.item.affixes, { id: 5, tier: 1, slot: 'sealed', roll: null }] } };
    const result = await plan(request);
    expect(result.status).toBe('INVALID_INPUT');
    expect(result.issues.some((row) => row.code === 'TARGET_ID_BLOCKED_BY_EXTRA_SLOT')).toBe(true);
    expect(result.search.evaluatedRoutes).toBe(0);
  });
  it('keeps missing-side preparation, Chaos reset/fallback, and the two-stage Redemption family', () => {
    const templates = compileTemplates(exampleRequest('7732-missing'), new RuleEngine())!.templates;
    const text = JSON.stringify(templates);
    expect(text).toContain('prepareWithHavoc');
    expect(text).toContain('CONTINUE');
    expect(templates.some((row) => row.family === 'REDEMPTION_PROTECTED_SECOND')).toBe(true);
  });
  it('abandons the formerly retained 70FP Ice Redemption loop under the new65FP cutoff', () => {
    const base = exampleRequest(), request: PlanRequest = { ...base, item: { ...base.item, baseId: '3:0', fpType: 'ICE',
      affixes: [[502, 7], [504, 7], [7, 3], [10, 2]].map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: null })) },
      target: { requirements: [28, 501].map((id) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) } };
    const result = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(), request), { id: 'boots', macros: [
      { kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'target' } }] });
    expect(result.score).toEqual({ lower: 1, upper: 1 });
    expect(result.intrinsic.decision).toBe('ABANDONED');
    expect(result.intrinsic.maximumSuccessFp).toBe(65);
    expect(result.intrinsic.successfulFpLowerBound).toBeGreaterThan(65);
    expect(result.intrinsic.successfulFpLowerBound).toBeLessThan(70.02430);
  }, 30000);
  it('certifies an expensive repeated route using a reward lower bound without pretending to finish its mean', () => {
    const request = exampleRequest('7732-missing');
    const result = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(), request), { id: 'expensive-repeat', macros: [
      { kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'target' } }] });
    expect(result.intrinsic.decision).toBe('ABANDONED');
    expect(result.score).toEqual({ lower: 1, upper: 1 });
    expect(result.intrinsic.successfulFpLowerBound).toBeGreaterThan(65);
    expect(result.intrinsic.successfulFpLowerBound).toBeLessThan(900.4417);
    expect(result.expectedFpGivenSuccess).toBeNull();
  });
  it('distinguishes terminating free loops from closed, non-terminating free classes', () => {
    for (const hit of [0, 0.5]) {
      class FreeEngine extends RuleEngine {
        override demandTransition(item: Item): DemandDistribution {
          const p = (value: number) => ({ lower: value, upper: value });
          return { issues: [], outcomes: [
            { item, abort: null, probability: p(1 - hit), fpMoment: p(0) },
            ...(hit ? [{ item: { ...item, affixes: [{ ...item.affixes[0], tier: 2 }] }, abort: null, probability: p(hit), fpMoment: p(0) }] : []),
          ] };
        }
      }
      const base = exampleRequest(), request: PlanRequest = { ...base, item: { ...base.item, affixes: [{ id: 4, tier: 1, slot: 'ordinary', roll: null }] },
        target: { requirements: [{ ids: [4], minTier: 2, slot: 'ordinary' }] } };
      const result = evaluateIntrinsic(new IntrinsicWorkspace(new FreeEngine(), request), { id: 'free', macros: [
        { kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'target' } }] });
      expect(result.scoreEstimate).toBe(hit ? 1 : 0);
      expect(result.intrinsic.decision).toBe(hit ? 'RETAINED' : 'ABANDONED');
      if (hit) expect(result.expectedFpGivenSuccess).toEqual({ lower: 0, upper: 0 });
      else expect(result.intrinsic.nonTerminatingStates).toBe(1);
    }
  });
  it('executes an explicit Chaos-exhaustion fallback, while default exhaustion stops', () => {
    const base = exampleRequest(), request: PlanRequest = { ...base, item: { ...base.item, affixes: [[4, 7], [2, 5], [7, 7], [10, 5]]
      .map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: null })) } };
    const chaos: Macro = { kind: 'chaos', selector: { side: 0, excludedIds: [4, 5], maxTier: 4 }, until: { ids: [5], minTier: 1, slot: 'ordinary' }, onExhausted: 'CONTINUE' };
    const suffix: Macro[] = [{ kind: 'removal', accepted: { ids: [2] }, glyph: 'hope' }, add(5), final];
    const kept = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(), request), { id: 'fallback', macros: [chaos, ...suffix] });
    expect(kept.intrinsic.decision).toBe('RETAINED');
    expect(kept.scoreEstimate).toBeCloseTo(0.25, 10);
    const stopped = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(), request), { id: 'abort', macros: [{ ...chaos, onExhausted: 'ABORT' }, ...suffix] });
    expect(stopped.intrinsic.decision).toBe('ABANDONED');
    expect(stopped.intrinsic.evaluatedThroughStage).toBe(1);
  });
});
