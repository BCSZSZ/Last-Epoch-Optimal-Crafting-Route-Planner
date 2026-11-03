import { itemKey, ordinary } from './catalog';
import { macroStep, predicateReached, EvaluationInterruptedError, EvaluationLimitError } from './evaluation';
import type { RouteReport } from './evaluation';
import { exact, Interval, nextDown, ONE, ZERO } from './interval';
import { tierPermutations } from './probability';
import { RuleEngine } from './rules';
import type { DemandDistribution } from './rules';
import { targetReached } from './target';
import { redemptionCertificate } from './redemption-bound';
import { MAXIMUM_SUCCESS_FP, maximumSuccessFp } from './policy';
import type { Item, Macro, PlanRequest, Route } from './types';

type Bounds = { readonly lower: number; readonly upper: number };
export interface IntrinsicStatistics {
  readonly metric: 'OPERATION_SUCCESS_AND_SUCCESS_PATH_FP_V2';
  readonly decision: 'RETAINED' | 'ABANDONED' | 'UNRESOLVED';
  readonly reason: 'BELOW_MINIMUM_SUCCESS' | 'ABOVE_MAXIMUM_SUCCESS_FP' | 'NO_SUCCESS_EXIT' | null;
  readonly evaluatedThroughStage: number;
  readonly probabilityMeaning: 'FULL_ROUTE' | 'PREFIX_SURVIVAL_UPPER_BOUND';
  readonly fpMeaning: 'FULL_ROUTE_GIVEN_SUCCESS' | 'PREFIX_GIVEN_PREFIX_SURVIVAL' | 'LOWER_BOUND_GIVEN_FINAL_SUCCESS';
  readonly minimumSuccess: 0.15;
  readonly maximumSuccessFp: typeof MAXIMUM_SUCCESS_FP;
  readonly stages: readonly { readonly successfulFpMoment: Bounds }[];
  readonly residualProbabilityBound: number;
  readonly nonTerminatingStates: number;
  readonly successfulFpLowerBound: number | null;
  readonly auxiliaryTotalsAvailable: boolean;
  readonly preflight?: { readonly rule: string; readonly perCastSuccessUpperBound: number };
}
export type IntrinsicReport = RouteReport & { readonly intrinsic: IntrinsicStatistics };

export function practicalDecision(probability: Bounds, successfulFp: Bounds | null, limit = MAXIMUM_SUCCESS_FP): 'RETAINED' | 'ABANDONED' | 'UNRESOLVED' {
  if (probability.upper < 0.15 || (successfulFp && successfulFp.lower > limit)) return 'ABANDONED';
  return probability.lower >= 0.15 && successfulFp !== null && successfulFp.upper <= limit ? 'RETAINED' : 'UNRESOLVED';
}

interface Instruction { macro: Macro; next: number; yes: number; no: number; stage: number }
interface Edge { to: number; p: Interval; cost: Interval; attempts: number }
interface Node { item: Item; pc: number; left: number | undefined; stage: number; terminal: 'SUCCESS' | 'FAILURE' | null; reason?: string; edges: Edge[] }

/** Shared only inside one planning request. Keys retain native IDs/order and the full request context. */
export class IntrinsicWorkspace {
  readonly atoms = new Map<string, DemandDistribution>();
  readonly results = new Map<string, IntrinsicReport>();
  cacheHits = 0;
  constructor(readonly engine: RuleEngine, readonly request: PlanRequest) {}
  atom(item: Item, action: Parameters<RuleEngine['demandTransition']>[1]): DemandDistribution {
    const key = `${itemKey(item)}|${JSON.stringify(action)}`;
    const cached = this.atoms.get(key);
    if (cached) { this.cacheHits++; return cached; }
    const value = this.engine.demandTransition(item, action, this.request.craftingContext, {
      constraints: this.request.constraints, trackRolls: this.request.target.requirements.some((row) => row.minRollByte !== undefined),
      maxOutcomes: Math.min(200000, Math.max(1000, this.request.search.maxStates * 64)),
    });
    if (this.atoms.size >= 4096) this.atoms.delete(this.atoms.keys().next().value!);
    this.atoms.set(key, value); return value;
  }
}

function compile(macros: readonly Macro[]): { instructions: Instruction[]; entry: number } {
  const instructions: Instruction[] = [];
  const sequence = (values: readonly Macro[], next: number, outer?: number): number => {
    for (let index = values.length - 1; index >= 0; index--) {
      const macro = values[index], stage = outer ?? index;
      const yes = macro.kind === 'conditional' ? sequence(macro.then, next, stage) : -1;
      const no = macro.kind === 'conditional' ? sequence(macro.otherwise ?? [], next, stage) : -1;
      instructions.push({ macro, next, yes, no, stage }); next = instructions.length - 1;
    }
    return next;
  };
  return { entry: sequence(macros, -1), instructions };
}

function buildGraph(workspace: IntrinsicWorkspace, route: Route, prefix: boolean, shouldStop?: () => boolean): Node[] {
  const { engine, request } = workspace;
  const program = compile(route.macros);
  const nodes: Node[] = [], keys = new Map<string, number>();
  const intern = (item: Item, pc: number, left: number | undefined): number => {
    const key = `${pc}|${left ?? '*'}|${itemKey(item)}`;
    const found = keys.get(key); if (found !== undefined) return found;
    if (nodes.length >= request.search.maxStates) throw new EvaluationLimitError('达到无余额状态预算，尚未完成评价');
    const done = targetReached(item, request.target);
    const terminal = done || (pc < 0 && prefix) ? 'SUCCESS' : pc < 0 ? 'FAILURE' : null;
    const index = nodes.length; keys.set(key, index);
    nodes.push({ item, pc, left, stage: pc < 0 ? route.macros.length : program.instructions[pc].stage,
      terminal, reason: terminal === 'FAILURE' ? 'ROUTE_EXHAUSTED' : undefined, edges: [] }); return index;
  };
  const failure = (item: Item, reason: string, stage: number): number => {
    const key = `FAILURE|${stage}|${reason}`;
    const found = keys.get(key); if (found !== undefined) return found;
    const index = nodes.length; keys.set(key, index);
    nodes.push({ item, pc: -1, left: undefined, stage, terminal: 'FAILURE', reason, edges: [] }); return index;
  };
  intern(request.item, program.entry, request.constraints.maxAttempts);
  let edgeCount = 0;
  for (let cursor = 0; cursor < nodes.length; cursor++) {
    if ((cursor & 15) === 0 && shouldStop?.()) throw new EvaluationInterruptedError('无余额评价已取消或超时');
    const node = nodes[cursor]; if (node.terminal) continue;
    const instruction = program.instructions[node.pc], macro = instruction.macro;
    const direct = (pc: number) => node.edges.push({ to: intern(node.item, pc, node.left), p: ONE, cost: ZERO, attempts: 0 });
    if (macro.kind === 'conditional') { direct(predicateReached(node.item, macro.when, request, engine) ? instruction.yes : instruction.no); continue; }
    const step = macroStep(macro, node.item, request, engine);
    if (step === 'SKIP') { direct(instruction.next); continue; }
    if (step === 'INAPPLICABLE' || node.left === 0) {
      node.terminal = 'FAILURE'; node.reason = step === 'INAPPLICABLE' ? 'INAPPLICABLE_NEXT_STAGE' : 'OPERATION_LIMIT'; continue;
    }
    const distribution = workspace.atom(node.item, step.action);
    if (distribution.issues.length) { node.terminal = 'FAILURE'; node.reason = distribution.issues[0].code; continue; }
    if ((macro.kind === 'repeat' || macro.kind === 'chaos') && step.action.kind === 'havoc' && node.left === undefined) {
      const indices = node.item.affixes.flatMap((row, i) => row.slot === 'ordinary' ? [i] : []);
      const layouts = tierPermutations(ordinary(node.item).map((row) => row.tier));
      const goals = layouts.map((tiers): Item => {
        const affixes = [...node.item.affixes]; indices.forEach((index, i) => { affixes[index] = { ...affixes[index], tier: tiers[i] }; });
        return { ...node.item, affixes };
      }).filter((item) => targetReached(item, request.target) || predicateReached(item, macro.kind === 'repeat' ? macro.until : { kind: 'exists', selector: macro.selector }, request, engine));
      if (!goals.length) { node.terminal = 'FAILURE'; node.reason = 'NON_TERMINATING_MACRO'; continue; }
      const fee = distribution.outcomes.reduce((value, row) => value.add(new Interval(row.fpMoment.lower, row.fpMoment.upper)), ZERO);
      const attempts = (layouts.length - 1) / goals.length;
      for (const goal of goals) node.edges.push({ to: intern(goal, macro.kind === 'chaos' ? node.pc : instruction.next, undefined), p: exact(1).div(exact(goals.length)),
        cost: fee.mul(exact(attempts)).div(exact(goals.length)), attempts });
    } else {
      for (const outcome of distribution.outcomes) node.edges.push({
        to: outcome.abort ? failure(outcome.item, outcome.abort, instruction.stage) : intern(outcome.item, step.advance ? instruction.next : node.pc,
          node.left === undefined ? undefined : node.left - 1),
        p: new Interval(outcome.probability.lower, outcome.probability.upper), cost: new Interval(outcome.fpMoment.lower, outcome.fpMoment.upper), attempts: 1,
      });
    }
    edgeCount += node.edges.length;
    if (edgeCount > Math.min(2000000, request.search.maxStates * 128)) throw new EvaluationLimitError('达到无余额转移预算，尚未完成评价');
  }
  return nodes;
}

interface LinearSystem { active: number[]; allowed: Set<number>; h: Float64Array }
/** Certifies h >= 1 + Qh using outward-rounded probabilities; it bounds all subsequent Bellman residuals. */
function system(nodes: readonly Node[], successOnly: boolean, shouldStop?: () => boolean): LinearSystem {
  const reverse = nodes.map(() => [] as number[]), reachable = new Set<number>();
  nodes.forEach((node, index) => { for (const edge of node.edges) if (edge.p.upper > 0) reverse[edge.to].push(index); });
  const queue = nodes.flatMap((node, index) => node.terminal === 'SUCCESS' || (!successOnly && node.terminal === 'FAILURE') ? [index] : []);
  for (const index of queue) reachable.add(index);
  for (let i = 0; i < queue.length; i++) for (const previous of reverse[queue[i]]) if (!reachable.has(previous)) { reachable.add(previous); queue.push(previous); }
  const active = nodes.flatMap((node, index) => !node.terminal && reachable.has(index) ? [index] : []), allowed = new Set(active);
  const h = new Float64Array(nodes.length), value = new Float64Array(nodes.length);
  if (!active.length) return { active, allowed, h };
  for (let iteration = 0; iteration < 10000; iteration++) {
    if ((iteration & 15) === 0 && shouldStop?.()) throw new EvaluationInterruptedError('吸收核求解已取消或超时');
    let residual = 0;
    for (let k = active.length - 1; k >= 0; k--) {
      const index = active[k]; let next = 1, self = 0;
      for (const edge of nodes[index].edges) if (allowed.has(edge.to)) {
        if (edge.to === index) self += edge.p.midpoint; else next += edge.p.midpoint * value[edge.to];
      }
      next /= 1 - self;
      residual = Math.max(residual, Math.abs(next - value[index])); value[index] = next;
    }
    if (iteration < 2 || (residual > 1e-8 && iteration % 32 !== 31)) continue;
    let margin = Infinity;
    for (const index of active) {
      let q = ZERO;
      for (const edge of nodes[index].edges) if (allowed.has(edge.to)) q = q.add(edge.p.mul(exact(value[edge.to] + 1)));
      margin = Math.min(margin, exact(value[index] + 1).sub(q).lower);
    }
    if (margin <= 1e-8) continue;
    const scale = (1 + 1e-6) / margin;
    for (const index of active) h[index] = (value[index] + 1) * scale;
    let certified = true;
    for (const index of active) {
      let q = ZERO;
      for (const edge of nodes[index].edges) if (allowed.has(edge.to)) q = q.add(edge.p.mul(exact(h[edge.to])));
      if (exact(h[index]).sub(q).lower < 1) { certified = false; break; }
    }
    if (certified) return { active, allowed, h };
  }
  throw new EvaluationLimitError('尚未证实吸收核的终止性和数值残差界');
}

function solve(nodes: readonly Node[], sys: LinearSystem, source: (index: number) => Interval, shouldStop?: () => boolean): { values: Float64Array; bounds: Interval[]; residual: number } {
  const values = new Float64Array(nodes.length), b = nodes.map((_, index) => source(index));
  for (let iteration = 0; iteration < 10000; iteration++) {
    if ((iteration & 15) === 0 && shouldStop?.()) throw new EvaluationInterruptedError('奖励核求解已取消或超时');
    let change = 0;
    for (let k = sys.active.length - 1; k >= 0; k--) {
      const index = sys.active[k]; let next = b[index].midpoint, self = 0;
      for (const edge of nodes[index].edges) if (sys.allowed.has(edge.to)) {
        if (edge.to === index) self += edge.p.midpoint; else next += edge.p.midpoint * values[edge.to];
      }
      next /= 1 - self; change = Math.max(change, Math.abs(next - values[index])); values[index] = next;
    }
    if (change < 1e-10) break;
    if (iteration === 9999) throw new EvaluationLimitError('奖励核未在执行预算内收敛');
  }
  let residual = 0;
  for (const index of sys.active) {
    let next = b[index];
    for (const edge of nodes[index].edges) if (sys.allowed.has(edge.to)) next = next.add(edge.p.mul(exact(values[edge.to])));
    const error = next.sub(exact(values[index])); residual = Math.max(residual, -error.lower, error.upper);
  }
  const bounds = nodes.map((_, index) => {
    const error = exact(sys.h[index]).mul(exact(residual));
    return new Interval(Math.max(0, exact(values[index]).sub(error).lower), exact(values[index]).add(error).upper);
  });
  return { values, bounds, residual };
}

/** Finite chain: if every node has a positive-lower-bound path to success and no NG exit, P=1. */
function certainlySucceeds(nodes: readonly Node[]): boolean {
  if (nodes.some((node) => node.terminal === 'FAILURE')) return false;
  const reverse = nodes.map(() => [] as number[]);
  nodes.forEach((node, index) => node.edges.forEach((edge) => { if (edge.p.lower > 0) reverse[edge.to].push(index); }));
  const queue = nodes.flatMap((node, index) => node.terminal === 'SUCCESS' ? [index] : []), seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) for (const previous of reverse[queue[i]]) if (!seen.has(previous)) { seen.add(previous); queue.push(previous); }
  return seen.size === nodes.length;
}

/** Monotone finite-horizon reward bound; future costs are zero. No assumption of a geometric Redemption hit rate. */
function expensiveRepeatCertificate(nodes: readonly Node[], limit: number, shouldStop?: () => boolean): number | null {
  let values = new Float64Array(nodes.length);
  for (let iteration = 0; iteration < 64; iteration++) {
    if (shouldStop?.()) throw new EvaluationInterruptedError('重复费用下界计算已取消或超时');
    const next = new Float64Array(nodes.length);
    for (let index = 0; index < nodes.length; index++) {
      let sum = 0;
      for (const edge of nodes[index].edges) sum += (nodes[index].stage === 0 ? Math.max(0, edge.cost.lower) : 0) + Math.max(0, edge.p.lower) * values[edge.to];
      // Standard nonnegative floating-point dot-product enclosure (3 rounded operations per edge).
      const n = 3 * nodes[index].edges.length + 1, u = Number.EPSILON / 2, gamma = 2 * n * u / (1 - n * u) + Number.EPSILON;
      next[index] = Math.max(0, nextDown(sum / (1 + gamma)));
    }
    values = next;
    if (values[0] > limit) return values[0];
  }
  return null;
}

function calculate(workspace: IntrinsicWorkspace, route: Route, prefix: boolean, shouldStop?: () => boolean): IntrinsicReport {
  const limit = maximumSuccessFp(workspace.engine.catalog.model);
  const nodes = buildGraph(workspace, route, prefix, shouldStop);
  const first = route.macros[0];
  if (!prefix && first?.kind === 'repeat' && first.action.kind === 'redemption' && certainlySucceeds(nodes)) {
    const bound = expensiveRepeatCertificate(nodes, limit, shouldStop);
    if (bound !== null) return { route, evaluationStatus: 'BOUNDED_NUMERICAL', score: ONE.report(), scoreEstimate: 1,
      expectedFpGivenSuccess: null, expectedFp: ZERO.report(), failedFpWaste: ZERO.report(), curve: [], quantiles: null,
      successQuantiles: null, consumption: [], attemptsByMacro: [], macroStatistics: [], failureReasons: [], states: nodes.length,
      intrinsic: { metric: 'OPERATION_SUCCESS_AND_SUCCESS_PATH_FP_V2', decision: 'ABANDONED', reason: 'ABOVE_MAXIMUM_SUCCESS_FP',
        evaluatedThroughStage: 1, probabilityMeaning: 'FULL_ROUTE', fpMeaning: 'LOWER_BOUND_GIVEN_FINAL_SUCCESS',
        minimumSuccess: 0.15, maximumSuccessFp: limit, stages: [], residualProbabilityBound: 0, nonTerminatingStates: 0,
        successfulFpLowerBound: bound, auxiliaryTotalsAvailable: false } };
  }
  const sys = system(nodes, true, shouldStop);
  const probability = solve(nodes, sys, (index) => nodes[index].edges.reduce((sum, edge) =>
    nodes[edge.to].terminal === 'SUCCESS' ? sum.add(edge.p) : sum, ZERO), shouldStop);
  nodes.forEach((node, index) => { if (node.terminal === 'SUCCESS') { probability.values[index] = 1; probability.bounds[index] = ONE; } });
  // Certified absorption plus exclusively successful terminal exits implies P=1 exactly.
  if (nodes.every((node, index) => node.terminal === 'SUCCESS' || (!node.terminal && sys.allowed.has(index)))) {
    nodes.forEach((_, index) => { probability.values[index] = 1; probability.bounds[index] = ONE; });
  }
  const p = probability.bounds[0].clamp(0, 1);
  let moment = ZERO;
  const stages: { successfulFpMoment: Bounds }[] = [];
  let fp: Interval | null = p.lower > 0 ? ZERO : null, evaluatedThroughStage = route.macros.length;
  let reason: IntrinsicStatistics['reason'] = p.upper === 0 ? 'NO_SUCCESS_EXIT' : p.upper < 0.15 ? 'BELOW_MINIMUM_SUCCESS' : null;
  // Accumulate rewards conditioned on FINAL success. This remains a valid lower bound even when future NG selects cheap branches.
  for (let stage = 0; stage < route.macros.length; stage++) {
    const reward = solve(nodes, sys, (index) => nodes[index].stage === stage ? nodes[index].edges.reduce((sum, edge) =>
      sum.add(edge.cost.mul(probability.bounds[edge.to])), ZERO) : ZERO, shouldStop);
    moment = moment.add(reward.bounds[0]);
    fp = p.lower > 0 ? moment.div(p).clamp(0, Infinity) : null;
    stages.push({ successfulFpMoment: reward.bounds[0].report() });
    if (!prefix && fp && fp.lower > limit) { reason = 'ABOVE_MAXIMUM_SUCCESS_FP'; evaluatedThroughStage = stage + 1; break; }
  }
  if (!reason && p.lower < 0.15 && p.upper >= 0.15) {
    // A threshold-straddling interval must remain unresolved, never silently abandoned.
  }
  const partialCost = reason === 'ABOVE_MAXIMUM_SUCCESS_FP' && evaluatedThroughStage < route.macros.length;
  const intrinsic: IntrinsicStatistics = {
    metric: 'OPERATION_SUCCESS_AND_SUCCESS_PATH_FP_V2', decision: reason ? 'ABANDONED' : practicalDecision(p, fp, limit), reason,
    evaluatedThroughStage, probabilityMeaning: prefix ? 'PREFIX_SURVIVAL_UPPER_BOUND' : 'FULL_ROUTE',
    fpMeaning: prefix ? 'PREFIX_GIVEN_PREFIX_SURVIVAL' : reason === 'ABOVE_MAXIMUM_SUCCESS_FP' && evaluatedThroughStage < route.macros.length ?
      'LOWER_BOUND_GIVEN_FINAL_SUCCESS' : 'FULL_ROUTE_GIVEN_SUCCESS',
    minimumSuccess: 0.15, maximumSuccessFp: limit, stages, residualProbabilityBound: probability.residual * (sys.h[0] ?? 0),
    nonTerminatingStates: nodes.filter((node, index) => node.reason === 'NON_TERMINATING_MACRO' || (!node.terminal && !sys.allowed.has(index))).length,
    successfulFpLowerBound: partialCost ? fp?.lower ?? null : null,
    auxiliaryTotalsAvailable: false,
  };
  // Total/NG costs are auxiliary. Only compute them for a fully evaluated, terminating retained route.
  let total = ZERO, waste = ZERO;
  if (!reason && intrinsic.nonTerminatingStates === 0) {
    const full = system(nodes, false, shouldStop);
    total = solve(nodes, full, (index) => nodes[index].edges.reduce((sum, edge) => sum.add(edge.cost), ZERO), shouldStop).bounds[0];
    waste = new Interval(Math.max(0, total.sub(moment).lower), Math.max(0, total.sub(moment).upper));
  }
  // Finite-balance arrays are deliberately empty. UI and adapters select the explicit metric contract.
  return { route, intrinsic: { ...intrinsic, auxiliaryTotalsAvailable: !reason && intrinsic.nonTerminatingStates === 0 }, evaluationStatus: 'BOUNDED_NUMERICAL', score: p.report(), scoreEstimate: p.midpoint,
    expectedFpGivenSuccess: partialCost ? null : fp?.report() ?? null, expectedFp: total.report(), failedFpWaste: waste.report(), curve: [],
    quantiles: null, successQuantiles: null, consumption: [], attemptsByMacro: [], macroStatistics: [],
    failureReasons: [...new Set(nodes.filter((node) => node.reason).map((node) => node.reason!))].map((reason) => ({ reason, probability: { lower: 0, upper: 1 } })),
    states: nodes.length };
}

/** Certified intrinsic evaluation; only irreversible prefix NG uses early survival pruning. */
export function evaluateIntrinsic(workspace: IntrinsicWorkspace, route: Route, shouldStop?: () => boolean, disablePruning = false): IntrinsicReport {
  const key = `${disablePruning}|${JSON.stringify(route.macros)}`;
  const cached = workspace.results.get(key); if (cached) { workspace.cacheHits++; return { ...cached, route }; }
  const certificate = disablePruning ? null : redemptionCertificate(workspace.request, route, workspace.engine);
  if (certificate) {
    const repeated = certificate.certainlyEventuallySucceeds;
    const score = repeated ? ONE.report() : { lower: 0, upper: certificate.perCastSuccessUpperBound };
    const result: IntrinsicReport = { route, evaluationStatus: 'BOUNDED_NUMERICAL', score, scoreEstimate: repeated ? 1 : certificate.perCastSuccessUpperBound / 2,
      expectedFpGivenSuccess: null, expectedFp: ZERO.report(), failedFpWaste: ZERO.report(), curve: [], quantiles: null,
      successQuantiles: null, consumption: [], attemptsByMacro: [], macroStatistics: [], failureReasons: [], states: 0,
      intrinsic: { metric: 'OPERATION_SUCCESS_AND_SUCCESS_PATH_FP_V2', decision: 'ABANDONED',
        reason: repeated ? 'ABOVE_MAXIMUM_SUCCESS_FP' : 'BELOW_MINIMUM_SUCCESS', evaluatedThroughStage: 1,
        probabilityMeaning: repeated ? 'FULL_ROUTE' : 'PREFIX_SURVIVAL_UPPER_BOUND', fpMeaning: 'LOWER_BOUND_GIVEN_FINAL_SUCCESS',
        minimumSuccess: 0.15, maximumSuccessFp: maximumSuccessFp(workspace.engine.catalog.model), stages: [], residualProbabilityBound: 0, nonTerminatingStates: 0,
        successfulFpLowerBound: certificate.successfulFpLowerBound, auxiliaryTotalsAvailable: false,
        preflight: { rule: certificate.decision, perCastSuccessUpperBound: certificate.perCastSuccessUpperBound } } };
    workspace.results.set(key, result); return result;
  }
  if (!disablePruning) for (let stage = 1; stage < route.macros.length; stage++) {
    // Check prefixes ending at risk-bearing stages. Repeated pure preparation alone cannot cause a required NG.
    const macro = route.macros[stage - 1];
    if (!['seal', 'removal', 'conditional', 'chaos'].includes(macro.kind)) continue;
    const prefix = calculate(workspace, { ...route, macros: route.macros.slice(0, stage) }, true, shouldStop);
    if (prefix.score.upper < 0.15) {
      const result: IntrinsicReport = { ...prefix, route, intrinsic: { ...prefix.intrinsic, evaluatedThroughStage: stage, decision: 'ABANDONED', reason: 'BELOW_MINIMUM_SUCCESS' } };
      workspace.results.set(key, result); return result;
    }
  }
  const report = calculate(workspace, route, false, shouldStop);
  workspace.results.set(key, report); return report;
}
