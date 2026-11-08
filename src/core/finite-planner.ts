import { allowedMacro, commonRoutes, routeKey } from './candidates';
import { evaluateCompletion } from './completion';
import { EvaluationInterruptedError, EvaluationLimitError } from './evaluation';
import { compileTemplates } from './hierarchy';
import { catalogForInputModel, readInputModel } from './input-model';
import { FINITE_POLICY_VERSION, FINITE_PROFILE_LABELS, finiteRecommendation, solveCompactProfile } from './finite-policy';
import type { FiniteProfileResult } from './finite-policy';
import { PlanningCancelledError } from './planning-errors';
import { productionPrograms } from './program-search';
import { parsePlanRequest } from './request';
import { OutcomeLimitError, RuleEngine } from './rules';
import { targetReached } from './target';
import type { PlanningOptions, PlanReport } from './planner';
import type { FpType, PlanRequest, Route } from './types';

/** Generic inputs retain fixed-route capabilities; every generated candidate is
 * evaluated at the actual48FP, without intrinsic15%/65FP screening. */
async function fixedProfile(request: PlanRequest, profile: FpType, options: PlanningOptions, stopped: () => boolean): Promise<FiniteProfileResult> {
  const input = { ...request, item: { ...request.item, fpType: profile } }, engine = new RuleEngine(catalogForInputModel(input.inputModel));
  const compiled = compileTemplates(input, engine, true), candidates = targetReached(input.item, input.target) ?
    [{ id: 'already-complete', macros: [], description: '目标已经达成' }] : [
      ...productionPrograms(input, engine) ?? [], ...compiled?.templates ?? [], ...commonRoutes(input, engine),
    ];
  const seen = new Set<string>(); let best: { route: Route; probability: { lower: number; upper: number }; states: number } | null = null;
  let evaluated = 0, incomplete = false;
  for (const route of candidates) {
    if (options.signal?.aborted) throw new PlanningCancelledError();
    if (stopped() || evaluated >= input.search.maxRoutes) { incomplete = true; break; }
    if (route.macros.some(macro => !allowedMacro(macro, input))) continue;
    const key = routeKey(route); if (seen.has(key)) continue; seen.add(key); evaluated++;
    try {
      const report = evaluateCompletion(engine, input, route, stopped, 48);
      if (report.status !== 'COMPLETE' || !report.probability) incomplete = true;
      else if (!best || report.probability.lower + report.probability.upper > best.probability.lower + best.probability.upper) {
        best = { route, probability: report.probability, states: report.states };
      }
    } catch (error) {
      if (options.signal?.aborted) throw new PlanningCancelledError();
      // Resource/graph limits are an incomplete search, never probability0.
      if (!(error instanceof EvaluationInterruptedError || error instanceof EvaluationLimitError || error instanceof OutcomeLimitError)) throw error;
      incomplete = true;
    }
    if (!(evaluated % 8)) await options.yieldControl?.();
  }
  if (options.signal?.aborted) throw new PlanningCancelledError();
  return { fpType: profile, label: FINITE_PROFILE_LABELS[profile], initialFp: 48, probability: best?.probability ?? null,
    estimate: best ? (best.probability.lower + best.probability.upper) / 2 : null, recommendation: finiteRecommendation(best?.probability ?? null),
    status: incomplete ? 'INCOMPLETE' : 'COMPLETE', strategyKind: 'FIXED_ROUTE', strategyId: best?.route.id ?? `pending-${profile}`,
    firstAction: best?.route.description ?? '未在本次预算内得到完整路线', actualMeanFp: best?.route.macros.length === 0 ? 0 : null,
    successActualMeanFp: best?.route.macros.length === 0 ? 0 : null, decisions: [], example: [], states: best?.states ?? 0,
    optimalityGapUpper: null, maximumResidual: null, scope: `当前合法固定候选内按48FP比较，已评价${evaluated}项；未证明任意条件策略最优`,
    note: incomplete ? '部分候选未完成；显示的是已找到路线的完成率，不将未算候选记作0。' : '此输入使用固定候选内最优，未采用普通等权双T7状态合并。',
    ...(best ? { fixedRoute: best.route } : {}) };
}

export async function planFiniteProfiles(input: unknown, options: PlanningOptions = {}): Promise<PlanReport> {
  const catalog = catalogForInputModel(readInputModel(input)), parsed = parsePlanRequest(input, catalog), now = options.now ?? Date.now, start = now();
  const elapsed = () => Math.max(0, now() - start);
  const common = { metric: 'FINITE_48_PROFILES_V3' as const, modelId: catalog.model.modelId, gameVersion: catalog.model.gameVersion,
    primary: null, samplingGuarantee: null, conventions: { fpDomain: [48], weights: [1], materials: 'UNLIMITED' as const, fixedRoute: false, rngModel: catalog.model.rngModel } };
  if (!parsed.request) return { ...common, status: 'INVALID_INPUT', issues: parsed.issues, searchStatus: 'NOT_STARTED', optimality: 'NOT_PROVEN',
    search: { grammar: 'NOT_COMPILED', macroStages: 0, librarySize: 0, candidateUpperBound: '0', evaluatedRoutes: 0, exactRoutes: 0, estimatedRoutes: 0,
      unevaluatedRoutes: 0, skippedDuplicates: 0, certifiedPrunedPrefixes: 0, elapsedMilliseconds: elapsed(), stopReason: 'INVALID_INPUT', paretoRouteIds: [] },
    qualification: '输入未通过校验，没有放宽目标或启动搜索。' };
  const request = parsed.request, profiles: FiniteProfileResult[] = [], order: readonly FpType[] = ['NORMAL', 'ICE', 'BLOOD'];
  for (const [index, profile] of order.entries()) {
    if (options.signal?.aborted) throw new PlanningCancelledError();
    const remaining = Math.max(0, request.search.milliseconds - elapsed()), deadline = now() + remaining / (3 - index);
    const stopped = () => Boolean(options.signal?.aborted) || now() >= deadline;
    options.onProgress?.({ phase: 'SEARCH', evaluatedRoutes: index, elapsedMilliseconds: elapsed(), bestScore: null, message: `正在独立计算${FINITE_PROFILE_LABELS[profile]}` });
    const inputForProfile = { ...request, item: { ...request.item, fpType: profile } };
    const compact = await solveCompactProfile(inputForProfile, catalog, profile, { stopped, yieldControl: options.yieldControl,
      progress: (fp, states) => options.onProgress?.({ phase: 'SEARCH', evaluatedRoutes: states, elapsedMilliseconds: elapsed(), bestScore: null,
        message: `${FINITE_PROFILE_LABELS[profile]}：正在计算${fp}/48FP` }) });
    if (options.signal?.aborted) throw new PlanningCancelledError();
    profiles.push(compact ?? await fixedProfile(request, profile, options, stopped));
    await options.yieldControl?.();
  }
  const complete = profiles.every(row => row.status === 'COMPLETE'), states = profiles.reduce((sum, row) => sum + row.states, 0);
  options.onProgress?.({ phase: 'DONE', evaluatedRoutes: states, elapsedMilliseconds: elapsed(), bestScore: null, message: '三个48FP结果已分别计算' });
  return { ...common, inputModel: request.inputModel, status: 'RECOMMENDATION', issues: [],
    finiteProfiles: { version: FINITE_POLICY_VERSION, initialFp: 48, recommendationThreshold: .25, filteringThresholds: null, profiles },
    searchStatus: complete ? 'COMPLETE' : 'INCOMPLETE',
    optimality: complete && profiles.every(row => row.strategyKind === 'STATE_POLICY' && row.optimalityGapUpper !== null && row.optimalityGapUpper < 1e-7) ? 'PROVEN_WITHIN_DECLARED_SCOPE' : 'NOT_PROVEN',
    search: { grammar: 'FINITE48_THREE_STATE_OR_FIXED_SCOPES_V1', macroStages: request.search.macroStages, librarySize: states,
      candidateUpperBound: String(states), evaluatedRoutes: states, exactRoutes: states, estimatedRoutes: 0, unevaluatedRoutes: complete ? 0 : 1,
      skippedDuplicates: 0, certifiedPrunedPrefixes: 0, elapsedMilliseconds: elapsed(), stopReason: complete ? 'DECLARED_SCOPE_COMPLETE' : 'RESOURCE_LIMIT', paretoRouteIds: profiles.map(row => row.strategyId) },
    qualification: '三个条件分别从实际48FP出发并独立选路。没有概率或理论FP均值过滤；低于25%只标不推荐。封印用绝望、混沌用混沌，其他可用希望的动作采用希望。低FP保留、末次耗尽达标及合法失败后继续均按真实联合结果计算；等权池不冒充未指定真实词缀的精确权重。' };
}
