import { itemKey, ordinary } from './catalog';
import { Interval, exact, ONE, ratio, ZERO } from './interval';
import { boundedCostKernel, tierPermutations } from './probability';
import { RuleEngine } from './rules';
import { matches, select, selectedIds, targetReached } from './target';
import type { Affix, AtomicAction, Item, Macro, PlanRequest, Predicate, Route, Selector } from './types';

export interface Absorption {
  readonly success: readonly Interval[];
  readonly failure: readonly Interval[];
  readonly attempts: readonly Interval[];
  readonly reached: readonly Interval[];
  readonly executed: readonly Interval[];
  readonly spent: readonly Interval[];
  readonly reasons: ReadonlyMap<string, Interval>;
}

export class EvaluationLimitError extends Error {}
export class SamplingRequiredError extends Error {}
export class EvaluationInterruptedError extends EvaluationLimitError {}

function zero(stages: number): Absorption {
  return { success: Array<Interval>(64).fill(ZERO), failure: Array<Interval>(64).fill(ZERO),
    attempts: Array<Interval>(stages).fill(ZERO), reached: Array<Interval>(stages).fill(ZERO),
    executed: Array<Interval>(stages).fill(ZERO), spent: Array<Interval>(stages).fill(ZERO), reasons: new Map() };
}

function terminal(stages: number, fp: number, success: boolean, reason = 'ROUTE_EXHAUSTED'): Absorption {
  const result = zero(stages);
  ((success ? result.success : result.failure) as Interval[])[fp] = ONE;
  if (!success) (result.reasons as Map<string, Interval>).set(reason, ONE);
  return result;
}

/** The mutable accumulator is internal; cached evaluations are never changed by callers. */
function addScaled(destination: Absorption, source: Absorption, weight: Interval): void {
  if (weight.upper === 0) return;
  for (let fp = 0; fp < 64; fp++) {
    (destination.success as Interval[])[fp] = destination.success[fp].add(source.success[fp].mul(weight));
    (destination.failure as Interval[])[fp] = destination.failure[fp].add(source.failure[fp].mul(weight));
  }
  for (let stage = 0; stage < destination.attempts.length; stage++) {
    (destination.attempts as Interval[])[stage] = destination.attempts[stage].add(source.attempts[stage].mul(weight));
    (destination.reached as Interval[])[stage] = destination.reached[stage].add(source.reached[stage].mul(weight));
    (destination.executed as Interval[])[stage] = destination.executed[stage].add(source.executed[stage].mul(weight));
    (destination.spent as Interval[])[stage] = destination.spent[stage].add(source.spent[stage].mul(weight));
  }
  const reasons = destination.reasons as Map<string, Interval>;
  for (const [reason, value] of source.reasons) reasons.set(reason, (reasons.get(reason) ?? ZERO).add(value.mul(weight)));
}

function divide(source: Absorption, denominator: Interval): Absorption {
  return { success: source.success.map((row) => row.div(denominator)), failure: source.failure.map((row) => row.div(denominator)),
    attempts: source.attempts.map((row) => row.div(denominator)),
    reached: source.reached.map((row) => row.div(denominator)), executed: source.executed.map((row) => row.div(denominator)),
    spent: source.spent.map((row) => row.div(denominator)),
    reasons: new Map([...source.reasons].map(([key, value]) => [key, value.div(denominator)])) };
}

export function predicateReached(item: Item, predicate: Predicate, request: PlanRequest, engine: RuleEngine): boolean {
  if (predicate.kind === 'target') return targetReached(item, request.target);
  if (predicate.kind === 'requirements') return targetReached(item, { requirements: predicate.requirements });
  if (predicate.kind === 'exists') return select(item, predicate.selector, engine.catalog, selectorEligibility(item, predicate.selector, request, engine)) !== undefined;
  return item.affixes.some((row) => matches(row, predicate.requirement));
}

function selectorEligibility(item: Item, selector: Selector, request: PlanRequest, engine: RuleEngine): (affix: Affix) => boolean {
  return !selector.sealable ? () => true : (affix) => engine.eligibility(item, 1, { kind: 'seal', id: affix.id },
    request.craftingContext, request.constraints).length === 0;
}

export function macroStep(macro: Macro, item: Item, request: PlanRequest, engine: RuleEngine):
  { action: AtomicAction; advance: boolean } | 'SKIP' | 'INAPPLICABLE' {
  if (macro.kind === 'once') return { action: macro.action, advance: true };
  if (macro.kind === 'removal') return { action: { kind: 'removal', glyph: macro.glyph,
    acceptedIds: selectedIds(item, macro.accepted, engine.catalog, selectorEligibility(item, macro.accepted, request, engine)) }, advance: true };
  if (macro.kind === 'seal') {
    const selector = { ...macro.selector, sealable: true, maxTier: Math.min(4, macro.selector.maxTier ?? 4) };
    const index = select(item, selector, engine.catalog, selectorEligibility(item, selector, request, engine));
    return index === undefined ? 'INAPPLICABLE' : { action: { kind: 'seal', id: item.affixes[index].id }, advance: true };
  }
  if (macro.kind === 'repeat') return predicateReached(item, macro.until, request, engine) ? 'SKIP' : { action: macro.action, advance: false };
  if (macro.kind === 'upgrade') {
    const affix = item.affixes.find((row) => row.id === macro.id && row.slot === 'ordinary');
    return !affix ? 'INAPPLICABLE' : affix.tier >= macro.tier ? 'SKIP' :
      { action: { kind: 'upgrade', id: macro.id, glyph: macro.glyph }, advance: false };
  }
  if (item.affixes.some((row) => matches(row, macro.until))) return 'SKIP';
  const index = select(item, { ...macro.selector, maxTier: Math.min(4, macro.selector.maxTier ?? 4) }, engine.catalog,
    selectorEligibility(item, macro.selector, request, engine));
  return index === undefined ? 'INAPPLICABLE' : { action: { kind: 'chaos', id: item.affixes[index].id }, advance: false };
}

/** Exact state expansion plus outward rounding; uniform-Havoc symmetry solves its free-cost loop. */
export class RouteEvaluator {
  readonly #cache = new Map<string, Absorption>();
  readonly #havoc = new Map<string, Absorption[]>();
  readonly #trackRolls: boolean;
  nodes = 0;

  constructor(readonly engine: RuleEngine, readonly request: PlanRequest, readonly route: Route, readonly shouldStop?: () => boolean) {
    this.#trackRolls = request.target.requirements.some((row) => row.minRollByte !== undefined) ||
      request.constraints.protected?.some((row) => row.roll) || false;
  }

  evaluate(fp: number): Absorption {
    if (!Number.isInteger(fp) || fp < 0 || fp > (this.request.scoring.maximumFp ?? 63)) throw new RangeError('假设预算不在声明的评分域内');
    return this.#visit(0, this.request.item, fp, this.request.constraints.maxAttempts);
  }

  #visit(stage: number, item: Item, fp: number, attemptsLeft?: number): Absorption {
    if (targetReached(item, this.request.target)) return terminal(this.route.macros.length, fp, true);
    if (stage >= this.route.macros.length) return terminal(this.route.macros.length, fp, false);
    const key = `${stage}|${fp}|${attemptsLeft ?? '*'}|${itemKey(item)}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    if (++this.nodes > this.request.search.maxStates) throw new EvaluationLimitError('达到整条路线的状态预算');
    if ((this.nodes & 63) === 0 && this.shouldStop?.()) throw new EvaluationInterruptedError('路线评价已取消或达到时间预算');
    const macro = this.route.macros[stage];
    const step = macroStep(macro, item, this.request, this.engine);
    let result: Absorption;
    let executed = false;
    if (step === 'SKIP') result = this.#visit(stage + 1, item, fp, attemptsLeft);
    else if (step === 'INAPPLICABLE') result = terminal(this.route.macros.length, fp, false, 'INAPPLICABLE_NEXT_STAGE');
    else if (fp === 0) result = terminal(this.route.macros.length, fp, false, 'FP_EXHAUSTED');
    else if (attemptsLeft === 0) result = terminal(this.route.macros.length, fp, false, 'OPERATION_LIMIT');
    else if (macro.kind === 'repeat' && step.action.kind === 'havoc' && attemptsLeft === undefined) {
      result = this.#havocUntil(stage, item, fp, macro);
      executed = result.attempts[stage].lower > 0;
    } else {
      if (macro.kind === 'repeat' && step.action.kind === 'redemption' && attemptsLeft === undefined) {
        throw new SamplingRequiredError('救赎会逐次改变候选池；使用直接路线采样，不套固定命中率几何分布');
      }
      const transition = this.engine.transition(item, fp, step.action, this.request.craftingContext,
        { constraints: this.request.constraints, trackRolls: this.#trackRolls, maxOutcomes: this.request.search.maxStates });
      if (transition.issues.length) result = terminal(this.route.macros.length, fp, false, transition.issues[0].code);
      else {
        executed = true;
        result = zero(this.route.macros.length);
        for (const outcome of transition.outcomes) {
          const weight = new Interval(outcome.probabilityBounds.lower, outcome.probabilityBounds.upper);
          const child = outcome.abort ? terminal(this.route.macros.length, outcome.fp, false, outcome.abort) :
            this.#visit(stage + Number(step.advance), outcome.item, outcome.fp, attemptsLeft === undefined ? undefined : attemptsLeft - 1);
          addScaled(result, child, weight);
          (result.attempts as Interval[])[stage] = result.attempts[stage].add(weight);
          (result.spent as Interval[])[stage] = result.spent[stage].add(weight.mul(exact(fp - outcome.fp)));
        }
      }
    }
    // Entry/execution are events, not rewards: repeated attempts must not count them again.
    // Copy these vectors because a skipped stage may directly reuse a cached child.
    const reached = [...result.reached]; reached[stage] = ONE;
    const execution = [...result.executed]; execution[stage] = executed ? ONE : ZERO;
    result = { ...result, reached, executed: execution };
    this.#cache.set(key, result);
    return result;
  }

  #havocUntil(stage: number, item: Item, fp: number, macro: Extract<Macro, { kind: 'repeat' }>): Absorption {
    if (macro.action.kind !== 'havoc') throw new Error('浩劫宏类型不一致');
    const check = this.engine.transition(item, fp, macro.action, this.request.craftingContext,
      { constraints: this.request.constraints, maxOutcomes: this.request.search.maxStates });
    if (check.issues.length) return terminal(this.route.macros.length, fp, false, check.issues[0].code);
    const indices = item.affixes.flatMap((row, i) => row.slot === 'ordinary' ? [i] : []);
    const tiers = ordinary(item).map((row) => row.tier);
    const signature = `${stage}|${item.affixes.map((row) => `${row.id}:${row.slot}:${row.slot === 'ordinary' ? '*' : row.tier}:${row.roll ?? '*'}`).join(',')}|${[...tiers].sort().join(',')}`;
    let table = this.#havoc.get(signature);
    if (!table) {
      const layouts = tierPermutations(tiers).map((layout): Item => {
        const replacements = new Map(indices.map((index, i) => [index, layout[i]]));
        return { ...item, affixes: item.affixes.map((row, index) => ({ ...row, tier: replacements.get(index) ?? row.tier })) };
      });
      const goals = layouts.filter((layout) => predicateReached(layout, macro.until, this.request, this.engine));
      // Even an unreachable subgoal consumes real attempts/FP if the action remains legal.
      const hit = ratio(goals.length, layouts.length - 1);
      const miss = hit.complement();
      table = [terminal(this.route.macros.length, 0, false, 'FP_EXHAUSTED')];
      this.#havoc.set(signature, table);
      for (let budget = 1; budget <= (this.request.scoring.maximumFp ?? 63); budget++) {
        const numerator = zero(this.route.macros.length);
        let loop = ZERO;
        const cost = boundedCostKernel(budget, 20, item.fpType, macro.action.glyph === 'hope', this.engine.catalog.model.parameters);
        for (const remaining of cost) {
          if (goals.length) {
            const goalsMean = zero(this.route.macros.length);
            for (const goal of goals) addScaled(goalsMean, this.#visit(stage + 1, goal, remaining.value), ratio(1, goals.length));
            addScaled(numerator, goalsMean, remaining.bounds.mul(hit));
          }
          if (remaining.value < budget) addScaled(numerator, table[remaining.value], remaining.bounds.mul(miss));
          else loop = loop.add(remaining.bounds.mul(miss));
          (numerator.attempts as Interval[])[stage] = numerator.attempts[stage].add(remaining.bounds);
          (numerator.spent as Interval[])[stage] = numerator.spent[stage].add(remaining.bounds.mul(exact(budget - remaining.value)));
        }
        if (loop.upper >= 1) throw new EvaluationLimitError('无法在当前精度下证明零成本循环会终止');
        table.push(divide(numerator, loop.complement()));
      }
    }
    return table[fp];
  }
}

export interface Quantiles {
  readonly p50: { lower: number; upper: number };
  readonly p90: { lower: number; upper: number };
  readonly p95: { lower: number; upper: number };
}

export function quantilesFromCdf(cdf: readonly { lower: number; upper: number }[]): Quantiles {
  const inverse = (p: number) => {
    let lower = -1;
    let upper = cdf.length - 1;
    for (let cost = 0; cost < cdf.length; cost++) {
      if (lower < 0 && cdf[cost].upper >= p) lower = cost;
      if (cdf[cost].lower >= p) { upper = cost; break; }
    }
    return { lower: Math.max(0, lower), upper };
  };
  return { p50: inverse(0.5), p90: inverse(0.9), p95: inverse(0.95) };
}

function quantiles(distribution: readonly Interval[], denominator = ONE): Quantiles | null {
  if (denominator.lower <= 0) return null;
  let accumulated = ZERO;
  return quantilesFromCdf(distribution.map((value) => {
    accumulated = accumulated.add(value);
    return accumulated.div(denominator).report();
  }));
}

export function summarizeDistribution(success: readonly Interval[], failure: readonly Interval[]) {
  const probability = success.reduce((value, row) => value.add(row), ZERO).clamp(0, 1);
  const successMoment = success.reduce((value, row, cost) => value.add(row.mul(exact(cost))), ZERO);
  const failedMoment = failure.reduce((value, row, cost) => value.add(row.mul(exact(cost))), ZERO);
  const total = success.map((row, i) => row.add(failure[i]));
  return { probability, successMoment, failedMoment,
    expectedFp: successMoment.add(failedMoment),
    expectedFpGivenSuccess: probability.lower > 0 ? successMoment.div(probability) : null,
    quantiles: quantiles(total), successQuantiles: quantiles(success, probability) };
}

export interface CurvePoint {
  readonly initialFp: number;
  readonly successProbability: { lower: number; upper: number };
  readonly successEstimate?: number;
  /** Certified exact-route upper bound for every extension of this fixed prefix. */
  readonly continuationSuccessUpper?: number;
  readonly expectedFp: { lower: number; upper: number };
  readonly expectedFpGivenSuccess: { lower: number; upper: number } | null;
  readonly quantiles: Quantiles | null;
  readonly successQuantiles: Quantiles | null;
}

export interface MacroStatistics {
  /** Reached before local skip/eligibility/FP checks; an earlier completed goal never reaches later stages. */
  readonly reachedProbability: { lower: number; upper: number };
  /** At least one legal atomic action actually executed in this stage. */
  readonly executedProbability: { lower: number; upper: number };
  /** Unconditional contributions under the declared FP scoring weights. */
  readonly expectedAttempts: { lower: number; upper: number };
  readonly expectedFp: { lower: number; upper: number };
  readonly expectedAttemptsGivenReached: { lower: number; upper: number } | null;
  readonly expectedFpGivenReached: { lower: number; upper: number } | null;
}

export interface RouteReport {
  readonly route: Route;
  readonly evaluationStatus: 'BOUNDED_NUMERICAL' | 'ESTIMATED';
  readonly score: { lower: number; upper: number };
  readonly scoreEstimate: number;
  readonly curve: readonly CurvePoint[];
  readonly expectedFp: { lower: number; upper: number };
  readonly expectedFpGivenSuccess: { lower: number; upper: number } | null;
  readonly failedFpWaste: { lower: number; upper: number };
  readonly quantiles: Quantiles | null;
  readonly successQuantiles: Quantiles | null;
  readonly consumption: readonly { spent: number; success: { lower: number; upper: number }; failure: { lower: number; upper: number }; successEstimate?: number; failureEstimate?: number }[];
  readonly attemptsByMacro: readonly { lower: number; upper: number }[];
  readonly macroStatistics: readonly MacroStatistics[];
  readonly failureReasons: readonly { reason: string; probability: { lower: number; upper: number } }[];
  readonly states: number;
  readonly sampling?: {
    readonly seed: string;
    readonly samplesPerFp: number;
    readonly totalTrials: number;
    readonly confidence: number;
    readonly method: 'SIMULTANEOUS_HOEFFDING_UNDER_IID_SAMPLING';
    readonly attemptGuard: number;
    readonly unobservedAttemptMeanBound: number;
    readonly minimumPaidProbability: number;
  };
}

export function reportRoute(engine: RuleEngine, request: PlanRequest, route: Route, shouldStop?: () => boolean): RouteReport {
  const evaluator = new RouteEvaluator(engine, request, route, shouldStop);
  const maximum = request.scoring.maximumFp ?? 63;
  const weights = request.scoring.weights ?? Array<number>(maximum).fill(1);
  const totalWeight = weights.reduce((value, weight) => value.add(exact(weight)), ZERO);
  const success = Array<Interval>(64).fill(ZERO);
  const failure = Array<Interval>(64).fill(ZERO);
  const attempts = Array<Interval>(route.macros.length).fill(ZERO);
  const reached = Array<Interval>(route.macros.length).fill(ZERO);
  const executed = Array<Interval>(route.macros.length).fill(ZERO);
  const spent = Array<Interval>(route.macros.length).fill(ZERO);
  const reasons = new Map<string, Interval>();
  const curve: CurvePoint[] = [];
  for (let fp = 0; fp <= maximum; fp++) {
    const evaluated = evaluator.evaluate(fp);
    const successes = Array.from({ length: 64 }, (_, cost) => cost <= fp ? evaluated.success[fp - cost] : ZERO);
    const failures = Array.from({ length: 64 }, (_, cost) => cost <= fp ? evaluated.failure[fp - cost] : ZERO);
    const point = summarizeDistribution(successes, failures);
    const unitMass = [...successes, ...failures].reduce((value, row) => value.add(row), ZERO);
    if (unitMass.lower > 1 || unitMass.upper < 1 || unitMass.width > 1e-7) throw new EvaluationLimitError('路线概率质量或数值区间未通过校验');
    const exhaustedRoute = evaluated.reasons.get('ROUTE_EXHAUSTED') ?? ZERO;
    const continuationUpper = Math.min(1, point.probability.add(exhaustedRoute).upper,
      new Interval(Math.max(0, evaluated.failure[0].lower)).complement().upper);
    curve.push({ initialFp: fp, successProbability: point.probability.report(), continuationSuccessUpper: continuationUpper, expectedFp: point.expectedFp.report(),
      expectedFpGivenSuccess: point.expectedFpGivenSuccess?.report() ?? null, quantiles: point.quantiles, successQuantiles: point.successQuantiles });
    if (fp === 0) continue;
    const weight = exact(weights[fp - 1]).div(totalWeight);
    for (let cost = 0; cost < 64; cost++) {
      success[cost] = success[cost].add(successes[cost].mul(weight));
      failure[cost] = failure[cost].add(failures[cost].mul(weight));
    }
    for (let stage = 0; stage < attempts.length; stage++) {
      attempts[stage] = attempts[stage].add(evaluated.attempts[stage].mul(weight));
      reached[stage] = reached[stage].add(evaluated.reached[stage].mul(weight));
      executed[stage] = executed[stage].add(evaluated.executed[stage].mul(weight));
      spent[stage] = spent[stage].add(evaluated.spent[stage].mul(weight));
    }
    for (const [reason, probability] of evaluated.reasons) reasons.set(reason, (reasons.get(reason) ?? ZERO).add(probability.mul(weight)));
  }
  const combined = summarizeDistribution(success, failure);
  return { route, evaluationStatus: 'BOUNDED_NUMERICAL', score: combined.probability.report(), scoreEstimate: combined.probability.midpoint, curve,
    expectedFp: combined.expectedFp.report(), expectedFpGivenSuccess: combined.expectedFpGivenSuccess?.report() ?? null,
    failedFpWaste: combined.failedMoment.report(), quantiles: combined.quantiles, successQuantiles: combined.successQuantiles,
    consumption: success.map((value, spent) => ({ spent, success: value.report(), failure: failure[spent].report() })),
    attemptsByMacro: attempts.map((row) => row.report()),
    macroStatistics: reached.map((row, stage) => {
      const probability = row.clamp(0, 1);
      return { reachedProbability: probability.report(), executedProbability: executed[stage].clamp(0, 1).report(),
        expectedAttempts: attempts[stage].report(), expectedFp: spent[stage].report(),
        expectedAttemptsGivenReached: probability.lower > 0 ? attempts[stage].div(probability).clamp(0, Infinity).report() : null,
        expectedFpGivenReached: probability.lower > 0 ? spent[stage].div(probability).clamp(0, maximum).report() : null };
    }),
    failureReasons: [...reasons].map(([reason, value]) => ({ reason, probability: value.report() })),
    states: evaluator.nodes };
}
