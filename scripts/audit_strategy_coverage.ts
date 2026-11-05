/** Diagnostic audit only: does not alter the production solver or its model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileDraft, emptyDraft } from '../src/core/draft';
import { compileTemplates } from '../src/core/hierarchy';
import { catalogForInputModel } from '../src/core/input-model';
import { RuleEngine } from '../src/core/rules';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { evaluateCompletion } from '../src/core/completion';
import { routeId } from '../src/core/candidates';
import type { Macro, Route } from '../src/core/types';

const draft = emptyDraft();
const { request } = compileDraft({ ...draft, part: 1, slots: { ...draft.slots,
  prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null },
  suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null } },
  counts: [{ desired: 1 }, { desired: 1 }] }).scenarios[0];
const engine = new RuleEngine(catalogForInputModel(request.inputModel));
const compilation = compileTemplates(request, engine)!;
const containsWindow = (macros: readonly Macro[]): boolean => macros.some(macro => macro.kind === 'conditional' ?
  containsWindow(macro.then) || containsWindow(macro.otherwise ?? []) : macro.kind === 'repeat' && macro.action.kind === 'havoc' &&
  macro.until.kind === 'exists' && macro.until.selector.sealable === true && macro.until.selector.minTier === 1 && macro.until.selector.maxTier === 2);
const combined = compilation.templates.filter(row => row.family === 'INTERLEAVED_ACQUIRE' || row.family === 'INTERLEAVED_MIN_SEAL');
const result = { modelId: request.modelId, request, generatedTemplates: compilation.templates.length,
  standaloneCombinedWindowExists: compilation.templates.some(row => row.family === 'PREPARE_SEAL' && containsWindow(row.macros)),
  vacancyAwareControllers: combined.length,
  vacancyAwareCombinedWindowExists: combined.some(row => containsWindow(row.macros)),
  qualification: 'Structural compositional-coverage check, not proof that a missing controller improves every input. Distinct from numerical rule correctness or global optimality.' };
const save = (path: string, data: unknown) => {
  const encoded = JSON.stringify(data, null, 2) + '\n';
  if (process.argv.includes('--verify-only')) assert.equal(readFileSync(path, 'utf8'), encoded);
  else writeFileSync(path, encoded);
};
save('research/strategy-generation-coverage.json', result);
console.log(JSON.stringify({ ...result, request: undefined }));
if (process.argv.includes('--assert-closure')) assert(result.vacancyAwareCombinedWindowExists,
  'Combined seal window exists as an acquisition method but is missing from vacancy-aware remove/add/seal controllers');

if (process.argv.includes('--evaluate')) {
  const forbidden = (macros: readonly Macro[]): boolean => macros.some(macro => macro.kind === 'conditional' ?
    forbidden(macro.then) || forbidden(macro.otherwise ?? []) : macro.kind === 'chaos' ||
    (macro.kind === 'once' || macro.kind === 'repeat') && (macro.action.kind === 'chaos' || macro.action.kind === 'redemption'));
  const workspace = new IntrinsicWorkspace(engine, request);
  const metric = (route: Route) => {
    const report = evaluateIntrinsic(workspace, route);
    return { route, decision: report.intrinsic.decision, reason: report.intrinsic.reason, p: report.scoreEstimate,
      probability: report.score, mean: report.expectedFpGivenSuccess ? (report.expectedFpGivenSuccess.lower + report.expectedFpGivenSuccess.upper) / 2 : null,
      fp: report.expectedFpGivenSuccess, states: report.states };
  };
  const stock = compilation.templates.flatMap((route, index) => forbidden(route.macros) ? [] : [{ index, ...metric(route) }]);
  const replaceWindow = (values: readonly Macro[], maximum: number): readonly Macro[] => values.map(macro => {
    if (macro.kind === 'conditional') return { ...macro, then: replaceWindow(macro.then, maximum), otherwise: replaceWindow(macro.otherwise ?? [], maximum) };
    if (macro.kind === 'repeat' && macro.action.kind === 'havoc' && macro.until.kind === 'exists' && macro.until.selector.sealable)
      return { ...macro, until: { ...macro.until, selector: { ...macro.until.selector, minTier: 1, maxTier: maximum } } };
    if (macro.kind === 'seal') return { ...macro, selector: { ...macro.selector, minTier: 1, maxTier: maximum } };
    return macro;
  });
  const probes = combined.filter(row => row.description?.includes('浩劫准备T1再封印')).flatMap(source => [2, 3, 4].map(maximum => {
    const macros = replaceWindow(source.macros, maximum);
    return { sourceRoute: source.id, window: [1, maximum], ...metric({ id: routeId(macros), macros, description: 'Diagnostic combined-window substitution' }) };
  }));
  const rank = <T extends {p: number; mean: number | null; decision: string}>(rows: readonly T[]) => rows.filter(row => row.decision === 'RETAINED')
    .sort((a, b) => Math.abs(a.p - b.p) > 1e-9 ? b.p - a.p : a.mean! - b.mean!)[0] ?? null;
  const stockBest = rank(stock), first48Best = rank(stock.filter(row => row.index < 48)), probeBest = rank(probes);
  const complete = (row: {route: Route} | null) => row ? evaluateCompletion(engine, request, row.route) : null;
  const evaluation = { ...result, testedScope: ['add', 'havoc', 'seal', 'removal'],
    stock: stock.map(row => ({ index: row.index, routeId: row.route.id, decision: row.decision, reason: row.reason, probability: row.probability, fp: row.fp, states: row.states })), probes,
    first48Best, stockBest, probeBest, stockCompletion: complete(stockBest), probeCompletion: complete(probeBest),
    sourceSha256: Object.fromEntries(['src/generated/model.json', 'src/core/hierarchy.ts', 'src/core/intrinsic.ts', 'src/core/planner.ts', 'scripts/audit_strategy_coverage.ts']
      .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    qualification: 'Diagnostic extension of the current fixed-controller language, using the current audited evaluator. All generated non-Chaos/non-Redemption candidates are compared; this is not an independent numerical oracle or proof over every possible controller.' };
  save('research/strategy-generation-probe.json', evaluation);
  console.log(JSON.stringify({ stockCandidates: stock.length, probes: probes.length,
    first48Best: first48Best && { id: first48Best.route.id, p: first48Best.p, mean: first48Best.mean },
    stockBest: stockBest && { id: stockBest.route.id, p: stockBest.p, mean: stockBest.mean },
    probeBest: probeBest && { id: probeBest.route.id, p: probeBest.p, mean: probeBest.mean },
    stockCompletion: evaluation.stockCompletion?.probability, probeCompletion: evaluation.probeCompletion?.probability }));
}
