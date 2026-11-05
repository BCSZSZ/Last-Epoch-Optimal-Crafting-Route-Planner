/** Reproduce the user's 7271, owned prefix2, two-prefix T7 target comparison. */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { compileDraft, emptyDraft } from '../src/core/draft';
import { compileTemplates } from '../src/core/hierarchy';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { evaluateCompletion } from '../src/core/completion';
import { RuleEngine } from '../src/core/rules';
import type { Macro, Route } from '../src/core/types';

const draft = emptyDraft();
const { request, aliases } = compileDraft({ ...draft, part: 1, slots: { ...draft.slots,
  prefix1: { tier: 7, id: null }, prefix2: { tier: 2, id: null, isTarget: true },
  suffix1: { tier: 7, id: null }, suffix2: { tier: 1, id: null } },
  counts: [{ desired: 2 }, { desired: 0 }] }).scenarios[0];
const engine = new RuleEngine(catalogForInputModel(request.inputModel));
const workspace = new IntrinsicWorkspace(engine, request);
const compilation = compileTemplates(request, engine)!;
const missing = request.target.requirements.map(row => row.ids[0]).find(id => !request.item.affixes.some(row => row.id === id))!;
const final: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
const custom = (index: number): Route => {
  const selector = { ids: [request.item.affixes[index].id], minTier: 1, maxTier: 2, sealable: true };
  return { id: `seal-original-prefix${index + 1}-at-1-or-2`, macros: [
    { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector } },
    { kind: 'seal', selector }, { kind: 'once', action: { kind: 'add', id: missing, glyph: 'hope' } }, final] };
};
const containsGamble = (macros: readonly Macro[]): boolean => macros.some(macro => macro.kind === 'conditional' ?
  containsGamble(macro.then) || containsGamble(macro.otherwise ?? []) : macro.kind === 'chaos' ||
  (macro.kind === 'once' || macro.kind === 'repeat') && (macro.action.kind === 'redemption' || macro.action.kind === 'chaos'));
const routes = [...compilation.templates.filter(row => !containsGamble(row.macros)), custom(0), custom(1)];
const rows = routes.map(route => {
  const report = evaluateIntrinsic(workspace, route, undefined, true);
  const completion = report.score.upper > 0 ? evaluateCompletion(engine, request, route) : null;
  const row = { id: route.id, description: route.description, macros: route.macros, success: report.score,
    meanFp: report.expectedFpGivenSuccess, decision: report.intrinsic.decision, reason: report.intrinsic.reason,
    states: report.states, completion };
  return row;
});
const encoded = JSON.stringify({ schemaVersion: 1, modelId: request.modelId,
  qualification: 'Full fixed-route evaluation, with prefix/certificate pruning disabled for this comparison. Source visible order P7,P2(owned),S7,S1; anonymous chest equal-positive pool. The last two rows test the literal target-prefix seal and the garbage-prefix seal separately. No client gameplay measurement or global optimality claim.',
  request, aliases, totalTemplates: compilation.templates.length, rows }, null, 2) + '\n';
if (process.argv.includes('--verify-only')) assert.equal(readFileSync('research/7271-route-comparison.json', 'utf8'), encoded);
else writeFileSync('research/7271-route-comparison.json', encoded);
console.log(JSON.stringify({ status: 'PASS', modelId: request.modelId, comparedRoutes: rows.length,
  combinedTierSeal: rows.find(row => row.id === 'seal-original-prefix1-at-1-or-2') }));
