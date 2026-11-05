/** Actual v3 UI observations and Worker reports: membership, readonly counts and Any equipment. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID, ordinary } from '../src/core/catalog';
import { evaluateCompletion } from '../src/core/completion';
import { ANY_BASE_ID, catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';

const context = process.argv.includes('--public') ? 'public' : 'local';
const root = 'research/ui-validation/', path = root + `slot-targets-${context}-observations.json`;
const sourceBytes = readFileSync(path), data = JSON.parse(sourceBytes.toString('utf8'));
assert.equal(data.modelId, MODEL_ID);
const snapshot = (id: string) => { const found = data.snapshots.find((row: {id: string}) => row.id === id); assert(found, id); return found; };
const count = (row: {readonlyCounts: {label: string; value: string}[]}, label: string) => row.readonlyCounts.find(entry => entry.label === label)?.value;
for (const row of data.snapshots) {
  assert.equal(row.tiers.length, 5);
  for (const tiers of row.tiers) assert.deepEqual(tiers, ['空', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(row.memberships.length, 4); assert.equal(row.readonlyCounts.length, 4); assert.equal(row.goalButtons.length, 2);
  assert.equal(row.scrollWidth, row.clientWidth);
}
if (context === 'local') {
  const initial = snapshot('initial');
  assert.equal(initial.selectedPart, '任意');
  assert(initial.memberships.every((row: {checked: boolean; disabled: boolean}) => !row.checked && row.disabled));
  assert.equal(count(snapshot('marked-t7'), '前缀已有目标词条数'), '1');
  assert.equal(count(snapshot('marked-t7'), '前缀已有目标T7数'), '1');
  assert.equal(count(snapshot('lowered-to2'), '前缀已有目标词条数'), '1');
  assert.equal(count(snapshot('lowered-to2'), '前缀已有目标T7数'), '0');
  assert.equal(count(snapshot('emptied-slot'), '前缀已有目标词条数'), '0');
  assert.equal(snapshot('emptied-slot').memberships[0].checked, false);
  assert.equal(snapshot('emptied-slot').memberships[0].disabled, true);
  assert.equal(count(snapshot('after-refresh'), '前缀已有目标T7数'), '1');
  assert(data.search.options.some((name: string) => name.includes('施法速度')));
  assert(snapshot('narrow-layout').clientWidth < 400);
}
const checks = [];
assert.equal(data.reports.length, 3);
for (const entry of data.reports) {
  assert.match(entry.file, new RegExp(`^slot-targets-${context}-[\\w-]+\\.json$`));
  const bytes = readFileSync(root + entry.file), record = JSON.parse(bytes.toString('utf8'));
  assert.equal(record.input.modelId, MODEL_ID); assert.equal(record.report.modelId, MODEL_ID);
  const catalog = catalogForInputModel(record.input.inputModel), engine = new RuleEngine(catalog), row = snapshot(entry.id);
  const primary = record.report.primary, completion = record.report.completion; assert(primary);
  assert.deepEqual(evaluateIntrinsic(new IntrinsicWorkspace(engine, record.input), primary.route), primary);
  assert.deepEqual(evaluateCompletion(engine, record.input, primary.route), completion);
  assert.equal(completion.initialFp, 48); assert.equal(completion.recommendation, 'RECOMMENDED');
  if (entry.id.startsWith('any-')) { assert.equal(record.input.inputModel, 'FORGEABLE_ANY_EQUAL'); assert.equal(record.input.item.baseId, ANY_BASE_ID); assert.equal(row.selectedPart, '任意'); }
  else { assert.equal(record.input.inputModel, 'FORGEABLE_EQUAL'); assert.equal(row.selectedPart, '手套'); }
  const goals = new Set<number>(record.input.target.requirements.flatMap((goal: {ids: number[]}) => goal.ids));
  const existing = ordinary(record.input.item).filter(affix => goals.has(affix.id));
  for (const side of [0, 1] as const) {
    const own = existing.filter(affix => catalog.side(affix.id) === side), label = side ? '后缀' : '前缀';
    assert.equal(count(row, `${label}已有目标词条数`), String(own.length));
    assert.equal(count(row, `${label}已有目标T7数`), String(own.filter(affix => affix.tier === 7).length));
  }
  if (entry.id.endsWith('7721')) {
    assert.deepEqual(record.input.target.requirements[0].ids, [record.input.item.affixes[0].id]);
    assert.equal(row.memberships[0].checked, true);
  }
  const lines: string[] = row.resultText.split('\n').map((line: string) => line.trim()).filter(Boolean);
  assert.equal(lines[1], '推荐'); assert.equal(lines[lines.indexOf('成功率') + 1], '100.00%');
  const displayedCompletion = `${((completion.probability.lower + completion.probability.upper) * 50).toFixed(2)}%`;
  assert.equal(lines[lines.indexOf('整件完成率（48 FP）') + 1], displayedCompletion);
  checks.push({ id: entry.id, file: entry.file, sha256: createHash('sha256').update(bytes).digest('hex'),
    displayedCompletion, inputModel: record.input.inputModel, exactMarkedSlotPreserved: entry.id.endsWith('7721'),
    readonlyCountsMatchRequest: true, fullPrimaryAndCompletionBitIdentical: true });
}
const result = { schemaVersion: 1, modelId: MODEL_ID, context, status: 'PASS', observedAt: data.observedAt,
  sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'), checks,
  qualification: 'Actual static UI/Worker records checked against DOM observations and Node route evaluation. Explicit slot ownership, readonly counters, numeric tier buttons and separate Any reference model; local-only transition/refresh/search/layout observations are not a physical-device benchmark.' };
const encoded = JSON.stringify(result, null, 2) + '\n', destination = root + `slot-targets-${context}-parity.json`;
if (process.argv.includes('--verify-only')) assert.equal(readFileSync(destination, 'utf8'), encoded); else writeFileSync(destination, encoded);
console.log(JSON.stringify({status:'PASS', modelId:MODEL_ID, context, workerCases:checks.length, uiContractAndRouteParity:true}));
