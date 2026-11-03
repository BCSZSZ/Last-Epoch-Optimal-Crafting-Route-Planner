import { exact, Interval } from './interval';
import { macroStep, quantilesFromCdf } from './evaluation';
import type { CurvePoint, RouteReport } from './evaluation';
import { seededRandom } from './random';
import type { Draw } from './random';
import { RuleEngine } from './rules';
import { targetReached } from './target';
import type { PlanRequest, Route } from './types';

export class SamplingInterruptedError extends Error {}

export interface SamplingOptions {
  readonly samplesPerFp?: number;
  readonly seed?: string;
  readonly confidence?: number;
  readonly attemptGuard?: number;
  readonly shouldStop?: () => boolean;
  readonly onProgress?: (initialFp: number, completedTrials: number) => void;
}

export interface Trajectory {
  readonly success: boolean;
  readonly spent: number;
  readonly reason: string;
  readonly attempts: readonly number[];
}

/** Execute one fixed macro sequence; no draw can trigger a fresh route search. */
export function simulateRoute(engine: RuleEngine, request: PlanRequest, route: Route, initialFp: number, draw: Draw,
  attemptGuard = 1024): Trajectory {
  let item = request.item;
  let fp = initialFp;
  let stage = 0;
  let count = 0;
  const attempts = Array<number>(route.macros.length).fill(0);
  const trackRolls = request.target.requirements.some((row) => row.minRollByte !== undefined) ||
    request.constraints.protected?.some((row) => row.roll) || false;
  const finish = (success: boolean, reason: string): Trajectory => ({ success, spent: initialFp - fp, reason, attempts });
  while (true) {
    if (targetReached(item, request.target)) return finish(true, 'SUCCESS');
    if (stage >= route.macros.length) return finish(false, 'ROUTE_EXHAUSTED');
    const step = macroStep(route.macros[stage], item, request, engine);
    if (step === 'SKIP') { stage++; continue; }
    if (step === 'INAPPLICABLE') return finish(false, 'INAPPLICABLE_NEXT_STAGE');
    if (fp <= 0) return finish(false, 'FP_EXHAUSTED');
    if (request.constraints.maxAttempts !== undefined && count >= request.constraints.maxAttempts) return finish(false, 'OPERATION_LIMIT');
    if (count >= attemptGuard) throw new SamplingInterruptedError('抽样轨迹达到计算保护上限；未将其计为制作失败');
    const sampled = engine.sample(item, fp, step.action, request.craftingContext, draw,
      { constraints: request.constraints, trackRolls, maxOutcomes: request.search.maxStates });
    if (!sampled.outcome) return finish(false, sampled.issues[0]?.code ?? 'INAPPLICABLE_ACTION');
    count++;
    attempts[stage]++;
    item = sampled.outcome.item;
    fp = sampled.outcome.fp;
    // Policy failure is applied after full native settlement and before incidental target success.
    if (sampled.outcome.abort) return finish(false, sampled.outcome.abort);
    if (step.advance) stage++;
  }
}

function band(value: number, error: number, maximum = 1): { lower: number; upper: number } {
  return { lower: Math.max(0, value - error), upper: Math.min(maximum, value + error) };
}

function conditionalMoment(moment: number, error: number, probability: { lower: number; upper: number }, maximum: number) {
  if (probability.lower <= 0) return null;
  const numerator = new Interval(Math.max(0, moment - error), Math.min(maximum, moment + error));
  return numerator.div(new Interval(probability.lower, probability.upper)).clamp(0, maximum).report();
}

function distributionQuantiles(success: readonly number[], failure: readonly number[], error: number,
  probability: { lower: number; upper: number }, maximum: number) {
  let totalCdf = 0;
  let successCdf = 0;
  const total = [];
  const conditional = [];
  for (let cost = 0; cost <= maximum; cost++) {
    totalCdf += success[cost] + failure[cost];
    successCdf += success[cost];
    total.push(cost === maximum ? { lower: 1, upper: 1 } : band(totalCdf, error));
    if (probability.lower > 0) conditional.push(cost === maximum ? { lower: 1, upper: 1 } :
      new Interval(Math.max(0, successCdf - error), Math.min(1, successCdf + error))
        .div(new Interval(probability.lower, probability.upper)).clamp(0, 1).report());
  }
  return { total: quantilesFromCdf(total), success: conditional.length ? quantilesFromCdf(conditional) : null };
}

/** Direct sampling shares the physical action implementation with enumeration.
 * Statistical bounds are simultaneous within ONE report under the declared iid sampling convention.
 * Independent validation lives in the separately implemented Python research tools.
 */
export function sampleRoute(engine: RuleEngine, request: PlanRequest, route: Route, options: SamplingOptions = {}): RouteReport {
  const n = options.samplesPerFp ?? 1024;
  const confidence = options.confidence ?? 0.99;
  const guard = options.attemptGuard ?? 1024;
  const seed = options.seed ?? 'le-fixed-route-v1';
  if (!Number.isInteger(n) || n < 16 || n > 65536 || !Number.isInteger(guard) || guard < 64 || guard > 65536 || !(confidence > 0 && confidence < 1)) throw new Error('抽样配置无效');
  const maximum = request.scoring.maximumFp ?? 63;
  const rawWeights = request.scoring.weights ?? Array<number>(maximum).fill(1);
  const totalWeight = rawWeights.reduce((a, b) => a + b, 0);
  const weights = rawWeights.map((value) => value / totalWeight);
  const params = engine.catalog.model.parameters;
  // Every paid noncritical action consumes >=1 even after low-FP preservation.
  // Deliberately combines the strongest free and critical chances for a conservative common lower bound.
  const paid = (1 - (params.critical + (1 - params.critical) * params.blood)) * (1 - params.hope) * (1 - params.ice);
  if (!(paid > 0)) throw new SamplingInterruptedError('当前模型未提供有界潜能下的终止证书');
  const lambda = Math.log(2);
  const ratio = 1 - paid + paid * Math.exp(-lambda);
  const attemptTail = Math.exp(lambda * maximum + guard * Math.log(ratio)) / (1 - ratio);
  // A union bound covers all bins, CDF thresholds, moments and curve values returned below.
  const events = (maximum + 1) * (256 + route.macros.length * 2) + 512;
  const logarithm = Math.log(2 * events / (1 - confidence));
  const pointError = Math.sqrt(logarithm / (2 * n));
  const aggregateVariance = weights.reduce((value, weight) => value + weight * weight / n, 0);
  const aggregateError = Math.sqrt(logarithm * aggregateVariance / 2);
  const fpVariance = weights.reduce((value, weight, index) => value + weight * weight * (index + 1) ** 2 / n, 0);
  const fpError = Math.sqrt(logarithm * fpVariance / 2);
  const success = Array<number>(64).fill(0);
  const failure = Array<number>(64).fill(0);
  const attempts = Array<number>(route.macros.length).fill(0);
  const reasons = new Map<string, number>();
  const curve: CurvePoint[] = [];
  let score = 0;
  let totalMoment = 0;
  let successMoment = 0;
  let failureMoment = 0;
  let trials = 0;
  let actions = 0;
  const zero = simulateRoute(engine, request, route, 0, seededRandom(`${seed}|${route.id}|0`), guard);
  curve.push({ initialFp: 0, successProbability: exact(Number(zero.success)).report(), successEstimate: Number(zero.success),
    expectedFp: exact(0).report(), expectedFpGivenSuccess: zero.success ? exact(0).report() : null,
    quantiles: { p50: { lower: 0, upper: 0 }, p90: { lower: 0, upper: 0 }, p95: { lower: 0, upper: 0 } },
    successQuantiles: zero.success ? { p50: { lower: 0, upper: 0 }, p90: { lower: 0, upper: 0 }, p95: { lower: 0, upper: 0 } } : null });
  for (let fp = 1; fp <= maximum; fp++) {
    const draw = seededRandom(`${seed}|${engine.catalog.model.modelId}|${JSON.stringify(route.macros)}|${fp}`);
    const successes = Array<number>(64).fill(0);
    const failures = Array<number>(64).fill(0);
    const stageAttempts = Array<number>(route.macros.length).fill(0);
    const failedReasons = new Map<string, number>();
    let hits = 0;
    let spent = 0;
    let spentSuccess = 0;
    for (let trial = 0; trial < n; trial++) {
      if ((trial & 127) === 0 && options.shouldStop?.()) throw new SamplingInterruptedError('抽样计算已取消或达到执行预算');
      const result = simulateRoute(engine, request, route, fp, draw, guard);
      trials++;
      hits += Number(result.success);
      spent += result.spent;
      spentSuccess += result.success ? result.spent : 0;
      (result.success ? successes : failures)[result.spent]++;
      if (!result.success) failedReasons.set(result.reason, (failedReasons.get(result.reason) ?? 0) + 1);
      result.attempts.forEach((value, index) => { stageAttempts[index] += value; actions += value; });
    }
    const weight = weights[fp - 1];
    const probability = band(hits / n, pointError);
    const empiricalSuccess = successes.map((value) => value / n);
    const empiricalFailure = failures.map((value) => value / n);
    const quantiles = distributionQuantiles(empiricalSuccess, empiricalFailure, pointError, probability, fp);
    curve.push({ initialFp: fp, successProbability: probability, successEstimate: hits / n,
      expectedFp: band(spent / n, fp * pointError, fp),
      expectedFpGivenSuccess: conditionalMoment(spentSuccess / n, fp * pointError, probability, fp),
      quantiles: quantiles.total, successQuantiles: quantiles.success });
    score += weight * hits / n;
    totalMoment += weight * spent / n;
    successMoment += weight * spentSuccess / n;
    failureMoment += weight * (spent - spentSuccess) / n;
    for (let cost = 0; cost < 64; cost++) { success[cost] += weight * empiricalSuccess[cost]; failure[cost] += weight * empiricalFailure[cost]; }
    for (let stage = 0; stage < attempts.length; stage++) attempts[stage] += weight * stageAttempts[stage] / n;
    for (const [reason, count] of failedReasons) reasons.set(reason, (reasons.get(reason) ?? 0) + weight * count / n);
    options.onProgress?.(fp, trials);
  }
  const probability = band(score, aggregateError);
  const quantiles = distributionQuantiles(success, failure, aggregateError, probability, maximum);
  return { route, evaluationStatus: 'ESTIMATED', score: probability, scoreEstimate: score, curve,
    expectedFp: band(totalMoment, fpError, maximum),
    expectedFpGivenSuccess: conditionalMoment(successMoment, fpError, probability, maximum),
    failedFpWaste: band(failureMoment, fpError, maximum), quantiles: quantiles.total, successQuantiles: quantiles.success,
    consumption: success.map((value, spent) => ({ spent, success: spent > maximum ? exact(0).report() : band(value, aggregateError), failure: spent > maximum ? exact(0).report() : band(failure[spent], aggregateError),
      successEstimate: value, failureEstimate: failure[spent] })),
    attemptsByMacro: attempts.map((value) => ({ lower: Math.max(0, value - guard * aggregateError), upper: value + guard * aggregateError + attemptTail })),
    failureReasons: [...reasons].map(([reason, value]) => ({ reason, probability: band(value, aggregateError) })), states: actions,
    sampling: { seed, samplesPerFp: n, totalTrials: trials, confidence, method: 'SIMULTANEOUS_HOEFFDING_UNDER_IID_SAMPLING',
      attemptGuard: guard, unobservedAttemptMeanBound: attemptTail, minimumPaidProbability: paid } };
}
