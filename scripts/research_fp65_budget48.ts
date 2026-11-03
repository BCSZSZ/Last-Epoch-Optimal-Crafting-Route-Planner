/** Compare two real-catalog controllers with means near65FP at an actual48FP balance. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { macroStep, predicateReached } from '../src/core/evaluation';
import { compileTemplates } from '../src/core/hierarchy';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { seededRandom } from '../src/core/random';
import { RuleEngine } from '../src/core/rules';
import { targetReached } from '../src/core/target';
import type { Macro, PlanRequest } from '../src/core/types';

type Instruction = { macro: Macro; next: number; yes: number; no: number };
function program(macros: readonly Macro[]) {
  const instructions: Instruction[] = [];
  const sequence = (values: readonly Macro[], next: number): number => {
    for (let i = values.length - 1; i >= 0; i--) {
      const macro = values[i];
      const yes = macro.kind === 'conditional' ? sequence(macro.then, next) : -1;
      const no = macro.kind === 'conditional' ? sequence(macro.otherwise ?? [], next) : -1;
      instructions.push({ macro, next, yes, no }); next = instructions.length - 1;
    }
    return next;
  };
  return { instructions, entry: sequence(macros, -1) };
}
const frozen = JSON.parse(readFileSync('research/fixtures/redemption-7272-public-input.json', 'utf8'));
const blood: PlanRequest = { ...frozen.input, modelId: MODEL_ID, inputModel: 'AUDITED', item: { ...frozen.input.item, fpType: 'BLOOD' } };
const ice: PlanRequest = { ...blood, item: { ...blood.item, baseId: '4:0', fpType: 'ICE',
  affixes: [[2,7],[26,7],[7,3],[10,2]].map(([id,tier]) => ({ id, tier, slot: 'ordinary', roll: null })) },
  target: { requirements: [4,5].map(id => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) } };
const samples = 100000, confidence = 0.99, rows = [];
for (const [label, request] of [['BLOOD_7272_INTERLEAVED', blood], ['ICE_GLOVES_REDEMPTION_FIRST_HIT', ice]] as const) {
  const engine = new RuleEngine(), templates = compileTemplates(request, engine)!.templates;
  const route = templates.find(row => label.startsWith('BLOOD') ? row.family === 'INTERLEAVED_MIN_SEAL' && row.macros[0].kind === 'removal' :
    row.family === 'REDEMPTION_ANY_THEN_ACQUIRE' && row.description?.includes('准备后封T2'))!;
  assert(route);
  const metrics = evaluateIntrinsic(new IntrinsicWorkspace(engine, request), route);
  assert.equal(metrics.intrinsic.decision, 'RETAINED');
  const mean = metrics.expectedFpGivenSuccess!;
  assert(mean.lower > 64 && mean.upper <= 65);
  const { instructions, entry } = program(route.macros);
  const draw = seededRandom(`fp65-budget48|20261103|${label}`);
  let successes = 0;
  for (let trial = 0; trial < samples; trial++) {
    let fp = 48, item = request.item, pc = entry;
    for (let count = 0; count < 4096; count++) {
      if (targetReached(item, request.target)) { successes++; break; }
      if (fp === 0 || pc < 0) break;
      const instruction = instructions[pc], { macro } = instruction;
      if (macro.kind === 'conditional') {
        pc = predicateReached(item, macro.when, request, engine) ? instruction.yes : instruction.no; continue;
      }
      const step = macroStep(macro, item, request, engine);
      if (step === 'SKIP') { pc = instruction.next; continue; }
      assert.notEqual(step, 'INAPPLICABLE'); if (step === 'INAPPLICABLE') throw new Error('Inapplicable stage');
      const result = engine.sample(item, fp, step.action, request.craftingContext, draw);
      assert.deepEqual(result.issues, []); assert(result.outcome);
      item = result.outcome.item; fp = result.outcome.fp;
      if (result.outcome.abort) break;
      if (step.advance) pc = instruction.next;
      assert(count < 4095, 'A computation guard is not a game failure');
    }
  }
  const estimate = successes / samples;
  // Union bound for both returned probability intervals; fixed before observing any sample.
  const error = Math.sqrt(Math.log(4 / (1 - confidence)) / (2 * samples));
  const row = { label, request, route, intrinsic: metrics.intrinsic, operationSuccess: metrics.score,
    successPathMeanFp: mean, initialFp: 48, samples, successes, finiteCompletionEstimate: estimate,
    finiteCompletionInterval: { lower: Math.max(0, estimate - error), upper: Math.min(1, estimate + error) },
    budgetCompletionGivenOperationSuccessEstimate: estimate / metrics.scoreEstimate,
    budgetCompletionGivenOperationSuccessInterval: { lower: Math.max(0, estimate - error) / metrics.score.upper,
      upper: Math.min(1, (estimate + error) / metrics.score.lower) } };
  rows.push(row);
  console.log(JSON.stringify({ label, operationSuccess: metrics.scoreEstimate, successMeanFp: mean, finiteCompletionEstimate: estimate, samples, error }));
}
const output = JSON.stringify({ schemaVersion: 1, modelId: MODEL_ID, confidence,
  qualification: 'Two fixed real-catalog controllers with different structures and FP types; nominal independent-draw model. Actual48FP settlement includes final-action completion, low-FP preservation, NG and critical refunds. Joint99% Hoeffding sampling intervals across both cases. A conditional FP mean does not determine a finite-budget success probability; these are examples, not all-equipment averages or client measurements.', rows }, null, 2) + '\n';
if (process.argv.includes('--verify-only')) assert.equal(readFileSync('research/fp65-budget48.json', 'utf8'), output);
else writeFileSync('research/fp65-budget48.json', output);
