import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { exampleRequest } from '../src/core/examples';
import { reportRoute } from '../src/core/evaluation';
import { RuleEngine } from '../src/core/rules';
import { sampleRoute } from '../src/core/sampling';
import type { PlanReport } from '../src/core/planner';
import type { FpType } from '../src/core/types';

const cases: { file: string; example: string; fpType: FpType; folder?: string; input?: string }[] = [
  { file: '7710-normal', example: '7710-direct', fpType: 'NORMAL' },
  { file: '7732-normal', example: '7732-missing', fpType: 'NORMAL' },
  { file: '7713-ice', example: '7713-prepare', fpType: 'ICE' },
  { file: '7717-blood', example: '7717-existing', fpType: 'BLOOD' },
  { file: 'public-7710-normal', example: '7710-direct', fpType: 'NORMAL' },
  { file: 'removal-normal', example: '7710-direct', fpType: 'NORMAL', input: 'removal-normal-input' },
  { file: '7710-normal-plan', example: '7710-direct', fpType: 'NORMAL', folder: 'browser-memory', input: '7710-normal-input' },
];
const checks = [];
for (const entry of cases.filter((entry) => !process.argv.includes('--local-only') || !entry.file.startsWith('public-'))) {
  const folder = entry.folder ?? 'browser-validation';
  const browser: PlanReport = JSON.parse(readFileSync(new URL(`../research/${folder}/${entry.file}.json`, import.meta.url), 'utf8'));
  if (browser.modelId !== MODEL_ID || !browser.primary) throw new Error(`Wrong model or absent recommendation: ${entry.file}`);
  const request = entry.input ? JSON.parse(readFileSync(new URL(`../research/${folder}/${entry.input}.json`, import.meta.url), 'utf8')) : exampleRequest(entry.example);
  const input = { ...request, item: { ...request.item, fpType: entry.fpType } };
  const primary = browser.primary;
  const engine = new RuleEngine();
  const node = primary.sampling ? sampleRoute(engine, input, primary.route, {
    seed: primary.sampling.seed, samplesPerFp: primary.sampling.samplesPerFp,
    confidence: primary.sampling.confidence, attemptGuard: primary.sampling.attemptGuard,
  }) : reportRoute(engine, input, primary.route);
  if (JSON.stringify(node) !== JSON.stringify(primary)) throw new Error(`Browser/Node route evaluation differs: ${entry.file}`);
  checks.push({ ...entry, score: primary.scoreEstimate, routeId: primary.route.id, evaluation: primary.evaluationStatus,
    milliseconds: browser.search.elapsedMilliseconds, evaluatedRoutes: browser.search.evaluatedRoutes,
    comparison: 'IDENTICAL_COMPLETE_ROUTE_REPORT', scope: 'Same chosen fixed route; wall-clock search coverage is reported separately.' });
}
const output = { modelId: MODEL_ID, checkedOn: new Date().toISOString(), checks,
  limitation: 'Observed browser reports versus Node share the production kernel. Independent correctness evidence comes from the Python Fraction and Monte Carlo research artifacts, not this platform-parity check.' };
writeFileSync(new URL('../research/browser-validation/parity.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output));
