import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { exampleRequest } from '../src/core/examples';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import type { PlanReport } from '../src/core/planner';
import { RuleEngine } from '../src/core/rules';
import { recordCatalog } from './runtime_model_archive';

const cases = [{ file: '7710-normal.json', example: '7710-direct' }, { file: '7732-normal.json', example: '7732-missing' }];
const checks = [];
const historical = process.argv.includes('--historical');
const recordModels = new Set<string>();
for (const entry of cases) {
  const bytes = readFileSync(new URL('../research/browser-validation-v2/' + entry.file, import.meta.url));
  const browser: PlanReport = JSON.parse(bytes.toString('utf8'));
  if (browser.metric !== 'INTRINSIC_V2' || !browser.primary?.intrinsic) throw new Error('Wrong browser metric or missing recommendation');
  const catalog = recordCatalog(browser.modelId, historical), request = { ...exampleRequest(entry.example), modelId: browser.modelId };
  recordModels.add(browser.modelId);
  const node = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(catalog), request), browser.primary.route);
  if (JSON.stringify(node) !== JSON.stringify(browser.primary)) throw new Error('Chosen browser/Node route report differs: ' + entry.file);
  checks.push({ ...entry, recordSha256: createHash('sha256').update(bytes).digest('hex'), routeId: node.route.id,
    operationSuccess: node.score, successfulMeanFp: node.expectedFpGivenSuccess, states: node.states,
    bitIdenticalCompletePrimary: true, browserMilliseconds: browser.search.elapsedMilliseconds });
}
if (recordModels.size !== 1) throw new Error('Mixed browser model versions');
const output = { schemaVersion: 3, status: 'PASS', modelId: [...recordModels][0], currentModelId: MODEL_ID,
  historical: [...recordModels][0] !== MODEL_ID, metric: 'INTRINSIC_V2', checks,
  qualification: 'Actual local static-build browser UI and production Worker exports, replayed against their original archived data model with the current compatible rule kernel. Byte identity covers the full primary report, not wall-clock search coverage or current browser performance. Shares the rule kernel; independent correctness evidence is separate. Not physical low-end-device or peak-memory evidence.' };
const encoded = JSON.stringify(output, null, 2) + '\n', file = new URL('../research/browser-validation-v2/parity.json', import.meta.url);
if (process.argv.includes('--verify-only')) { if (readFileSync(file, 'utf8') !== encoded) throw new Error('Saved current browser parity is stale'); }
else writeFileSync(file, encoded);
console.log(JSON.stringify({ status: output.status, modelId: output.modelId, currentModelId: MODEL_ID, historical: output.historical, cases: checks.length, fullPrimaryReportsBitIdentical: true }));
