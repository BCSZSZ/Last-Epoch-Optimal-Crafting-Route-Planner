import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { compileDraft, emptyDraft } from '../src/core/draft';
import { compileTemplates } from '../src/core/hierarchy';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { redemptionCertificate, twoTargetCastBound } from '../src/core/redemption-bound';
import { RuleEngine } from '../src/core/rules';
import type { FpType, Macro, Route } from '../src/core/types';

const rows = [];
for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) for (const lows of [[2, 2], [3, 2], [3, 3], [4, 4]]) {
  const draft = emptyDraft(), compiled = compileDraft({ ...draft, part: 19, fpType: fpType as FpType,
    slots: { ...draft.slots, prefix1: { tier: 7, id: null }, prefix2: { tier: lows[0], id: null }, suffix1: { tier: 7, id: null }, suffix2: { tier: lows[1], id: null } },
    counts: [{ desired: 1, owned: 0, ownedT7: 0 }, { desired: 1, owned: 0, ownedT7: 0 }] });
  if (compiled.issues.length) throw new Error('Fixture input invalid');
  const request = compiled.scenarios[0].request, engine = new RuleEngine(catalogForInputModel(request.inputModel));
  const [a, b] = request.target.requirements.map((row) => row.ids[0]);
  const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
  const removal: Macro = { kind: 'removal', accepted: { excludedIds: [a, b], minTier: 1, maxTier: 6, eligibleAction: 'removal' }, glyph: 'hope' };
  const seal = (tier?: number): Macro => ({ kind: 'seal', selector: { excludedIds: [a, b], minTier: tier ?? 1, maxTier: tier ?? 4, sealable: true } });
  const finish: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
  const strategies: Route[] = [
    { id: 'two-removals', macros: [removal, removal, add(a), add(b), finish] },
    { id: 'remove-seal-add-both', macros: [removal, seal(), add(a), add(b), finish] },
    { id: 'remove-seal-t2-add-both', macros: [removal, seal(2), add(a), add(b), finish] },
  ];
  const compilation = compileTemplates(request, engine)!;
  const directBranch = (first: number, last: number): readonly Macro[] => [add(first), seal(), add(last)];
  const direct: Route = { id: 'remove-add-seal-add', macros: [removal, { kind: 'conditional',
    when: { kind: 'count', selector: { side: 0 }, minimum: 2 }, then: directBranch(b, a), otherwise: directBranch(a, b) }, finish] };
  strategies.push(direct);
  const onlyT2 = (macro: Macro): Macro => macro.kind === 'seal' ? { ...macro, selector: { ...macro.selector, minTier: 2, maxTier: 2 } } :
    macro.kind === 'conditional' ? { ...macro, then: macro.then.map(onlyT2), otherwise: macro.otherwise?.map(onlyT2) } : macro;
  strategies.push({ ...direct, id: 'remove-add-seal-only-t2-add', macros: direct.macros.map(onlyT2) });
  for (const marker of ['准备T1', '最低阶']) {
    const route = compilation.templates.find((row) => (row.family === 'INTERLEAVED_ACQUIRE' || row.family === 'INTERLEAVED_MIN_SEAL') && row.macros[0].kind === 'removal' && row.description?.includes(marker));
    if (!route) throw new Error('Missing vacancy-aware witness');
    strategies.push({ ...route, id: marker === '最低阶' ? 'remove-add-prepare-lowest-seal-add' : 'remove-add-prepare-t1-seal-add' });
  }
  const workspace = new IntrinsicWorkspace(engine, request);
  const metrics = strategies.map((route) => {
    const value = evaluateIntrinsic(workspace, route, undefined, true);
    return { id: route.id, success: value.score, successfulMeanFp: value.expectedFpGivenSuccess,
      fpLowerBound: value.intrinsic.successfulFpLowerBound, decision: value.intrinsic.decision };
  });
  const pure: Route = { id: 'pure-repeat', macros: [{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' },
    until: { kind: 'all', predicates: request.target.requirements.map((row) => ({ kind: 'identity', requirement: { ...row, minTier: 1, maxTier: 8 } })) } }, finish] };
  rows.push({ fpType, tiers: [7, 7, ...lows], request, metrics, pureDoubleHit: {
    perCast: twoTargetCastBound(request, engine), certificate: redemptionCertificate(request, pure, engine) } });
}
const result = { schemaVersion: 1, modelId: MODEL_ID, status: 'PASS', rows,
  previousReleaseRegression: { modelId: 'le-1.5.3-iid-67c53ae6d74b301f', sourceTiers: [7, 7, 3, 2], goals: 'ONE_PREFIX_ONE_SUFFIX_BOTH_MISSING',
    constrainedActions: ['add', 'havoc', 'seal', 'removal'], oldAll90TemplateBestSuccess: 0.235, oldSuccessfulMeanFp: 69.89345668674386,
    missingVacancyAwareDirectSuccess: 0.25065, missingVacancyAwareDirectFp: 57.22823036172855 },
  qualification: 'Audited local native rules under explicit forgeable equal-positive-candidate item-type model. All low affixes and both T7s initially non-target, one ordinary affix of each tier on each side. Fixed vacancy branches, add criticals and complete successful-path FP jointly evaluated. Pure Redemptions use certified bounds, not exact means. No client frequency or global optimality claim.' };
const output = new URL('../research/acquisition-order.json', import.meta.url), encoded = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--verify-only')) { if (readFileSync(output, 'utf8') !== encoded) throw new Error('Acquisition-order record stale'); }
else writeFileSync(output, encoded);
console.log(JSON.stringify({ modelId: MODEL_ID, status: 'PASS', cases: rows.length, normal7732: rows.find((row) => row.fpType === 'NORMAL' && row.tiers[2] === 3 && row.tiers[3] === 2)?.metrics }));
