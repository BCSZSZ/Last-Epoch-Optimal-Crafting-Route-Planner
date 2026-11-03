/** Product-threshold sensitivity, not a new global optimality claim. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { compileDraft, emptyDraft } from '../src/core/draft';
import { compileTemplates } from '../src/core/hierarchy';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';
import type { Macro, FpType } from '../src/core/types';

function containsUnwanted(macros: readonly Macro[]): boolean {
  return macros.some(macro => macro.kind === 'conditional' ? containsUnwanted([...macro.then, ...(macro.otherwise ?? [])]) :
    macro.kind === 'chaos' || (macro.kind === 'repeat' || macro.kind === 'once') && ['redemption', 'chaos'].includes(macro.action.kind));
}
const fixtures = [
  { label: '7710-DIRECT_TWO_PREFIX_TARGETS', part: 4, tiers: [1, 0, 7, 7], desired: [2, 0] },
  { label: '7710-PREPARE_MIXED_TARGETS', part: 4, tiers: [7, 7, 1, 0], desired: [1, 1] },
  ...[[7, 2, 7, 2], [7, 3, 7, 2], [7, 4, 7, 4]].map(tiers => ({ label: tiers.join(''), part: 19, tiers, desired: [1, 1] })),
];
const rows = [];
const midpoint = (v: {lower: number; upper: number}) => (v.lower + v.upper) / 2;
for (const fixture of fixtures) for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] satisfies FpType[]) {
  const draft = emptyDraft();
  const compiled = compileDraft({ ...draft, part: fixture.part, fpType,
    slots: { ...draft.slots, prefix1: { tier: fixture.tiers[0], id: null }, prefix2: { tier: fixture.tiers[1], id: null },
      suffix1: { tier: fixture.tiers[2], id: null }, suffix2: { tier: fixture.tiers[3], id: null } },
    counts: [{ desired: fixture.desired[0], owned: 0, ownedT7: 0 }, { desired: fixture.desired[1], owned: 0, ownedT7: 0 }] });
  assert.deepEqual(compiled.issues, []); assert.equal(compiled.scenarios.length, 1);
  const request = compiled.scenarios[0].request;
  const engine = new RuleEngine(catalogForInputModel(request.inputModel));
  const workspace = new IntrinsicWorkspace(engine, request);
  const candidates = compileTemplates(request, engine)!.templates.filter(route => !containsUnwanted(route.macros));
  const evaluated = candidates.map(route => evaluateIntrinsic(workspace, route));
  const retained = evaluated.filter(row => row.score.lower >= 0.15 && row.expectedFpGivenSuccess !== null);
  const ranked = [...retained].sort((a,b) => b.scoreEstimate - a.scoreEstimate || midpoint(a.expectedFpGivenSuccess!) - midpoint(b.expectedFpGivenSuccess!));
  const thresholds = [40, 50, 60, 100].map(cap => {
    const primary = ranked.find(row => row.expectedFpGivenSuccess!.upper <= cap);
    return { cap, retained: retained.filter(row => row.expectedFpGivenSuccess!.upper <= cap).length,
      primary: primary && { success: midpoint(primary.score), successFp: midpoint(primary.expectedFpGivenSuccess!), description: primary.route.description } };
  });
  const row = { label: fixture.label, fpType, templates: candidates.length, thresholds };
  rows.push(row); console.log(JSON.stringify(row));
}
const result = { schemaVersion: 1, date: '2026-11-03', modelId: MODEL_ID,
  qualification: 'Fixed representative simple-input fixtures, all generated add/seal/removal/Havoc templates; excludes Redemption/Chaos. Infinite-FP intrinsic metrics, no global optimality assertion or actual-drop mixture. Thresholds are product-policy alternatives, not physical impossibility.', rows };
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--verify-only')) assert.equal(readFileSync('research/fp-threshold-calibration.json', 'utf8'), output);
else writeFileSync('research/fp-threshold-calibration.json', output);
