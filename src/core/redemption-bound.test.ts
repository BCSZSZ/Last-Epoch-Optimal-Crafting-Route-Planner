import { describe, expect, it } from 'vitest';
import { Catalog } from './catalog';
import { compileDraft, emptyDraft } from './draft';
import { catalogForInputModel } from './input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from './intrinsic';
import { redemptionCertificate, twoTargetCastBound } from './redemption-bound';
import { RuleEngine } from './rules';
import type { FpType, Macro, PlanRequest, Route } from './types';

function fixture(fpType: FpType = 'NORMAL'): PlanRequest {
  const draft = emptyDraft();
  return compileDraft({ ...draft, part: 19, fpType, slots: { ...draft.slots,
    prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null }, suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null } },
    counts: [{ desired: 1, owned: 0, ownedT7: 0 }, { desired: 1, owned: 0, ownedT7: 0 }] }).scenarios[0].request;
}
const final: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
const single: Route = { id: 'single', macros: [{ kind: 'once', action: { kind: 'redemption', glyph: 'hope' } }, final] };
function repeated(request: PlanRequest): Route {
  return { id: 'repeat', macros: [{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'all',
    predicates: request.target.requirements.map((row) => ({ kind: 'identity', requirement: { ...row, minTier: 1, maxTier: 8 } })) } }, final] };
}

describe('pure double-hit preflight certificates', () => {
  it('bounds the actual native-order atomic cast, without constructing the route graph', () => {
    const request = fixture(), engine = new RuleEngine(catalogForInputModel(request.inputModel)), ids = request.target.requirements.map((row) => row.ids[0]);
    const bound = twoTargetCastBound(request, engine)!;
    const cast = engine.demandTransition(request.item, { kind: 'redemption', glyph: 'hope' }, request.craftingContext);
    const actual = cast.outcomes.reduce((sum, row) => sum + (ids.every((id) => row.item.affixes.some((affix) => affix.slot === 'ordinary' && affix.id === id)) ? (row.probability.lower + row.probability.upper) / 2 : 0), 0);
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThanOrEqual(bound.upper);
    expect(bound.upper).toBeLessThan(0.15);
    const report = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), single);
    expect(report.states).toBe(0);
    expect(report.intrinsic.preflight?.rule).toBe('SINGLE_CAST_BELOW_MINIMUM');
    expect(report.score.upper).toBe(bound.upper);
  });

  for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) it(`${fpType}: certifies the repeat fee bound separately from one-cast success`, () => {
    const request = fixture(fpType), engine = new RuleEngine(catalogForInputModel(request.inputModel));
    const certificate = redemptionCertificate(request, repeated(request), engine)!;
    expect(certificate.certainlyEventuallySucceeds).toBe(true);
    expect(certificate.successfulFpLowerBound).toBeGreaterThan(65);
    const report = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), repeated(request));
    expect(report.states).toBe(0);
    expect(report.score).toEqual({ lower: 1, upper: 1 });
    expect(report.intrinsic.reason).toBe('ABOVE_MAXIMUM_SUCCESS_FP');
    expect(report.expectedFpGivenSuccess).toBeNull();
  });

  it('never extrapolates to first-hit hybrids, finite-attempt conditional means, or protected inputs', () => {
    const request = fixture(), engine = new RuleEngine(catalogForInputModel(request.inputModel));
    const hybrid: Route = { ...repeated(request), macros: [{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' },
      until: { kind: 'any', predicates: request.target.requirements.map((row) => ({ kind: 'identity', requirement: { ...row, minTier: 1, maxTier: 8 } })) } }, final] };
    expect(redemptionCertificate(request, hybrid, engine)).toBeNull();
    expect(redemptionCertificate({ ...request, constraints: { maxAttempts: 20 } }, repeated(request), engine)).toBeNull();
    expect(twoTargetCastBound({ ...request, constraints: { protected: [{ id: request.item.affixes[0].id, identity: true }] } }, engine)).toBeNull();
  });

  it('does not blacklist double-hit loops in a small valid kernel where the complete mean passes65FP', () => {
    const request = fixture(), original = catalogForInputModel(request.inputModel);
    const poolIds = original.model.affixes.filter((row) => row.special === 0 && row.side === 0 && row.tiers.length >= 7 &&
      original.canRollOn(row.id, request.item.baseId) && original.craftWeight(row.id, request.item.baseId) > 0).slice(0, 5).map((row) => row.id);
    const [oldA, oldB, targetA, targetB] = poolIds;
    const suffix = request.item.affixes.filter((row) => original.side(row.id) === 1).map((row) => ({ ...row, tier: 1 }));
    const model = { ...original.model, affixes: original.model.affixes.map((row) => ({ ...row,
      weight: row.side === 0 ? (poolIds.includes(row.id) ? 1 : 0) : row.weight,
      overrides: row.side === 0 ? [] : row.overrides })) };
    const engine = new RuleEngine(new Catalog(model));
    const tiny: PlanRequest = { ...request, item: { ...request.item, affixes: [
      { id: oldA, tier: 7, slot: 'ordinary', roll: null }, { id: oldB, tier: 7, slot: 'ordinary', roll: null }, ...suffix] },
      target: { requirements: [targetA, targetB].map((id) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) } };
    expect(redemptionCertificate(tiny, repeated(tiny), engine)).toBeNull();
    const result = evaluateIntrinsic(new IntrinsicWorkspace(engine, tiny), repeated(tiny), undefined, true);
    expect(result.score.lower).toBeGreaterThan(0.99);
    expect(result.expectedFpGivenSuccess!.upper).toBeLessThan(65);
  });
});
