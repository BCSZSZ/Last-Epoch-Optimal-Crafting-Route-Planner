import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { catalogForInputModel } from '../src/core/input-model';
import { IntrinsicWorkspace, evaluateIntrinsic } from '../src/core/intrinsic';
import type { PlanReport } from '../src/core/planner';
import { parsePlanRequest } from '../src/core/request';
import { RuleEngine } from '../src/core/rules';
import type { PlanRequest } from '../src/core/types';
import { recordCatalog } from './runtime_model_archive';

const historical = process.argv.includes('--historical');
const modelIds = new Set<string>();

const checks = ['simple-7710.json', 'detailed-wildcard.json', 'interleaved-7732.json'].map((file) => {
  const bytes = readFileSync(new URL('../research/ui-validation/' + file, import.meta.url));
  const exported: { schemaVersion: number; input: PlanRequest; report: PlanReport } = JSON.parse(bytes.toString('utf8'));
  const { input, report } = exported, catalog = catalogForInputModel(input.inputModel, recordCatalog(report.modelId, historical).model);
  modelIds.add(report.modelId);
  if (exported.schemaVersion !== 1 || input.modelId !== report.modelId || !report.primary?.intrinsic) throw new Error('Wrong UI export model');
  if (parsePlanRequest(input, catalog).issues.length) throw new Error('Invalid exported request');
  if (input.inputModel !== report.inputModel || input.inputModel === 'AUDITED' || !input.inputModel) throw new Error('Missing explicit input assumptions');
  const node = evaluateIntrinsic(new IntrinsicWorkspace(new RuleEngine(catalog), input), report.primary.route);
  if (JSON.stringify(node) !== JSON.stringify(report.primary)) throw new Error('Full browser/Node primary differs: ' + file);
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), inputModel: input.inputModel,
    routeId: node.route.id, success: node.score, successfulMeanFp: node.expectedFpGivenSuccess, fullPrimaryBitIdentical: true,
    browserMilliseconds: report.search.elapsedMilliseconds };
});
if (modelIds.size !== 1) throw new Error('Mixed UI models');
const result = { schemaVersion: 2, modelId: [...modelIds][0], currentModelId: MODEL_ID, historical: [...modelIds][0] !== MODEL_ID, status: 'PASS', checks,
  qualification: 'Actual local Pages-subpath static UI exports replayed with their original versioned data, input assumptions and FP policy. Historical reports do not certify the current UI or policy. Does not prove searched-scope equality, independent mechanics correctness, actual unknown-item probabilities, low-end-device performance or client frequencies.' };
const encoded = JSON.stringify(result, null, 2) + '\n', file = new URL('../research/ui-validation/parity.json', import.meta.url);
if (process.argv.includes('--verify-only')) { if (readFileSync(file, 'utf8') !== encoded) throw new Error('UI parity record stale'); }
else writeFileSync(file, encoded);
console.log(JSON.stringify({ modelId: MODEL_ID, status: result.status, cases: checks.length, fullPrimaryBitIdentical: true }));
