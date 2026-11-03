import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Catalog, MODEL_ID } from '../src/core/catalog';
import { exampleRequest } from '../src/core/examples';
import { UPPER_NODES } from '../src/core/hierarchy';
import { hierarchyFixtures } from '../src/core/hierarchy-fixtures';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { plan } from '../src/core/planner';
import { RuleEngine } from '../src/core/rules';
import type { Macro } from '../src/core/types';

const root = new URL('../', import.meta.url), catalog = new Catalog();
const cases = [];
for (const ids of [[4, 5], [4, 7], [7, 4], [7, 10]] as const) for (const fixture of hierarchyFixtures(catalog, ids)) {
  const on = await plan(fixture.request, { now: () => 0 });
  const off = await plan(fixture.request, { now: () => 0, disableCertifiedPruning: true });
  if (on.status !== 'RECOMMENDATION' || off.status !== 'RECOMMENDATION' || on.primary?.route.id !== off.primary?.route.id) throw new Error('Coverage or pruning mismatch: ' + fixture.label);
  if (Math.abs(on.primary!.scoreEstimate - off.primary!.scoreEstimate) > 1e-10 || Math.abs(on.primary!.expectedFpGivenSuccess!.lower - off.primary!.expectedFpGivenSuccess!.lower) > 1e-8) throw new Error('Metric mismatch');
  cases.push({ label: fixture.label, targetIds: ids, request: fixture.request, status: on.status, searchStatus: on.searchStatus,
    primaryRouteId: on.primary!.route.id, operationSuccess: on.primary!.score, successfulMeanFp: on.primary!.expectedFpGivenSuccess,
    generatedTemplates: on.hierarchy!.generatedTemplates, evaluatedTemplates: on.search.evaluatedRoutes,
    abandonedTemplates: on.abandoned!.length, certifiedPrunedPrefixes: on.search.certifiedPrunedPrefixes,
    primaryStates: on.primary!.states, pruningMatchesCompleteEvaluation: true });
}
const golden = [];
for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
  const original = exampleRequest(), request = { ...original, item: { ...original.item, fpType } };
  const selector = { side: 0 as const, excludedIds: [4, 5], minTier: 1, maxTier: 1, sealable: true };
  const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
  const route = { id: '7710-guarded', macros: [add(4), { kind: 'repeat' as const, action: { kind: 'havoc' as const, glyph: 'hope' as const }, until: { kind: 'exists' as const, selector } },
    { kind: 'seal' as const, selector }, add(5), { kind: 'repeat' as const, action: { kind: 'havoc' as const, glyph: 'hope' as const }, until: { kind: 'target' as const } }] };
  const result = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(), request), route);
  golden.push({ fpType, operationSuccess: result.score, successfulMeanFp: result.expectedFpGivenSuccess, states: result.states });
}
const sourcePaths = ['src/generated/model.json', 'src/core/hierarchy.ts', 'src/core/hierarchy-fixtures.ts', 'src/core/intrinsic.ts',
  'src/core/planner.ts', 'src/core/rules.ts', 'src/core/evaluation.ts', 'src/core/types.ts', 'scripts/validate_hierarchy.ts'];
const result = { schemaVersion: 2, modelId: MODEL_ID, metric: 'INTRINSIC_V2', status: 'PASS',
  upperInputLabels: UPPER_NODES.length, upperRoutingNodes: new Set(UPPER_NODES.map((row) => row.routeNode)).size,
  targetSideContexts: 4, endToEndCases: cases.length, pruningBaselineCases: cases.length,
  fixtureActionScope: ['add', 'havoc', 'seal', 'removal'], nodeCatalog: UPPER_NODES, cases, golden,
  qualification: 'All raw labels in four side contexts, real legal catalog IDs. Coverage fixtures explicitly constrain actions to add/havoc/seal/removal for a complete inexpensive pruning baseline. Chaos, all three FP types, dynamic Redemption, fixed branches and numerical boundary cases have separate production tests. This is not all game states, all arbitrary controllers, a physical device test, or global optimality.',
  sourceSha256: Object.fromEntries(sourcePaths.map((path) => [path, createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')])) };
const encoded = JSON.stringify(result, null, 2) + '\n', output = new URL('research/hierarchy-validation.json', root);
if (process.argv.includes('--verify-only')) {
  if (readFileSync(output, 'utf8') !== encoded) throw new Error('Hierarchy validation artifact is stale');
} else writeFileSync(output, encoded);
console.log(JSON.stringify({ status: result.status, modelId: MODEL_ID, labels: result.upperInputLabels, nodes: result.upperRoutingNodes,
  endToEndCases: cases.length, pruningBaselineCases: cases.length, verifiedOnly: process.argv.includes('--verify-only') }));
