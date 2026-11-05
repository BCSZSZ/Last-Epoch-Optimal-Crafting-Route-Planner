import { allowedMacro, commonRoutes, macroLibrary, routeId, routeKey, routeSpace } from './candidates';
import { EvaluationInterruptedError, EvaluationLimitError, reportRoute, SamplingRequiredError } from './evaluation';
import type { RouteReport } from './evaluation';
import { exact, ZERO } from './interval';
import { RuleEngine, OutcomeLimitError } from './rules';
import { sampleRoute, SamplingInterruptedError } from './sampling';
import { targetReached } from './target';
import { parsePlanRequest } from './request';
import type { Issue, Macro, PlanRequest, Route } from './types';
import { compileTemplates } from './hierarchy';
import type { Structure } from './hierarchy';
import { evaluateIntrinsic, IntrinsicWorkspace } from './intrinsic';
import type { IntrinsicReport } from './intrinsic';
import { catalogForInputModel, readInputModel } from './input-model';
import { maximumSuccessFp } from './policy';
import { evaluateCompletion } from './completion';
import type { CompletionReport } from './completion';
import { REFERENCE_FP } from './policy';

export interface PlanProgress {
  readonly phase: 'VALIDATION' | 'SEARCH' | 'REFINEMENT' | 'DONE';
  readonly evaluatedRoutes: number;
  readonly elapsedMilliseconds: number;
  readonly bestScore: number | null;
  readonly message: string;
}

export interface PlanReport {
  readonly completion?: CompletionReport | null;
  readonly inputModel?: PlanRequest['inputModel'];
  readonly metric?: 'INTRINSIC_V2' | 'FINITE_FP_V1';
  readonly hierarchy?: {
    readonly structure: Structure;
    readonly upperLabels: 28;
    readonly routeNodes: 23;
    readonly generatedTemplates: number;
    readonly structurallyRejected: number;
    readonly preExcluded?: readonly { readonly templateId: string; readonly reason: string; readonly probabilityUpperBound: number }[];
    readonly workspaceCacheHits: number;
  };
  readonly abandoned?: readonly IntrinsicReport[];
  readonly unresolvedRoutes?: number;
  readonly modelId: string;
  readonly gameVersion: string;
  readonly status: 'RECOMMENDATION' | 'INVALID_INPUT' | 'NO_ROUTE_FOUND_IN_SCOPE';
  readonly issues: readonly Issue[];
  readonly primary: RouteReport | null;
  readonly searchStatus: 'COMPLETE' | 'INCOMPLETE' | 'NOT_STARTED';
  readonly optimality: 'PROVEN_WITHIN_DECLARED_SCOPE' | 'NOT_PROVEN';
  readonly samplingGuarantee: {
    readonly scope: 'ALL_STATISTICAL_REPORTS_IN_ONE_PLANNING_CALL_UNDER_IID';
    readonly confidence: number;
    readonly maximumReports: number;
    readonly reportConfidence: number;
  } | null;
  readonly search: {
    readonly grammar: string;
    readonly macroStages: number;
    readonly librarySize: number;
    readonly candidateUpperBound: string;
    readonly evaluatedRoutes: number;
    readonly exactRoutes: number;
    readonly estimatedRoutes: number;
    readonly unevaluatedRoutes: number;
    readonly skippedDuplicates: number;
    readonly certifiedPrunedPrefixes: number;
    readonly elapsedMilliseconds: number;
    readonly stopReason: string;
    readonly paretoRouteIds: readonly string[];
  };
  readonly conventions: {
    readonly fpDomain: readonly number[];
    readonly weights: readonly number[];
    readonly materials: 'UNLIMITED';
    readonly fixedRoute: true;
    readonly rngModel: string;
  };
  readonly qualification: string;
}

export interface PlanningOptions {
  readonly intrinsicRoutes?: readonly Route[];
  readonly signal?: { readonly aborted: boolean };
  readonly onProgress?: (progress: PlanProgress) => void;
  readonly now?: () => number;
  readonly yieldControl?: () => Promise<void>;
  readonly screeningSamplesPerFp?: number;
  readonly finalSamplesPerFp?: number;
  readonly seed?: string;
  /** Internal finite-scope seam for exhaustive baselines and regression tests. */
  readonly library?: readonly Macro[];
  readonly seedRoutes?: readonly Route[];
  readonly disableCertifiedPruning?: boolean;
}

export class PlanningCancelledError extends Error {
  constructor() { super('规划任务已取消'); this.name = 'AbortError'; }
}

function midpoint(value: { lower: number; upper: number } | null, fallback = Infinity): number {
  return value ? (value.lower + value.upper) / 2 : fallback;
}

export function compareReports(a: RouteReport, b: RouteReport): number {
  const score = b.scoreEstimate - a.scoreEstimate;
  if (Math.abs(score) > 1e-12) return score;
  for (const difference of [midpoint(a.expectedFpGivenSuccess) - midpoint(b.expectedFpGivenSuccess),
    midpoint(a.failedFpWaste) - midpoint(b.failedFpWaste), midpoint(a.successQuantiles?.p95 ?? null) - midpoint(b.successQuantiles?.p95 ?? null),
    midpoint(a.successQuantiles?.p90 ?? null) - midpoint(b.successQuantiles?.p90 ?? null), a.route.macros.length - b.route.macros.length]) {
    if (!Number.isNaN(difference) && Math.abs(difference) > 1e-10) return difference;
  }
  return a.route.id.localeCompare(b.route.id, 'en');
}

function certifiedDominates(a: RouteReport, b: RouteReport): boolean {
  if (a.evaluationStatus !== 'BOUNDED_NUMERICAL' || b.evaluationStatus !== 'BOUNDED_NUMERICAL') return false;
  return a.curve.every((point, i) => point.successProbability.lower >= b.curve[i].successProbability.upper) &&
    a.expectedFp.upper <= b.expectedFp.lower && a.failedFpWaste.upper <= b.failedFpWaste.lower &&
    a.score.lower > b.score.upper;
}

/** One asynchronous planning interface for both browser Worker and Node adapters. */
export async function planFiniteBaseline(input: unknown, options: PlanningOptions = {}): Promise<PlanReport> {
  const engine = new RuleEngine(catalogForInputModel(readInputModel(input)));
  const now = options.now ?? Date.now;
  const start = now();
  const elapsed = () => Math.max(0, now() - start);
  const parsed = parsePlanRequest(input, engine.catalog);
  if (!parsed.request) return {
    modelId: engine.catalog.model.modelId, gameVersion: engine.catalog.model.gameVersion, status: 'INVALID_INPUT', issues: parsed.issues,
    primary: null, searchStatus: 'NOT_STARTED', optimality: 'NOT_PROVEN', samplingGuarantee: null,
    search: { grammar: 'NOT_COMPILED', macroStages: 0, librarySize: 0, candidateUpperBound: '0', evaluatedRoutes: 0,
      exactRoutes: 0, estimatedRoutes: 0, unevaluatedRoutes: 0, skippedDuplicates: 0, certifiedPrunedPrefixes: 0,
      elapsedMilliseconds: elapsed(), stopReason: 'INVALID_INPUT', paretoRouteIds: [] },
    conventions: { fpDomain: Array.from({ length: 63 }, (_, i) => i + 1), weights: Array<number>(63).fill(1 / 63),
      materials: 'UNLIMITED', fixedRoute: true, rngModel: engine.catalog.model.rngModel },
    qualification: '输入未通过校验，没有放宽目标或启动搜索。',
  };
  const request = parsed.request;
  // At most one screening and one refinement report per attempted route. A union bound
  // also covers choosing the displayed route after inspecting several sampled candidates.
  const maximumSamplingReports = 2 * request.search.maxRoutes;
  const planningConfidence = 0.99;
  const reportConfidence = 1 - (1 - planningConfidence) / maximumSamplingReports;
  const maximum = request.scoring.maximumFp ?? 63;
  const rawWeights = request.scoring.weights ?? Array<number>(maximum).fill(1);
  const sumWeights = rawWeights.reduce((a, b) => a + b, 0);
  const weights = rawWeights.map((value) => value / sumWeights);
  const exactWeightTotal = rawWeights.reduce((value, weight) => value.add(exact(weight)), ZERO);
  const reports: RouteReport[] = [];
  let primary: RouteReport | null = null;
  let skipped = 0;
  let unevaluated = 0;
  let exactCount = 0;
  let estimatedCount = 0;
  let exhausted = false;
  let stopReason = 'CANDIDATE_LANGUAGE_EXHAUSTED';
  let certifiedLower = -1;
  const cancelled = () => options.signal?.aborted ?? false;
  const timedOut = () => elapsed() >= request.search.milliseconds;
  const searchTimedOut = () => elapsed() >= request.search.milliseconds * 0.65;
  const progress = (phase: PlanProgress['phase'], message: string) => options.onProgress?.({ phase,
    evaluatedRoutes: reports.length, elapsedMilliseconds: elapsed(), bestScore: primary?.scoreEstimate ?? null, message });
  const qualification = '概率基于本地代码规则及公开的独立抽样模型。算术区间和采样统计区间分别标注；搜索范围、执行预算与最优证明单列，未覆盖范围不解释为装备不可行。';
  const finish = (status: PlanReport['status'], issues: readonly Issue[], librarySize: number, upper: string, pruned: number,
    searchStatus: PlanReport['searchStatus']): PlanReport => {
    const pareto = reports.filter((candidate) => !reports.some((other) => other !== candidate && certifiedDominates(other, candidate)));
    const allRanked = primary !== null && reports.every((candidate) => candidate === primary ||
      (primary!.evaluationStatus === 'BOUNDED_NUMERICAL' && candidate.evaluationStatus === 'BOUNDED_NUMERICAL' && primary!.score.lower > candidate.score.upper));
    return { modelId: engine.catalog.model.modelId, gameVersion: engine.catalog.model.gameVersion, status, issues, primary,
      samplingGuarantee: estimatedCount > 0 ? { scope: 'ALL_STATISTICAL_REPORTS_IN_ONE_PLANNING_CALL_UNDER_IID',
        confidence: planningConfidence, maximumReports: maximumSamplingReports, reportConfidence } : null,
      searchStatus, optimality: searchStatus === 'COMPLETE' && estimatedCount === 0 && unevaluated === 0 && allRanked ? 'PROVEN_WITHIN_DECLARED_SCOPE' : 'NOT_PROVEN',
      search: { grammar: options.library ? 'EXPLICIT_FINITE_MACRO_LIBRARY' : 'FINITE_FIXED_MACRO_GRAMMAR_V1',
        macroStages: request.search.macroStages, librarySize, candidateUpperBound: upper, evaluatedRoutes: reports.length,
        exactRoutes: exactCount, estimatedRoutes: estimatedCount, unevaluatedRoutes: unevaluated, skippedDuplicates: skipped,
        certifiedPrunedPrefixes: pruned, elapsedMilliseconds: elapsed(), stopReason, paretoRouteIds: pareto.map((row) => row.route.id) },
      conventions: { fpDomain: Array.from({ length: maximum }, (_, index) => index + 1), weights, materials: 'UNLIMITED', fixedRoute: true, rngModel: engine.catalog.model.rngModel }, qualification };
  };
  progress('VALIDATION', '检查装备、目标、限制及机制版本');
  if (cancelled()) throw new PlanningCancelledError();
  if (targetReached(request.item, request.target)) {
    primary = reportRoute(engine, request, { id: 'already-complete', macros: [], description: '目标已满足，无需制作' });
    reports.push(primary); exactCount = 1; stopReason = 'TARGET_ALREADY_SATISFIED';
    progress('DONE', '起始装备已满足目标');
    return finish('RECOMMENDATION', [], 0, '1', 0, 'COMPLETE');
  }
  const seeds = options.seedRoutes ?? (options.library ? [] : commonRoutes(request, engine));
  const library = options.library ?? macroLibrary(request, engine, seeds);
  const space = routeSpace(library, request.search.macroStages, () => cancelled() || searchTimedOut());
  const seedIterator = seeds[Symbol.iterator]();
  let readingSeeds = true;
  const seen = new Set<string>();
  while (reports.length + unevaluated < request.search.maxRoutes) {
    if (cancelled()) throw new PlanningCancelledError();
    if (searchTimedOut()) { stopReason = 'TIME_BUDGET'; break; }
    let next = readingSeeds ? seedIterator.next() : space.routes.next();
    if (next.done && readingSeeds) { readingSeeds = false; next = space.routes.next(); }
    if (next.done) { exhausted = !searchTimedOut(); stopReason = exhausted ? 'CANDIDATE_LANGUAGE_EXHAUSTED' : 'TIME_BUDGET'; break; }
    const route = next.value;
    if (route.macros.length > request.search.macroStages || route.macros.some((macro) => !allowedMacro(macro, request))) continue;
    const key = routeKey(route);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    progress('SEARCH', route.description ?? '比较固定宏动作候选');
    let evaluated: RouteReport;
    try {
      const exactRequest: PlanRequest = { ...request, search: { ...request.search, maxStates: Math.min(request.search.maxStates, 6000) } };
      evaluated = reportRoute(engine, exactRequest, route, () => cancelled() || searchTimedOut());
    } catch (error) {
      if (error instanceof EvaluationInterruptedError) { stopReason = cancelled() ? 'CANCELLED' : 'TIME_BUDGET'; break; }
      if (!(error instanceof SamplingRequiredError || error instanceof EvaluationLimitError || error instanceof OutcomeLimitError)) throw error;
      try {
        evaluated = sampleRoute(engine, request, route, { samplesPerFp: options.screeningSamplesPerFp ?? 64,
          seed: options.seed ?? 'planner-screen-v1', confidence: reportConfidence, shouldStop: () => cancelled() || searchTimedOut() });
      } catch (sampleError) {
        if (sampleError instanceof SamplingInterruptedError) { unevaluated++; stopReason = searchTimedOut() ? 'TIME_BUDGET' : 'EVALUATION_INCOMPLETE'; if (searchTimedOut()) break; continue; }
        if (sampleError instanceof OutcomeLimitError) { unevaluated++; continue; }
        throw sampleError;
      }
    }
    reports.push(evaluated);
    if (evaluated.evaluationStatus === 'BOUNDED_NUMERICAL') {
      exactCount++;
      certifiedLower = Math.max(certifiedLower, evaluated.score.lower);
      const upper = evaluated.curve.slice(1).reduce((value, point, index) => value.add(exact(point.continuationSuccessUpper ?? 1)
        .mul(exact(rawWeights[index]).div(exactWeightTotal))), ZERO).upper;
      if (!options.disableCertifiedPruning && upper < certifiedLower) space.prune(route);
    } else estimatedCount++;
    if (!primary || compareReports(evaluated, primary) < 0) primary = evaluated;
    await options.yieldControl?.();
  }
  if (cancelled()) throw new PlanningCancelledError();
  if (!exhausted && stopReason === 'CANDIDATE_LANGUAGE_EXHAUSTED') stopReason = 'ROUTE_BUDGET';
  // Refine only the displayed sampled candidate; shared rules stay identical to screening.
  const refined = new Set<string>();
  while (primary?.evaluationStatus === 'ESTIMATED' && !refined.has(routeKey(primary.route)) && !timedOut()) {
    progress('REFINEMENT', '提高当前主推荐的整路线采样精度');
    try {
      const key = routeKey(primary.route);
      const result = sampleRoute(engine, request, primary.route, { samplesPerFp: options.finalSamplesPerFp ?? 1024,
        seed: `${options.seed ?? 'planner'}|final`, confidence: reportConfidence, shouldStop: () => cancelled() || timedOut() });
      const index = reports.findIndex((candidate) => routeKey(candidate.route) === key);
      reports[index] = result;
      refined.add(key);
      primary = [...reports].sort(compareReports)[0] ?? null;
    } catch (error) {
      if (!(error instanceof SamplingInterruptedError || error instanceof OutcomeLimitError)) throw error;
      stopReason = timedOut() ? 'TIME_BUDGET' : 'REFINEMENT_INCOMPLETE';
      break;
    }
  }
  if (cancelled()) throw new PlanningCancelledError();
  // Zero observed successes is not a proof of impossibility; retain that qualification in status.
  if (primary && primary.scoreEstimate <= 0) primary = null;
  progress('DONE', primary ? '已得到当前范围内的主推荐' : '当前搜索范围尚未找到可行路线');
  return finish(primary ? 'RECOMMENDATION' : 'NO_ROUTE_FOUND_IN_SCOPE', [], library.length, space.candidateUpperBound,
    space.pruned(), exhausted && unevaluated === 0 ? 'COMPLETE' : 'INCOMPLETE');
}

/** Production entry: hierarchical complete templates, joint intrinsic rewards, certified practical thresholds. */
export async function plan(input: unknown, options: PlanningOptions = {}): Promise<PlanReport> {
  // The explicit Cartesian seam is retained only for the independent finite-FP regression baseline.
  if (options.library) return planFiniteBaseline(input, options);
  const engine = new RuleEngine(catalogForInputModel(readInputModel(input))), parsed = parsePlanRequest(input, engine.catalog);
  if (!parsed.request) return planFiniteBaseline(input, options);
  const request = parsed.request, now = options.now ?? Date.now, start = now();
  const elapsed = () => Math.max(0, now() - start);
  const stopped = () => Boolean(options.signal?.aborted) || elapsed() >= request.search.milliseconds;
  const searchStopped = () => Boolean(options.signal?.aborted) || elapsed() >= request.search.milliseconds * 0.75;
  if (options.signal?.aborted) throw new PlanningCancelledError();
  const compiled = compileTemplates(request, engine), workspace = new IntrinsicWorkspace(engine, request);
  const terminal = !compiled && !options.intrinsicRoutes && !options.seedRoutes && targetReached(request.item, request.target);
  const seeds = options.intrinsicRoutes ?? options.seedRoutes ?? (compiled?.templates ?? (terminal ? [{ id: routeId([]), macros: [], description: '目标已经达成' }] : commonRoutes(request, engine)));
  const library = compiled || terminal || options.intrinsicRoutes ? [] : macroLibrary(request, engine, seeds);
  const general = routeSpace(library, request.search.macroStages, searchStopped);
  const routes = function* () { yield* seeds; if (!compiled && !terminal && !options.intrinsicRoutes) yield* general.routes; };
  const seen = new Set<string>(), abandoned: IntrinsicReport[] = [], retained: IntrinsicReport[] = [];
  let primary: IntrinsicReport | null = null, evaluated = 0, unresolved = 0, exhausted = true, duplicates = 0;
  let stopReason = 'TEMPLATE_SCOPE_EXHAUSTED';
  const progress = (phase: PlanProgress['phase'], message: string) => options.onProgress?.({ phase, evaluatedRoutes: evaluated,
    elapsedMilliseconds: elapsed(), bestScore: primary?.scoreEstimate ?? null, message });
  progress('VALIDATION', compiled ? `结构 ${compiled.structure.node.key}：按细分结构编译固定模板` : '目标超出双T7分层范围，使用已声明的通用候选语言');
  const compare = (a: IntrinsicReport, b: IntrinsicReport) => Math.abs(a.scoreEstimate - b.scoreEstimate) > 1e-9 ? b.scoreEstimate - a.scoreEstimate :
    midpoint(a.expectedFpGivenSuccess) - midpoint(b.expectedFpGivenSuccess) || a.route.id.localeCompare(b.route.id, 'en');
  const containsChaos = (macros: readonly Macro[]): boolean => macros.some((macro) => macro.kind === 'chaos' ||
    (macro.kind === 'conditional' && containsChaos([...macro.then, ...(macro.otherwise ?? [])])));
  for (const route of routes()) {
    if (options.signal?.aborted) throw new PlanningCancelledError();
    if (searchStopped() || evaluated >= request.search.maxRoutes) { exhausted = false; stopReason = searchStopped() ? 'TIME_BUDGET' : 'ROUTE_BUDGET'; break; }
    const key = routeKey(route); if (seen.has(key)) { duplicates++; continue; } seen.add(key);
    progress('SEARCH', route.description ?? '计算完整固定策略的操作成功率与成功路径FP');
    evaluated++;
    try {
      const routeStart = now();
      const routeStopped = () => searchStopped() || now() - routeStart >= Math.min(containsChaos(route.macros) ? 300 : 1500, request.search.milliseconds / 4);
      const report = evaluateIntrinsic(workspace, route, routeStopped, options.disableCertifiedPruning);
      if (report.intrinsic.decision === 'ABANDONED') abandoned.push(report);
      else if (report.intrinsic.decision === 'UNRESOLVED') unresolved++;
      else { retained.push(report); if (!primary || compare(report, primary) < 0) primary = report; }
    } catch (error) {
      if (options.signal?.aborted) throw new PlanningCancelledError();
      if (!(error instanceof EvaluationLimitError || error instanceof OutcomeLimitError)) throw error;
      unresolved++;
      if (searchStopped()) { exhausted = false; stopReason = 'TIME_BUDGET'; break; }
    }
    await options.yieldControl?.();
  }
  if (options.signal?.aborted) throw new PlanningCancelledError();
  let completion: CompletionReport | null = null;
  if (primary) {
    progress('REFINEMENT', `正在计算起始${REFERENCE_FP}FP的整件完成率`);
    await options.yieldControl?.();
    try { completion = evaluateCompletion(engine, request, primary.route, stopped); }
    catch (error) {
      if (options.signal?.aborted) throw new PlanningCancelledError();
      if (!(error instanceof EvaluationLimitError || error instanceof OutcomeLimitError)) throw error;
      completion = { routeId: primary.route.id, initialFp: REFERENCE_FP, status: 'INCOMPLETE', probability: null,
        recommendation: 'UNRESOLVED', evaluation: 'BOUNDED_NUMERICAL', states: 0, reason: error.message };
    }
  }
  progress('DONE', primary ? `已得到通过15%／${maximumSuccessFp(engine.catalog.model)}FP门槛的当前主推荐` : '已返回放弃记录或尚未完成的候选范围');
  const pareto = retained.filter((row) => !retained.some((other) => other !== row && other.score.lower >= row.score.upper &&
    other.expectedFpGivenSuccess!.upper < row.expectedFpGivenSuccess!.lower));
  return {
    metric: 'INTRINSIC_V2', inputModel: request.inputModel ?? 'AUDITED', modelId: engine.catalog.model.modelId, gameVersion: engine.catalog.model.gameVersion, completion,
    status: primary ? 'RECOMMENDATION' : 'NO_ROUTE_FOUND_IN_SCOPE', primary, issues: [], abandoned, unresolvedRoutes: unresolved,
    searchStatus: exhausted && unresolved === 0 ? 'COMPLETE' : 'INCOMPLETE', optimality: 'NOT_PROVEN', samplingGuarantee: null,
    hierarchy: compiled ? { structure: compiled.structure, upperLabels: 28, routeNodes: 23, generatedTemplates: compiled.templates.length,
      structurallyRejected: compiled.rejected.length,
      preExcluded: compiled.rejected.flatMap((row) => row.probabilityUpperBound === undefined ? [] : [{ ...row, probabilityUpperBound: row.probabilityUpperBound }]),
      workspaceCacheHits: workspace.cacheHits } : undefined,
    search: { grammar: options.intrinsicRoutes ? 'EXPLICIT_FIXED_INTRINSIC_ROUTES' : compiled?.grammar ?? 'GENERAL_FIXED_GRAMMAR_INTRINSIC_V2',
      macroStages: request.search.macroStages, librarySize: compiled ? new Set(compiled.templates.flatMap((row) => row.macros.map((macro) => JSON.stringify(macro)))).size : library.length,
      candidateUpperBound: String(options.intrinsicRoutes?.length ?? compiled?.templates.length ?? general.candidateUpperBound),
      evaluatedRoutes: evaluated, exactRoutes: evaluated - unresolved, estimatedRoutes: 0, unevaluatedRoutes: unresolved,
      skippedDuplicates: duplicates, certifiedPrunedPrefixes: abandoned.filter((row) => row.intrinsic.probabilityMeaning === 'PREFIX_SURVIVAL_UPPER_BOUND').length,
      elapsedMilliseconds: elapsed(), stopReason, paretoRouteIds: pareto.map((row) => row.route.id) },
    conventions: { fpDomain: [], weights: [], materials: 'UNLIMITED', fixedRoute: true, rngModel: engine.catalog.model.rngModel },
    qualification: (request.inputModel === 'FORGEABLE_ANY_EQUAL' ? '未指定部位，采用全装备普通候选并集的等权参考池；不代表全装备平均值或具体装备的真实词条池。' : request.inputModel && request.inputModel !== 'AUDITED' ? '按可锻造前提、100级与该部位全职业通用池计算；' +
      (request.inputModel === 'FORGEABLE_EQUAL' ? '未指定词条采用等权正权重候选池，仅为简化参考，不是未知真实词条的精确概率。' : '已指定词条采用实际制作权重；通用池不冒充指定底材职业池。') : '') +
      `成功率假设FP持续充足，只计操作NG；费用门槛${maximumSuccessFp(engine.catalog.model)}只统计最终成功路径。整件完成率另以起始${REFERENCE_FP}FP结算，包含耗尽保留及最后一次制作。` +
      `模板及分支预先固定；上层标签只路由，数值保留ID、阶数、原生顺序和费用联合核。15%／${maximumSuccessFp(engine.catalog.model)}等号通过；区间跨阈或执行预算不足保留未完成。` +
      '已搜索范围不代表任意长度策略全局最优。普通填充采用预先声明的合法碎片顺序，不宣称所有填充ID均等价。',
  };
}
