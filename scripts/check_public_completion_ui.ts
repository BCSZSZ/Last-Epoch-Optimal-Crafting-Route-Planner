/** Replay actual public Pages UI/Worker exports and verify their visible metrics and labels. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { evaluateCompletion } from '../src/core/completion';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';
import { recordCatalog } from './runtime_model_archive';

const root = 'research/ui-validation/';
const sourcePath = root + 'public-completion48-observations.json';
const sourceBytes = readFileSync(sourcePath);
const source = JSON.parse(sourceBytes.toString('utf8'));
assert.equal(source.observations.length, 4);
const badges = { RECOMMENDED: '推荐', NOT_RECOMMENDED: '不推荐', NEUTRAL: '当前方案' };
const decisions = new Set<string>(), checks = [];
const historical = process.argv.includes('--historical'), modelIds = new Set<string>();
const percent = (bounds: {lower: number; upper: number}) => {
  assert(bounds.upper - bounds.lower < 1e-5);
  return `${((bounds.lower + bounds.upper) * 50).toFixed(2)}%`;
};
for (const observation of source.observations) {
  assert.equal(observation.url, 'https://bcszsz.github.io/Last-Epoch-Optimal-Crafting-Route-Planner/');
  assert.match(observation.file, /^public-completion48-[\w-]+\.json$/);
  const bytes = readFileSync(root + observation.file), record = JSON.parse(bytes.toString('utf8'));
  assert.equal(record.input.modelId, record.report.modelId); modelIds.add(record.report.modelId);
  const primary = record.report.primary, completion = record.report.completion;
  assert(primary); assert.equal(completion.status, 'COMPLETE'); assert.equal(completion.initialFp, 48);
  const engine = new RuleEngine(catalogForInputModel(record.input.inputModel, recordCatalog(record.report.modelId, historical).model));
  assert.deepEqual(evaluateIntrinsic(new IntrinsicWorkspace(engine, record.input), primary.route), primary);
  assert.deepEqual(evaluateCompletion(engine, record.input, primary.route), completion);
  const decision = completion.recommendation as keyof typeof badges;
  assert(decision in badges); decisions.add(decision);
  const lines = observation.displayedText.split('\n').map((line: string) => line.trim()).filter(Boolean);
  assert.equal(lines[1], badges[decision]);
  assert.equal(lines[lines.indexOf('成功率') + 1], percent(primary.score));
  assert.equal(lines[lines.indexOf('整件完成率（48 FP）') + 1], percent(completion.probability));
  assert.equal(lines[lines.indexOf('成功路径平均 FP') + 1],
    ((primary.expectedFpGivenSuccess.lower + primary.expectedFpGivenSuccess.upper) / 2).toFixed(2));
  checks.push({ id: observation.id, file: observation.file,
    sha256: createHash('sha256').update(bytes).digest('hex'), routeId: primary.route.id,
    displayedSuccess: percent(primary.score), displayedCompletion48: percent(completion.probability),
    displayedBadge: badges[decision], successfulMeanFp: primary.expectedFpGivenSuccess,
    fullPrimaryAndCompletionBitIdentical: true, visibleMetricsAndBadgeMatch: true });
}
for (const decision of Object.keys(badges)) assert(decisions.has(decision));
assert.equal(modelIds.size,1);
const result = { schemaVersion: 2, status: 'PASS', modelId: [...modelIds][0], currentModelId: MODEL_ID, historical: [...modelIds][0]!==MODEL_ID, observedAt: source.observedAt,
  observationsSha256: createHash('sha256').update(sourceBytes).digest('hex'), checks,
  qualification: 'Four actual public Pages UI/Worker exports and captured visible text, replayed with their original archived model. Full selected-route and48FP calculations match Node bit for bit; all three label categories match. Historical reports do not certify the current input UI. Not a physical-device benchmark or independent mechanics validation.' };
const encoded = JSON.stringify(result, null, 2) + '\n', path = root + 'public-completion48-parity.json';
if (process.argv.includes('--verify-only')) assert.equal(readFileSync(path, 'utf8'), encoded);
else writeFileSync(path, encoded);
console.log(JSON.stringify({status:'PASS', modelId:MODEL_ID, cases:checks.length,
  fullPrimaryAndCompletionBitIdentical:true, visibleMetricsAndBadgesMatch:true}));
