import { describe, expect, it } from 'vitest';
import { classifyStructure, compileTemplates, UPPER_NODES } from './hierarchy';
import { hierarchyFixtures } from './hierarchy-fixtures';
import { exampleRequest } from './examples';
import { IntrinsicWorkspace, evaluateIntrinsic } from './intrinsic';
import { plan } from './planner';
import { RuleEngine } from './rules';
import { parsePlanRequest } from './request';
import { Catalog } from './catalog';
import type { Macro, PlanRequest, Route } from './types';
import { compileDraft, emptyDraft } from './draft';
import { catalogForInputModel } from './input-model';
import { evaluateCompletion } from './completion';

const final: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
const mean = (value: { lower: number; upper: number }) => (value.lower + value.upper) / 2;

describe('all 28 input labels / 23 upper routing nodes', () => {
  const fixtures = hierarchyFixtures();
  it('covers every legal occupancy/seal combination and validates actual catalog entries', () => {
    expect(fixtures).toHaveLength(28);
    expect(new Set(UPPER_NODES.map((row) => row.routeNode)).size).toBe(23);
    const engine = new RuleEngine();
    for (const fixture of fixtures) {
      expect(parsePlanRequest(fixture.request).issues, fixture.label).toEqual([]);
      expect(classifyStructure(fixture.request, engine)?.node.key, fixture.label).toBe(fixture.label);
      expect(compileTemplates(fixture.request, engine)?.templates.length, fixture.label).toBeGreaterThan(0);
    }
  });
  it('covers all 28 labels in all four target prefix/suffix contexts with real legal IDs', () => {
    const engine = new RuleEngine(), catalog = new Catalog();
    for (const targets of [[4, 5], [4, 7], [7, 4], [7, 10]] as const) for (const fixture of hierarchyFixtures(catalog, targets)) {
      expect(parsePlanRequest(fixture.request).issues).toEqual([]);
      expect(classifyStructure(fixture.request, engine)?.node.key).toBe(fixture.label);
      expect(compileTemplates(fixture.request, engine)?.templates.length).toBeGreaterThan(0);
    }
  });
  for (const fixture of fixtures) it(`${fixture.label}: end-to-end template search and certified metrics`, async () => {
    const report = await plan(fixture.request, { now: () => 0 });
    expect(report.metric).toBe('INTRINSIC_V2');
    expect(report.hierarchy?.structure.node.key).toBe(fixture.label);
    expect(report.status).toBe('RECOMMENDATION');
    expect(report.primary?.intrinsic?.decision).toBe('RETAINED');
    expect(report.primary!.score.lower).toBeGreaterThanOrEqual(0.15);
    expect(report.primary!.expectedFpGivenSuccess!.upper).toBeLessThanOrEqual(65);
    if (fixture.label.startsWith('220')) {
      expect(report.primary!.scoreEstimate).toBe(1);
      expect(report.primary!.expectedFpGivenSuccess).toEqual({ lower: 0, upper: 0 });
    }
  }, 60000);
});

describe('structural refinements and fixed templates', () => {
  it('includes a combined T1-or-T2 sealing stop and finds the better 7271 route within the default budget', async () => {
    const draft = emptyDraft();
    const { request } = compileDraft({ ...draft, part: 1, slots: { ...draft.slots,
      prefix1: { tier: 7, id: null }, prefix2: { tier: 2, id: null, isTarget: true },
      suffix1: { tier: 7, id: null }, suffix2: { tier: 1, id: null } },
      counts: [{ desired: 2 }, { desired: 0 }] }).scenarios[0];
    const engine = new RuleEngine(catalogForInputModel(request.inputModel));
    expect(compileTemplates(request, engine)!.templates.some(route => route.description?.includes('封T1至T2'))).toBe(true);
    const report = await plan({ ...request, search: { ...request.search, maxRoutes: 8, maxStates: 512 } }, { now: () => 0 });
    expect(report.primary!.scoreEstimate).toBeCloseTo(0.845, 10);
    expect(mean(report.primary!.expectedFpGivenSuccess!)).toBeCloseTo(55.6844776013, 8);
    const completion = evaluateCompletion(engine, request, report.primary!.route);
    expect(mean(completion.probability!)).toBeCloseTo(0.505516252429, 8);
    const protectedId = request.target.requirements[0].ids[0];
    const selector = { ids: [protectedId], minTier: 1, maxTier: 2, sealable: true };
    const impossible: Route = { id: 'sealed-existing-target', macros: [
      { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector } },
      { kind: 'seal', selector }, add(request.target.requirements[1].ids[0]), final] };
    expect(evaluateIntrinsic(new IntrinsicWorkspace(engine, request), impossible).score.upper).toBe(0);
  }, 30000);
  it('does not merge equal-label Havoc kernels with different low-tier multiplicities', () => {
    const engine = new RuleEngine();
    for (const [tier, expected] of [[1, 32.184375], [2, 35.4028125]]) {
      const request: PlanRequest = { ...exampleRequest(), item: { ...exampleRequest().item,
        affixes: [[4, 7], [7, 7], [5, 1], [10, tier]].map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: null })) } };
      expect(classifyStructure(request, engine)?.node.key).toBe('211-N4-S0');
      const result = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), { id: 'finish', macros: [final] });
      expect(mean(result.expectedFpGivenSuccess!)).toBeCloseTo(expected, 8);
    }
  });
  it('retains the guarded 7710 route and its independent 48.8049FP reference', () => {
    const request = exampleRequest('7710-direct'), engine = new RuleEngine();
    const selector = { side: 0 as const, excludedIds: [4, 5], minTier: 1, maxTier: 1, sealable: true };
    const route: Route = { id: 'guarded-7710', macros: [add(4), { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector } },
      { kind: 'seal', selector }, add(5), final] };
    const report = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), route);
    expect(report.scoreEstimate).toBeCloseTo(1, 10);
    expect(mean(report.expectedFpGivenSuccess!)).toBeCloseTo(48.8048922892, 7);
  });
  it('cuts an irreversible sub-15% prefix before any subsequent addition is evaluated', () => {
    const engine = new RuleEngine(), request = exampleRequest('7732-missing');
    let adds = 0;
    const original = engine.demandTransition.bind(engine);
    engine.demandTransition = (...args) => { if (args[1].kind === 'add') adds++; return original(...args); };
    const route: Route = { id: 'bad-removal-prefix', macros: [
      { kind: 'removal', accepted: { ids: [7] }, glyph: 'hope' },
      { kind: 'removal', accepted: { ids: [10] }, glyph: 'hope' }, add(4), add(5), final] };
    // These selectors deliberately accept the two low garbage IDs, each one at a time.
    const result = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), route);
    expect(result.intrinsic.decision).toBe('ABANDONED');
    expect(result.intrinsic.evaluatedThroughStage).toBe(2);
    expect(result.scoreEstimate).toBeCloseTo(1 / 12, 10);
    expect(result.expectedFpGivenSuccess!.lower).toBeGreaterThan(0);
    expect(adds).toBe(0);
  });
  it('keeps repeated Redemption separate from one-cast double-hit NG and retains both acquisition orders', () => {
    const engine = new RuleEngine(), compilation = compileTemplates(exampleRequest('7732-missing'), engine)!;
    expect(compilation.templates.some((row) => row.family === 'REDEMPTION_ANY_THEN_ACQUIRE')).toBe(true);
    expect(compilation.templates.some((row) => row.family === 'REDEMPTION_PROTECTED_SECOND')).toBe(true);
    expect(compilation.templates.some((row) => row.description?.includes('取得#4'))).toBe(true);
    expect(compilation.templates.some((row) => row.description?.includes('取得#5'))).toBe(true);
  });
});
