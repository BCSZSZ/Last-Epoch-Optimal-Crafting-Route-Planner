import { expect, it } from 'vitest';
import { compileDraft, emptyDraft } from './draft';
import { compileTemplates } from './hierarchy';
import { evaluateIntrinsic, IntrinsicWorkspace } from './intrinsic';
import { catalogForInputModel } from './input-model';
import { RuleEngine } from './rules';
import type { Macro, PlanRequest, Route } from './types';

function fixture(): PlanRequest {
  const draft = emptyDraft(), compiled = compileDraft({ ...draft, part: 19,
    slots: { ...draft.slots, prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null },
      suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null } },
    counts: [{ desired: 1, owned: 0, ownedT7: 0 }, { desired: 1, owned: 0, ownedT7: 0 }] });
  expect(compiled.issues).toEqual([]);
  const request = compiled.scenarios[0].request;
  return { ...request, constraints: { allowedActions: ['add', 'havoc', 'seal', 'removal'] } };
}
function interleaved(request: PlanRequest): Route {
  const [a, b] = request.target.requirements.map((row) => row.ids[0]);
  const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
  const seal: Macro = { kind: 'seal', selector: { excludedIds: [a, b], minTier: 1, maxTier: 4, sealable: true } };
  return { id: 'vacancy-add-before-seal', macros: [
    { kind: 'removal', accepted: { excludedIds: [a, b], minTier: 1, maxTier: 6, eligibleAction: 'removal' }, glyph: 'hope' },
    { kind: 'conditional', when: { kind: 'count', selector: { side: 0 }, minimum: 2 },
      then: [add(b), seal, add(a)], otherwise: [add(a), seal, add(b)] },
    { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } },
  ] };
}

it('the default template head covers a vacancy-aware add-before-seal controller for split-side 7732', () => {
  const request = fixture(), engine = new RuleEngine(catalogForInputModel(request.inputModel));
  const workspace = new IntrinsicWorkspace(engine, request), reference = evaluateIntrinsic(workspace, interleaved(request));
  const compilation = compileTemplates(request, engine)!;
  const reports = compilation.templates.slice(0, 48).map((route) => evaluateIntrinsic(workspace, route));
  const retained = reports.filter((row) => row.intrinsic.decision === 'RETAINED');
  const best = retained.sort((a, b) => b.scoreEstimate - a.scoreEstimate)[0];
  expect(compilation.templates.slice(0, 4).some((route) => route.family === 'INTERLEAVED_ACQUIRE')).toBe(true);
  expect(best.expectedFpGivenSuccess!.upper).toBeLessThan(100);
  const lowest = compilation.templates.find((row) => row.family === 'INTERLEAVED_MIN_SEAL' && row.macros[0].kind === 'removal')!;
  const improved = evaluateIntrinsic(workspace, lowest);
  expect(improved.scoreEstimate).toBeCloseTo(0.5 * (0.94 + 0.06 * 0.69), 12);
  expect(improved.intrinsic.nonTerminatingStates).toBe(0);
  expect(engine.sealChance(request.item, request.item.affixes[3].id)).toBeCloseTo(0.69, 12);
  expect(engine.sealChance({ ...request.item, affixes: request.item.affixes.filter((_, i) => i !== 1) }, request.item.affixes[3].id)).toBeCloseTo(0.621, 12);
  expect(reference.scoreEstimate).toBeCloseTo(0.25 * (0.94 * 0.69 + 0.06 * 0.345 + 0.94 * 0.345 + 0.06 * 0.15), 12);
  expect(best.score.lower).toBeGreaterThanOrEqual(reference.score.lower - 1e-12);
}, 20000);

it('pre-excludes the certified T4 seal/removal batches without excluding every T3 controller', () => {
  const request = fixture(), engine = new RuleEngine(catalogForInputModel(request.inputModel));
  const compiled = compileTemplates(request, engine)!;
  const certificates = compiled.rejected.filter((row) => row.reason === 'CERTIFIED_SUCCESS_BELOW_15_PERCENT');
  expect(certificates.length).toBeGreaterThan(0);
  expect(certificates.every((row) => row.probabilityUpperBound! < 0.15)).toBe(true);
  expect(compiled.templates.some((row) => row.description?.includes('T3'))).toBe(true);
});
