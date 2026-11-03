import { describe, expect, it } from 'vitest';
import { commonRoutes, macroLibrary, routeId, routeSpace } from './candidates';
import { exampleRequest } from './examples';
import { macroStep, predicateReached, reportRoute } from './evaluation';
import { MODEL_ID } from './catalog';
import { plan, planFiniteBaseline, PlanningCancelledError } from './planner';
import { parsePlanRequest } from './request';
import { RuleEngine } from './rules';
import type { Macro, PlanRequest, Route } from './types';

describe('strict input and the fixed candidate language', () => {
  it('rejects malformed payloads and unsupported constraints before allocating a search', async () => {
    for (const input of [null, [], {}, { ...exampleRequest(), scoring: { maximumFp: Infinity } },
      { ...exampleRequest(), constraints: { inventory: { 4: 1 } } },
      { ...exampleRequest(), item: { ...exampleRequest().item, remainingFP: 45 } }]) {
      const result = await plan(input);
      expect(result.status).toBe('INVALID_INPUT');
      expect(result.searchStatus).toBe('NOT_STARTED');
      expect(result.search.evaluatedRoutes).toBe(0);
    }
    expect(parsePlanRequest({ ...exampleRequest(), modelId: 'old' }).issues.some((row) => row.code === 'MODEL_MISMATCH')).toBe(true);
  });

  it('includes both common preparation recipes without re-adding an already-owned target', () => {
    const engine = new RuleEngine();
    const original = commonRoutes(exampleRequest('7710-direct'), engine);
    expect(original.some((route) => route.macros.length === 4 && route.macros[0].kind === 'once' && route.macros[1].kind === 'seal')).toBe(true);
    const existing = commonRoutes(exampleRequest('7713-prepare'), engine);
    expect(existing.some((route) => route.macros.length === 4 && route.macros[0].kind === 'repeat' && route.macros[1].kind === 'seal')).toBe(true);
    expect(existing.every((route) => route.macros.every((macro) => !(macro.kind === 'once' && macro.action.kind === 'add' && macro.action.id === 4)))).toBe(true);
  });

  it('retains non-target filler identities and complicated inputs in the general grammar', () => {
    const engine = new RuleEngine();
    const input = exampleRequest('7732-missing');
    const library = macroLibrary(input, engine, commonRoutes(input, engine));
    expect(library.some((macro) => macro.kind === 'once' && macro.action.kind === 'add' && macro.action.id === 8)).toBe(true);
    expect(library.some((macro) => macro.kind === 'repeat' && macro.action.kind === 'redemption')).toBe(true);
    expect(library.some((macro) => macro.kind === 'chaos')).toBe(true);
    expect(library.some((macro) => macro.kind === 'removal')).toBe(true);
    expect(library.length).toBeGreaterThan(100);
  });

  it('uses complete seal eligibility when selecting garbage or testing a preparation subgoal', () => {
    const engine = new RuleEngine();
    const input: PlanRequest = { ...exampleRequest(), item: { ...exampleRequest().item,
      affixes: [[673, 1], [2, 1], [7, 7], [10, 7]].map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: 0 })) } };
    const step = macroStep({ kind: 'seal', selector: { side: 0, minTier: 1, maxTier: 1 } }, input.item, input, engine);
    expect(typeof step).toBe('object');
    if (typeof step === 'object') expect(step.action).toEqual({ kind: 'seal', id: 2 });
    const onlyExperimental = { ...input.item, affixes: input.item.affixes.map((row) => row.id === 2 ? { ...row, tier: 7 } : row) };
    expect(predicateReached(onlyExperimental, { kind: 'exists', selector: { side: 0, minTier: 1, maxTier: 1, sealable: true } }, input, engine)).toBe(false);
  });

  it('charges FP on a legal repeated Havoc even if the requested subgoal cannot ever occur', () => {
    const engine = new RuleEngine();
    const input = { ...exampleRequest('7732-missing'), scoring: { maximumFp: 10 } };
    const route: Route = { id: 'unreachable-only-havoc', macros: [{ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } }] };
    const report = reportRoute(engine, input, route);
    expect(report.score.upper).toBe(0);
    expect((report.curve[10].expectedFp.lower + report.curve[10].expectedFp.upper) / 2).toBeCloseTo(10, 10);
    expect(report.attemptsByMacro[0].lower).toBeGreaterThan(1);
  });
});

describe('bounded search and safe pruning', () => {
  const add: Macro = { kind: 'once', action: { kind: 'add', id: 4, glyph: 'hope' } };
  const upgrade: Macro = { kind: 'upgrade', id: 4, tier: 2, glyph: 'hope' };
  const small: PlanRequest = { modelId: MODEL_ID, item: { baseId: '4:0', itemLevel: 100, corrupted: false, fpType: 'NORMAL', affixes: [] },
    craftingContext: { playerLevel: 100 }, target: { requirements: [{ ids: [4], minTier: 2, maxTier: 2, slot: 'ordinary' }] },
    constraints: {}, scoring: { maximumFp: 3 }, search: { milliseconds: 10000, maxRoutes: 100, maxStates: 100000, macroStages: 2 } };

  it('matches a separate exhaustive Cartesian baseline with pruning enabled and disabled', async () => {
    const engine = new RuleEngine();
    const brute: Route[] = [[], [add], [upgrade], [add, add], [add, upgrade], [upgrade, add], [upgrade, upgrade]]
      .map((macros) => ({ id: routeId(macros), macros }));
    const expected = brute.map((route) => reportRoute(engine, small, route)).sort((a, b) => b.scoreEstimate - a.scoreEstimate)[0];
    const withPruning = await plan(small, { library: [add, upgrade], now: () => 0 });
    const without = await plan(small, { library: [add, upgrade], now: () => 0, disableCertifiedPruning: true });
    expect(withPruning.searchStatus).toBe('COMPLETE');
    expect(withPruning.primary?.scoreEstimate).toBeCloseTo(expected.scoreEstimate, 12);
    expect(withPruning.primary?.route).toEqual(without.primary?.route);
    expect(withPruning.search.certifiedPrunedPrefixes).toBeGreaterThan(0);
    expect(withPruning.optimality).toBe('PROVEN_WITHIN_DECLARED_SCOPE');
    expect(withPruning.search.candidateUpperBound).toBe('7');
  });

  it('does not replace a route/state budget cutoff with an impossibility claim', async () => {
    const result = await plan({ ...small, search: { ...small.search, maxRoutes: 1 } }, { library: [add, upgrade], now: () => 0 });
    expect(result.searchStatus).toBe('INCOMPLETE');
    expect(result.status).toBe('NO_ROUTE_FOUND_IN_SCOPE');
    expect(result.search.stopReason).toBe('ROUTE_BUDGET');
    expect(result.optimality).toBe('NOT_PROVEN');
  });

  it('supports cancellation and invalid/immutable slot targets without relaxing them', async () => {
    await expect(plan(small, { signal: { aborted: true } })).rejects.toBeInstanceOf(PlanningCancelledError);
    const invalid = await plan({ ...small, target: { requirements: [{ ids: [4], minTier: 8, slot: 'primordial' }] } });
    expect(invalid.status).toBe('INVALID_INPUT');
    expect(invalid.issues.some((issue) => issue.code === 'UNSUPPORTED_SLOT_OPERATION')).toBe(true);
  });

  it('uses a single fixed route across the complete FP domain and is reproducible in a fixed search scope', async () => {
    const first = await plan(small, { library: [add, upgrade], now: () => 0 });
    const second = await plan(small, { library: [add, upgrade], now: () => 0 });
    expect(second).toEqual(first);
    expect(first.conventions.fpDomain).toEqual([1, 2, 3]);
    expect(first.primary?.curve).toHaveLength(4);
    expect(first.conventions.materials).toBe('UNLIMITED');
  });

  it('evaluates complex 7732 Redemption as a state-changing loop and reports estimated precision', async () => {
    const input: PlanRequest = { ...exampleRequest('7732-missing'), scoring: { maximumFp: 10 },
      search: { ...exampleRequest().search, maxRoutes: 3 } };
    const result = await planFiniteBaseline(input, { now: () => 0, screeningSamplesPerFp: 128, finalSamplesPerFp: 256, seed: 'planner7732' });
    expect(result.status).toBe('RECOMMENDATION');
    expect(result.primary?.evaluationStatus).toBe('ESTIMATED');
    expect(result.primary?.sampling?.samplesPerFp).toBe(256);
    expect(result.samplingGuarantee).toEqual({ scope: 'ALL_STATISTICAL_REPORTS_IN_ONE_PLANNING_CALL_UNDER_IID',
      confidence: 0.99, maximumReports: 6, reportConfidence: 1 - 0.01 / 6 });
    expect(result.primary?.sampling?.confidence).toBe(result.samplingGuarantee?.reportConfidence);
    expect(result.primary!.scoreEstimate).toBeGreaterThan(0);
    expect(result.optimality).toBe('NOT_PROVEN');
    expect(result.searchStatus).toBe('INCOMPLETE');
  });

  it('retains a declared, finite grammar even when all longer paths are pruned', () => {
    const space = routeSpace([add, upgrade], 2);
    expect([...space.routes]).toHaveLength(6); // Only the duplicate idempotent upgrade is structurally dominated.
    expect(space.candidateUpperBound).toBe('7');
  });
});
