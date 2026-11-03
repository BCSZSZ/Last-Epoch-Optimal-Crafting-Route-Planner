import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { exampleRequest } from '../src/core/examples';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import type { PlanReport } from '../src/core/planner';
import { RuleEngine } from '../src/core/rules';

const cases = [{ file: '7710-normal.json', example: '7710-direct' }, { file: '7732-normal.json', example: '7732-missing' }];
const checks = [];
for (const entry of cases) {
  const bytes = readFileSync(new URL('../research/browser-validation-v2/' + entry.file, import.meta.url));
  const browser: PlanReport = JSON.parse(bytes.toString('utf8'));
  if (browser.modelId !== MODEL_ID || browser.metric !== 'INTRINSIC_V2' || !browser.primary?.intrinsic) throw new Error('Wrong current browser model or missing recommendation');
  const node = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(), exampleRequest(entry.example)), browser.primary.route);
  if (JSON.stringify(node) !== JSON.stringify(browser.primary)) throw new Error('Chosen browser/Node route report differs: ' + entry.file);
  checks.push({ ...entry, recordSha256: createHash('sha256').update(bytes).digest('hex'), routeId: node.route.id,
    operationSuccess: node.score, successfulMeanFp: node.expectedFpGivenSuccess, states: node.states,
    bitIdenticalCompletePrimary: true, browserMilliseconds: browser.search.elapsedMilliseconds });
}
const output = { schemaVersion: 2, status: 'PASS', modelId: MODEL_ID, metric: 'INTRINSIC_V2', checks,
  qualification: 'Actual local static-build browser UI and production Worker exports, replayed in Node for the same fixed chosen route. Byte identity covers the full primary report, not wall-clock search coverage. Shares the rule kernel; independent correctness evidence is separate. Not physical low-end-device or peak-memory evidence.' };
const encoded = JSON.stringify(output, null, 2) + '\n', file = new URL('../research/browser-validation-v2/parity.json', import.meta.url);
if (process.argv.includes('--verify-only')) { if (readFileSync(file, 'utf8') !== encoded) throw new Error('Saved current browser parity is stale'); }
else writeFileSync(file, encoded);
console.log(JSON.stringify({ status: output.status, modelId: MODEL_ID, cases: checks.length, fullPrimaryReportsBitIdentical: true }));
