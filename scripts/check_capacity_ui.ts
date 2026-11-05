/** Replay actual UI/Worker evidence for shared T7 capacity and the user's 7271 route. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { evaluateCompletion } from '../src/core/completion';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';
import { routeSteps } from '../src/ui/route-view';
import { recordCatalog } from './runtime_model_archive';

const context = process.argv.includes('--public') ? 'public' : 'local';
const root = 'research/ui-validation/', source = root + `capacity-${context}-observations.json`;
const bytes = readFileSync(source), observations = JSON.parse(bytes.toString('utf8'));
const original = recordCatalog(observations.modelId, process.argv.includes('--historical'));
const snapshot = (id: string) => {
  const row = observations.snapshots.find((entry: { id: string }) => entry.id === id);
  assert(row, id); return row;
};
const disabled = (id: string, label: string) => {
  const button = snapshot(id).goalButtons.find((entry: { label: string }) => entry.label === label);
  assert(button, `${id}/${label}`); return button.disabled;
};
if (context === 'local') {
  for (const side of ['前缀', '后缀']) for (const count of [1, 2]) assert(disabled('empty', `${side}目标T7数${count}`));
  assert.equal(disabled('two-sources-one-goal', '前缀目标T7数2'), false);
  assert.equal(disabled('two-sources-one-goal', '后缀目标T7数1'), false);
  assert(disabled('two-sources-one-goal', '后缀目标T7数2'));
  for (const id of ['two-sources-two-goals', 'sealed-t7-excluded']) {
    assert(disabled(id, '后缀目标T7数1')); assert(disabled(id, '后缀目标T7数2'));
  }
  assert(disabled('source-t7-lowered', '前缀目标T7数2'));
  assert.equal(disabled('source-t7-lowered', '前缀目标T7数1'), false);
  for (const side of ['前缀', '后缀']) assert(disabled('split-goals', `${side}目标T7数2`));
}
const raw = readFileSync(root + `capacity-${context}-7271.json`), record = JSON.parse(raw.toString('utf8'));
assert.equal(record.input.modelId, observations.modelId); assert.equal(record.report.modelId, observations.modelId);
const engine = new RuleEngine(catalogForInputModel(record.input.inputModel, original.model));
const primary = record.report.primary, completion = record.report.completion;
assert(primary); assert.equal(completion.status, 'COMPLETE'); assert.equal(completion.recommendation, 'NEUTRAL');
assert.deepEqual(evaluateIntrinsic(new IntrinsicWorkspace(engine, record.input), primary.route), primary);
assert.deepEqual(evaluateCompletion(engine, record.input, primary.route), completion);
const rendered = snapshot('7271-result'), lines = rendered.resultText.split('\n').map((line: string) => line.trim()).filter(Boolean);
const percent = (value: { lower: number; upper: number }) => `${((value.lower + value.upper) * 50).toFixed(2)}%`;
assert.equal(lines[1], '当前方案');
assert.equal(lines[lines.indexOf('成功率') + 1], percent(primary.score));
assert.equal(lines[lines.indexOf('整件完成率（48 FP）') + 1], percent(completion.probability));
assert.equal(lines[lines.indexOf('成功路径平均 FP') + 1], ((primary.expectedFpGivenSuccess.lower + primary.expectedFpGivenSuccess.upper) / 2).toFixed(2));
assert.equal(percent(primary.score), '84.50%'); assert.equal(percent(completion.probability), '50.55%');
assert(rendered.resultText.includes('浩劫至前缀1为T1或T2')); assert(!rendered.resultText.includes('T1–T6'));
assert(rendered.resultText.includes('前缀1（T1或T2）；封印失败即停止。'));
assert.equal(routeSteps(primary.route.macros, record.input, engine.catalog)[0].title, '浩劫至前缀1为T1或T2');
assert.deepEqual(record.input.item.affixes.map((row: {tier: number}) => row.tier), [7, 2, 7, 1]);
assert.deepEqual(record.input.target.requirements[0].ids, [record.input.item.affixes[1].id]);
for (const count of [1, 2]) assert(disabled('7271-result', `后缀目标T7数${count}`));
const result = { schemaVersion: 1, status: 'PASS', modelId: observations.modelId, currentModelId: MODEL_ID,
  historical: observations.modelId !== MODEL_ID, context, observedAt: observations.observedAt,
  observationSha256: createHash('sha256').update(bytes).digest('hex'), reportSha256: createHash('sha256').update(raw).digest('hex'),
  operationSuccess: primary.score, successPathMeanFp: primary.expectedFpGivenSuccess, completion,
  sharedGoalCapacityChecked: true, localTransitionChecks: context === 'local', exactOriginalSlotAndTierTextChecked: true,
  fullPrimaryAndCompletionBitIdentical: true,
  qualification: 'Actual static UI/Worker result for the user 7271 screenshot. Anonymous chest equal-positive model; not an equipment average, game-client frequency test, physical low-end benchmark or global optimality proof.' };
const encoded = JSON.stringify(result, null, 2) + '\n', destination = root + `capacity-${context}-parity.json`;
if (process.argv.includes('--verify-only')) assert.equal(readFileSync(destination, 'utf8'), encoded);
else writeFileSync(destination, encoded);
console.log(JSON.stringify({status:'PASS', context, modelId:observations.modelId, completion48:percent(completion.probability), fullPrimaryAndCompletionBitIdentical:true}));
