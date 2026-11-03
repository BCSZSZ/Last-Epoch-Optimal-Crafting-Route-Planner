/** Actual production atomic sampling vs independent finite-FP recurrence; no client experiment. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { catalogForInputModel } from '../src/core/input-model';
import { macroStep, predicateReached } from '../src/core/evaluation';
import { seededRandom } from '../src/core/random';
import { RuleEngine } from '../src/core/rules';
import { targetReached } from '../src/core/target';
import type { Macro, PlanRequest } from '../src/core/types';

const audit = JSON.parse(readFileSync('research/redemption-7272-audit.json', 'utf8'));
const independent = JSON.parse(readFileSync('research/redemption-7272-independent.json', 'utf8'));
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
const samples = 50000, rows = [];
for (const label of ['PUBLISHED_EQUAL', 'SAME_IDS_REAL_WEIGHTS_EXACT_BASE', 'GLOVES_RARE_PAIR_REAL_WEIGHTS']) {
  const scenario = audit.cases.find((row: { label: string }) => row.label === label);
  const expected = independent.cases.find((row: { label: string }) => row.label === label);
  const req: PlanRequest = { ...audit.sourceInput, inputModel: scenario.inputModel,
    item: { ...audit.sourceInput.item, baseId: scenario.baseId },
    target: { requirements: scenario.targetIds.map((id: number) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) } };
  const engine = new RuleEngine(catalogForInputModel(req.inputModel));
  const { instructions, entry } = program(scenario.report.route.macros);
  const draw = seededRandom(`redemption-7272-independent-check|20261103|${label}`);
  let successes = 0;
  for (let trial = 0; trial < samples; trial++) {
    // Re-audited ordinary L100 exalted-generation mixture, not a universal ritual-item prior.
    const upper = draw() < 0.11 ? 56 : 48;
    let fp = 32 + Math.floor(draw() * (upper - 32 + 1));
    let item = req.item, pc = entry;
    for (let count = 0; count < 4096; count++) {
      if (targetReached(item, req.target)) { successes++; break; }
      if (pc < 0 || fp === 0) break;
      const instruction = instructions[pc], { macro } = instruction;
      if (macro.kind === 'conditional') {
        pc = predicateReached(item, macro.when, req, engine) ? instruction.yes : instruction.no; continue;
      }
      const step = macroStep(macro, item, req, engine);
      if (step === 'SKIP') { pc = instruction.next; continue; }
      assert.notEqual(step, 'INAPPLICABLE');
      if (step === 'INAPPLICABLE') throw new Error('Unexpected inapplicable step');
      const sample = engine.sample(item, fp, step.action, req.craftingContext, draw);
      assert.deepEqual(sample.issues, []); assert(sample.outcome);
      item = sample.outcome.item; fp = sample.outcome.fp;
      if (sample.outcome.abort) break;
      if (step.advance) pc = instruction.next;
      assert(count < 4095, 'Computation guard is not a game failure');
    }
  }
  const exact = expected.normalNaturalL100CompletionProbability;
  const estimate = successes / samples;
  const tolerance = 5 * Math.sqrt(exact * (1 - exact) / samples) + 1 / samples;
  assert(Math.abs(estimate - exact) <= tolerance);
  const row = { label, samples, successes, estimate, exactReference: exact, predeclaredTolerance: tolerance, pass: true };
  rows.push(row); console.log(JSON.stringify(row));
}
const output = JSON.stringify({ schemaVersion: 1, qualification: 'Production RuleEngine.sample vs separately implemented Python finite-budget recurrence; deterministic seeds, three fixed cases, five-binomial-SE tolerance declared before sampling. This is model validation, not gameplay sampling.', rows }, null, 2) + '\n';
if (process.argv.includes('--verify-only')) assert.equal(readFileSync('research/redemption-7272-sampling.json', 'utf8'), output);
else writeFileSync('research/redemption-7272-sampling.json', output);
