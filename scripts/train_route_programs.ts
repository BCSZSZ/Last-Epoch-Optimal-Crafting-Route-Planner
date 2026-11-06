/** Reproducible rounds of example-guided program synthesis; no neural model or guessed probabilities. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { evaluateCompletion } from '../src/core/completion';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import type { IntrinsicReport } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';
import { trainingCases, validationCases } from '../src/research/learning-cases';
import type { LearningCase } from '../src/research/learning-cases';
import { compareLearningReports, ROUND_NAMES, searchLearningPrograms } from '../src/research/learning-solver';
import type { LearningRound } from '../src/research/learning-solver';

function meets(candidate: IntrinsicReport | null, reference: IntrinsicReport): boolean {
  if (reference.intrinsic.decision !== 'RETAINED' || !candidate || candidate.intrinsic.decision !== 'RETAINED') return false;
  if (candidate.score.lower > reference.score.upper + 1e-9) return true;
  return candidate.score.lower >= reference.score.upper - 1e-9 && candidate.expectedFpGivenSuccess !== null &&
    reference.expectedFpGivenSuccess !== null && candidate.expectedFpGivenSuccess.upper <= reference.expectedFpGivenSuccess.lower + 1e-7;
}
function setup(item: LearningCase) {
  const engine = new RuleEngine(catalogForInputModel(item.request.inputModel)), workspace = new IntrinsicWorkspace(engine, item.request);
  const teacher = evaluateIntrinsic(workspace, item.teacher, undefined, true), known = evaluateIntrinsic(workspace, item.bestKnown, undefined, true);
  const reference = [teacher, known].filter(row => row.intrinsic.decision === 'RETAINED').sort(compareLearningReports)[0] ?? teacher;
  return { item, engine, workspace, teacher, reference };
}
function result(row: ReturnType<typeof setup>, round: LearningRound) {
  const search = searchLearningPrograms(row.workspace, round), primary = search.primary;
  return { caseId: row.item.id, ...search, teacherMet: meets(primary, row.teacher), strongestReferenceMet: meets(primary, row.reference),
    completion: primary ? evaluateCompletion(row.engine, row.item.request, primary.route) : null };
}
const training = trainingCases().map(setup);
const quiet = process.argv.includes('--quiet');
const rounds = ([0, 1, 2, 3] as const).map(round => {
  const cases = training.map(row => result(row, round));
  if (!quiet) console.log(JSON.stringify({ round, name: ROUND_NAMES[round], teachersMet: cases.filter(row => row.teacherMet).length,
    referencesMet: cases.filter(row => row.strongestReferenceMet).length, cases: cases.map(row => ({ id: row.caseId,
      candidates: row.generated, unresolved: row.unresolved, p: row.primary?.scoreEstimate, fp: row.primary?.expectedFpGivenSuccess,
      completion: row.completion?.probability })) }));
  return { round, name: ROUND_NAMES[round], cases };
});
const last = rounds.at(-1)!;
assert(last.cases.every(row => row.teacherMet && row.strongestReferenceMet), 'Final round did not meet all three demonstrated and best-known routes');
// Choose the smallest sufficient grammar from training evidence alone, before reading held-out cases.
const selectedRound = rounds.find(row => row.cases.every(item => item.teacherMet && item.strongestReferenceMet))!.round;
const validation = [];
if (!process.argv.includes('--training-only')) for (const item of validationCases()) {
  const row = setup(item), checked = result(row, selectedRound);
  validation.push({ input: item.request, teacher: row.teacher, reference: row.reference, ...checked });
  if (!quiet) console.log(JSON.stringify({ validation: item.id, teacherRetained: row.teacher.intrinsic.decision === 'RETAINED',
    teacherMet: checked.teacherMet, referenceMet: checked.strongestReferenceMet, generated: checked.generated, p: checked.primary?.scoreEstimate,
    fp: checked.primary?.expectedFpGivenSuccess, completion: checked.completion?.probability }));
}
assert(validation.filter(row => row.teacher.intrinsic.decision === 'RETAINED').every(row => row.teacherMet), 'Held-out teacher regression');
assert(validation.filter(row => row.reference.intrinsic.decision === 'RETAINED').every(row => row.strongestReferenceMet), 'Held-out strongest-reference regression');
const evidence = { schemaVersion: 1, modelId: MODEL_ID, status: 'TRAINING_TARGETS_MET',
  method: 'EXAMPLE_GUIDED_PROGRAM_SYNTHESIS', probabilityModelTrained: false, teacherProgramsPassedToGenerator: false,
  ranking: 'PASS_15_PERCENT_AND_65FP_THEN_OPERATION_SUCCESS_DESC_AND_SUCCESS_FP_ASC',
  selectedRound, selectionRule: 'FIRST_ROUND_MEETING_ALL_TRAINING_TEACHERS_AND_STRONGEST_REFERENCES',
  training: training.map(row => ({ caseId: row.item.id, input: row.item.request, teacher: row.teacher, reference: row.reference,
    teacherCompletion: evaluateCompletion(row.engine, row.item.request, row.teacher.route) })), rounds, validation,
  sources: Object.fromEntries(['src/generated/model.json', 'src/research/learning-cases.ts', 'src/core/program-search.ts', 'src/core/program-compact.ts', 'src/research/learning-solver.ts', 'src/research/compact-program.ts', 'scripts/train_route_programs.ts']
    .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  qualification: 'Research training harness for the shared production program generator. Three NORMAL chest examples guide grammar revisions. Held-out inputs are not read by the generator. Within this bounded grammar all generated candidates are evaluated; unresolved numerical cases remain explicit. Does not establish global optimality or correctness of all crafting mechanisms. Passing a ranking target need not improve every reported metric.' };
const filename = process.argv.includes('--training-only') ? 'research/example-learning-training.json' : 'research/example-learning-rounds.json';
const encoded = JSON.stringify(evidence, null, 2) + '\n';
if (process.argv.includes('--verify-only')) assert.equal(readFileSync(filename, 'utf8'), encoded); else writeFileSync(filename, encoded);
console.log(JSON.stringify({ status: evidence.status, trainingCases: training.length, rounds: rounds.length,
  selectedRound, roundTargetsMet: rounds.map(row => row.cases.filter(item => item.teacherMet).length),
  heldOutCases: validation.length, heldOutTeachersMet: validation.filter(row => row.teacherMet).length,
  heldOutBaselineOutsidePolicy: validation.filter(row => row.teacher.intrinsic.decision !== 'RETAINED').length }));
