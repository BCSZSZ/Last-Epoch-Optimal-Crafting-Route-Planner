/** Research only: inspect existing reports and evaluate concrete counterexamples. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { reportRoute } from '../src/core/evaluation';
import { exampleRequest } from '../src/core/examples';
import { RuleEngine } from '../src/core/rules';
import type { FpType, PlanRequest, Route } from '../src/core/types';
import type { DeviceBenchmarkRecord } from '../src/diagnostics/record';

const root = new URL('../', import.meta.url);
const digest = (path: string) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex');
const baseline = JSON.parse(readFileSync(new URL('research/device-validation/desktop-baseline.json', root), 'utf8')) as DeviceBenchmarkRecord;
if (baseline.modelId !== MODEL_ID) throw new Error('Baseline model differs');
const fp7710 = baseline.entries.filter((entry) => entry.id === '7710-direct').map((entry) => {
  const report = entry.report.primary;
  if (!report) throw new Error('Baseline lacks recommendation');
  return { fpType: entry.fpType, request: entry.request, route: report.route, score: report.score,
    expectedFp: report.expectedFp, expectedFpGivenSuccess: report.expectedFpGivenSuccess,
    failedFpWaste: report.failedFpWaste, successQuantiles: report.successQuantiles,
    fp63: report.curve.find((point) => point.initialFp === 63) };
});
type Bounds = { lower: number; upper: number };
interface ReferencePoint {
  initialFp: number; successProbability: Bounds; expectedActualFpSpent: Bounds;
  successfulFpFirstMoment: Bounds; expectedFpGivenSuccess: Bounds | null;
}
interface ReferenceScenario {
  caseId: string; fpType: FpType; routeId: string; primaryUserRoute: boolean; points: ReferencePoint[];
}
const references: { profiles: { id: string; scenarios: ReferenceScenario[] }[] } =
  JSON.parse(readFileSync(new URL('research/7710-route-results.json', root), 'utf8'));
const midpoint = (value: Bounds) => (value.lower + value.upper) / 2;
const primaryReferences = references.profiles.find((entry) => entry.id === 'display_parameters_iid');
if (!primaryReferences) throw new Error('Missing declared reference profile');
const fp7710ReferenceSummaries = primaryReferences.scenarios.filter((entry) => entry.primaryUserRoute).map((entry) => {
  const points = entry.points.filter((point) => point.initialFp > 0);
  const mean = (select: (point: ReferencePoint) => Bounds) => points.reduce((sum, point) => sum + midpoint(select(point)), 0) / points.length;
  const successProbability = mean((point) => point.successProbability);
  const expectedFp = mean((point) => point.expectedActualFpSpent);
  const expectedFpGivenSuccess = mean((point) => point.successfulFpFirstMoment) / successProbability;
  if (entry.caseId === 'direct_prefix_targets') {
    const production = fp7710.find((row) => row.fpType === entry.fpType)!;
    for (const [actual, saved] of [[successProbability, production.score], [expectedFp, production.expectedFp],
      [expectedFpGivenSuccess, production.expectedFpGivenSuccess]] as const) {
      if (!saved || Math.abs(actual - midpoint(saved)) > 1e-12) throw new Error('Independent 7710 reference differs');
    }
  }
  return { caseId: entry.caseId, fpType: entry.fpType, routeId: entry.routeId,
    successProbability, expectedFp, expectedFpGivenSuccess, fp63: entry.points.find((point) => point.initialFp === 63),
    summaryArithmetic: 'NOMINAL_MIDPOINTS_OF_SAVED_OUTWARD_INTERVALS; DIRECT_ROUTE_MATCHES_PRODUCTION_WITHIN_1E-12' };
});

const removalRoute: Route = { id: 'research-two-removals-add-a-b-havoc', macros: [
  { kind: 'removal', accepted: { ids: [2, 26] }, glyph: 'hope' },
  { kind: 'removal', accepted: { ids: [2, 26] }, glyph: 'hope' },
  { kind: 'once', action: { kind: 'add', id: 4, glyph: 'hope' } },
  { kind: 'once', action: { kind: 'add', id: 5, glyph: 'hope' } },
  { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } },
] };
const sealRemovalRoute: Route = { ...removalRoute, id: 'research-seal-t2-remove-t3-add-a-b-havoc', macros: [
  { kind: 'seal', selector: { ids: [26], minTier: 2, maxTier: 2, sealable: true } },
  { kind: 'removal', accepted: { ids: [2] }, glyph: 'hope' },
  ...removalRoute.macros.slice(2),
] };

const counterexamples = [];
for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const satisfies readonly FpType[]) {
  for (const [pattern, tiers, route] of [
    ['7732', [3, 2], removalRoute], ['7744', [4, 4], removalRoute], ['7732', [3, 2], sealRemovalRoute],
  ] as const) {
    const base = exampleRequest('7710-direct');
    const request: PlanRequest = { ...base, item: { ...base.item, fpType, affixes: [
      { id: 7, tier: 7, slot: 'ordinary', roll: null }, { id: 10, tier: 7, slot: 'ordinary', roll: null },
      { id: 2, tier: tiers[0], slot: 'ordinary', roll: null }, { id: 26, tier: tiers[1], slot: 'ordinary', roll: null },
    ] } };
    const report = reportRoute(new RuleEngine(), request, route);
    counterexamples.push({ pattern, fpType, request, route, score: report.score,
      expectedFp: report.expectedFp, expectedFpGivenSuccess: report.expectedFpGivenSuccess,
      fp63: report.curve.find((point) => point.initialFp === 63), evaluationStatus: report.evaluationStatus });
    console.log(JSON.stringify({ pattern, fpType, route: route.id, score: report.score, fp63: report.curve[63]?.successProbability }));
  }
}
for (const fpType of ['NORMAL', 'ICE', 'BLOOD']) {
  const first = counterexamples.find((entry) => entry.fpType === fpType && entry.pattern === '7732' && entry.route === removalRoute)!;
  const second = counterexamples.find((entry) => entry.fpType === fpType && entry.pattern === '7744')!;
  for (const key of ['score', 'expectedFp', 'expectedFpGivenSuccess', 'fp63'] as const) {
    if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) throw new Error(`Two-removal tier invariance failed: ${fpType}.${key}`);
  }
}
const output = { schemaVersion: 1, date: '2026-11-03', modelId: MODEL_ID,
  scope: 'RESEARCH_ONLY_FIXED_ROUTES_NOT_SEARCH_OR_OPTIMALITY_PROOF',
  fpWeighting: 'UNIFORM_HYPOTHETICAL_INITIAL_FP_1_TO_63_NOT_NATURAL_DROP_DISTRIBUTION',
  sourceHashes: Object.fromEntries(['src/generated/model.json', 'research/device-validation/desktop-baseline.json',
    'research/7710-route-results.json', 'scripts/research_pruning_examples.ts'].map((path) => [path, digest(path)])),
  fp7710, fp7710ReferenceSummaries, counterexamples,
  twoRemovalTierInvarianceVerified: true, actualClientTests: 0,
  qualification: 'Existing production rule kernel, not independent validation. Each required seal/removal failure aborts after settlement. Counterexample has two T7 suffixes, two unwanted prefixes and two requested target prefixes. Ignoring FP exhaustion, both unwanted prefixes are removed with probability (2/4)*(1/3)=1/6; this is not the complete crafting success rate.' };
writeFileSync(new URL('research/practical-pruning-examples.json', root), JSON.stringify(output, null, 2) + '\n');
