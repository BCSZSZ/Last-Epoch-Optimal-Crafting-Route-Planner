import { expect, it } from 'vitest';
import { itemKey } from '../core/catalog';
import { macroStep, predicateReached } from '../core/evaluation';
import { catalogForInputModel } from '../core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../core/intrinsic';
import { RuleEngine } from '../core/rules';
import { targetReached } from '../core/target';
import type { AtomicAction, Item, Macro, PlanRequest } from '../core/types';
import { compactProgram } from './compact-program';
import { trainingCases } from './learning-cases';
import { generateLearningPrograms, searchLearningPrograms } from './learning-solver';

it('learns enough generic program rules to meet all three expert examples and the stronger 7732 control', () => {
  const scores = [0, 0, 0];
  for (const fixture of trainingCases()) {
    const engine = new RuleEngine(catalogForInputModel(fixture.request.inputModel)), workspace = new IntrinsicWorkspace(engine, fixture.request);
    const teacher = evaluateIntrinsic(workspace, fixture.teacher);
    for (const round of [0, 1, 2] as const) {
      const report = searchLearningPrograms(workspace, round).primary;
      if (report && (report.score.lower > teacher.score.upper + 1e-9 || report.score.lower >= teacher.score.upper - 1e-9 &&
        report.expectedFpGivenSuccess!.upper <= teacher.expectedFpGivenSuccess!.lower + 1e-7)) scores[round]++;
    }
    const final = searchLearningPrograms(workspace, 2).primary!;
    const strongest = evaluateIntrinsic(workspace, fixture.bestKnown);
    expect(final.scoreEstimate).toBeGreaterThanOrEqual(strongest.scoreEstimate - 1e-9);
    expect(final.expectedFpGivenSuccess!.upper).toBeLessThanOrEqual(65);
    expect(final.intrinsic.nonTerminatingStates).toBe(0);
  }
  expect(scores).toEqual([0, 2, 3]);
});

const includesWindow = (values: readonly Macro[]): boolean => values.some(macro => macro.kind === 'conditional' ?
  includesWindow(macro.then) || includesWindow(macro.otherwise ?? []) : macro.kind === 'repeat' && macro.action.kind === 'havoc' &&
  macro.until.kind === 'exists' && macro.until.selector.sealable && macro.until.selector.minTier === 1 && macro.until.selector.maxTier === 2);
const riskOrder = (values: readonly Macro[]): string => values.flatMap(macro => macro.kind === 'conditional' ?
  [riskOrder(macro.then), riskOrder(macro.otherwise ?? [])] : macro.kind === 'seal' ? ['S'] : macro.kind === 'removal' ? ['R'] : []).join('');

it('a new seal window is generated in either edit order without adding a case-specific family', () => {
  const fixture = trainingCases()[1], engine = new RuleEngine(catalogForInputModel(fixture.request.inputModel));
  const windows = generateLearningPrograms(fixture.request, engine, 2).filter(route => includesWindow(route.macros));
  expect(windows.some(route => riskOrder(route.macros).startsWith('R') && riskOrder(route.macros).includes('S'))).toBe(true);
  expect(windows.some(route => riskOrder(route.macros).startsWith('S') && riskOrder(route.macros).includes('R'))).toBe(true);
});

type Instruction = { macro: Macro; next: number; yes: number; no: number };
function compile(values: readonly Macro[]) {
  const nodes: Instruction[] = [];
  const sequence = (values: readonly Macro[], next: number): number => {
    for (let index = values.length - 1; index >= 0; index--) {
      const macro = values[index];
      const yes = macro.kind === 'conditional' ? sequence(macro.then, next) : -1;
      const no = macro.kind === 'conditional' ? sequence(macro.otherwise ?? [], next) : -1;
      nodes.push({ macro, next, yes, no }); next = nodes.length - 1;
    }
    return next;
  };
  return { nodes, entry: sequence(values, -1) };
}
function nextAction(program: ReturnType<typeof compile>, pc: number, item: Item, request: PlanRequest, engine: RuleEngine):
  { kind: 'SUCCESS' | 'FAILURE' } | { kind: 'ACTION'; action: AtomicAction; next: number } {
  for (let guard = 0; guard < 200; guard++) {
    if (targetReached(item, request.target)) return { kind: 'SUCCESS' };
    if (pc < 0) return { kind: 'FAILURE' };
    const node = program.nodes[pc];
    if (node.macro.kind === 'conditional') { pc = predicateReached(item, node.macro.when, request, engine) ? node.yes : node.no; continue; }
    const step = macroStep(node.macro, item, request, engine);
    if (step === 'SKIP') { pc = node.next; continue; }
    if (step === 'INAPPLICABLE') return { kind: 'FAILURE' };
    return { kind: 'ACTION', action: step.action, next: step.advance ? node.next : pc };
  }
  throw new Error('Unexpected zero-action controller loop');
}

it('slot compaction preserves every next atomic action on all reachable outcomes of selected generated programs', () => {
  let checked = 0;
  for (const fpType of ['NORMAL', 'BLOOD'] as const) for (const fixture of trainingCases(fpType)) {
    const request = fixture.request, engine = new RuleEngine(catalogForInputModel(request.inputModel));
    const raw = generateLearningPrograms(request, engine, 2, { compact: false });
    const selected = [raw.find(route => includesWindow(route.macros) && riskOrder(route.macros).startsWith('R')),
      raw.find(route => includesWindow(route.macros) && riskOrder(route.macros).startsWith('S')), { macros: fixture.teacher.macros },
      { macros: fixture.bestKnown.macros }].filter(row => row !== undefined);
    for (const candidate of selected) {
      const original = compile(candidate.macros), compact = compile(compactProgram(candidate.macros, request, engine.catalog));
      const queue = [{ item: request.item, left: original.entry, right: compact.entry }], seen = new Set<string>();
      for (let at = 0; at < queue.length; at++) {
        const row = queue[at], key = `${itemKey(row.item)}|${row.left}|${row.right}`;
        if (seen.has(key)) continue;
        seen.add(key); expect(seen.size).toBeLessThan(5000);
        const left = nextAction(original, row.left, row.item, request, engine), right = nextAction(compact, row.right, row.item, request, engine);
        expect(left.kind).toBe(right.kind);
        if (left.kind !== 'ACTION' || right.kind !== 'ACTION') continue;
        expect(left.action).toEqual(right.action);
        const law = engine.demandTransition(row.item, left.action, request.craftingContext, { constraints: request.constraints });
        for (const exit of law.outcomes) if (!exit.abort && exit.probability.upper > 0)
          queue.push({ item: exit.item, left: left.next, right: right.next });
      }
      checked += seen.size;
    }
  }
  expect(checked).toBeGreaterThan(100);
});

it('does not apply identity facts across unsupported identity-changing actions', () => {
  const fixture = trainingCases()[0], engine = new RuleEngine(catalogForInputModel(fixture.request.inputModel));
  const values: Macro[] = [{ kind: 'once', action: { kind: 'redemption', glyph: 'hope' } }, ...fixture.teacher.macros];
  expect(compactProgram(values, fixture.request, engine.catalog)).toBe(values);
});
