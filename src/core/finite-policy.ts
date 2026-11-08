import type { Catalog } from './catalog';
import { CompactGraph, compactActionText, compactCode, compactDomain, FiniteStateLimit } from './finite-state';
import type { CompactAction, CompactDomain } from './finite-state';
import { solveCompactGraph } from './finite-solver';
import type { CompactSolution, FiniteSolveHooks } from './finite-solver';
import type { FpType, PlanRequest, Route } from './types';
import { buildFiniteSteps } from './finite-steps';
import type { FixedFpReport } from './fixed-fp';
import { initialFp } from './initial-fp';
import type { FiniteStepPlan } from './finite-steps';

export const FINITE_POLICY_VERSION = 'FINITE48_THREE_PROFILES_V1';
export const FINITE_INITIAL_FP = 48;
export const FINITE_RECOMMENDATION_THRESHOLD = .25;
export type FiniteRecommendation = 'RECOMMENDED' | 'NOT_RECOMMENDED' | 'UNRESOLVED';
export const FINITE_PROFILE_LABELS: Readonly<Record<FpType, string>> = { NORMAL: '单独希望', ICE: '冰＋希望', BLOOD: '血＋希望' };
export interface FiniteDecision {
  readonly tiers: string; readonly targets: string; readonly sealed: string; readonly roles: readonly number[];
  readonly fp: readonly number[]; readonly fpRanges: string; readonly action: string; readonly choice: CompactAction | null;
}
export interface FiniteExampleStep {
  readonly before: string; readonly after: string; readonly fromFp: number; readonly toFp: number; readonly action: string;
}
export interface FiniteProfileResult {
  readonly fpType: FpType; readonly label: string; readonly initialFp: number;
  readonly probability: { readonly lower: number; readonly upper: number } | null;
  readonly estimate: number | null; readonly recommendation: FiniteRecommendation;
  readonly status: 'COMPLETE' | 'INCOMPLETE'; readonly strategyKind: 'STATE_POLICY' | 'FIXED_ROUTE';
  readonly strategyId: string; readonly firstAction: string;
  readonly actualMeanFp: number | null; readonly successActualMeanFp: number | null;
  readonly decisions: readonly FiniteDecision[]; readonly example: readonly FiniteExampleStep[];
  readonly states: number; readonly optimalityGapUpper: number | null; readonly maximumResidual: number | null;
  readonly scope: string; readonly note: string | null; readonly fixedRoute?: Route;
  readonly stepPlan?: FiniteStepPlan;
  readonly fixedFp?: FixedFpReport;
}
export interface FiniteProfilesReport {
  readonly version: typeof FINITE_POLICY_VERSION; readonly initialFp: number; readonly recommendationThreshold: .25;
  readonly filteringThresholds: null; readonly profiles: readonly FiniteProfileResult[];
}

export function finiteRecommendation(probability: { lower: number; upper: number } | null): FiniteRecommendation {
  if (!probability) return 'UNRESOLVED';
  if (probability.upper < FINITE_RECOMMENDATION_THRESHOLD) return 'NOT_RECOMMENDED';
  if (probability.lower >= FINITE_RECOMMENDATION_THRESHOLD) return 'RECOMMENDED';
  return 'UNRESOLVED';
}
export function fpRanges(values: readonly number[]): string {
  const xs = [...new Set(values)].sort((a, b) => a - b), parts: string[] = [];
  for (let i = 0; i < xs.length;) { let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    parts.push(i === j ? String(xs[i]) : `${xs[i]}–${xs[j]}`); i = j + 1; }
  return parts.join('、');
}
function identifier(text: string): string {
  let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `finite-${(h >>> 0).toString(16)}`;
}

interface DomainCache {
  readonly graphs: Partial<Record<'NORMAL' | 'BLOOD', CompactGraph>>;
  readonly solutions: Partial<Record<FpType, { size: number; solution: CompactSolution; maximumFp: number }>>;
}
const cache = new Map<string, DomainCache>();
export function clearFinitePolicyCache(): void { cache.clear(); }

function exportPolicy(graph: CompactGraph, solution: CompactSolution, root: number, maximumFp: number): { decisions: FiniteDecision[]; example: FiniteExampleStep[] } {
  const seen = new Set<number>([root * (maximumFp + 1) + maximumFp]), todo: [number, number][] = [[root, maximumFp]], rows = new Map<string, { state: number; action: number; fps: number[] }>();
  for (let cursor = 0; cursor < todo.length; cursor++) {
    const [s, fp] = todo[cursor];
    if (s < 2 || !fp) continue;
    const a = solution.policies[fp][s], rowKey = `${s}:${a}`;
    if (!rows.has(rowKey)) rows.set(rowKey, { state: s, action: a, fps: [] }); rows.get(rowKey)!.fps.push(fp);
    if (a < 0) continue;
    for (const e of graph.actions[s][a].edges) if (e.p > 0 && e.to >= 2) for (const b of solution.costs[e.kernel][fp]) if (b.p > 0 && b.fp > 0) {
      const next = e.to * (maximumFp + 1) + b.fp; if (!seen.has(next)) { seen.add(next); todo.push([e.to, b.fp]); }
    }
  }
  const decisions = [...rows.values()].map(row => {
    const state = graph.states[row.state]!; return { ...compactCode(state), roles: state.roles, fp: [...row.fps].sort((a, b) => a - b), fpRanges: fpRanges(row.fps),
      action: row.action < 0 ? '停止：当前动作范围内已无法完成目标' : compactActionText(state, graph.actions[row.state][row.action].action),
      choice: row.action < 0 ? null : graph.actions[row.state][row.action].action };
  }).sort((a, b) => a.tiers.localeCompare(b.tiers) || a.targets.localeCompare(b.targets) || a.sealed.localeCompare(b.sealed) || a.fp[0] - b.fp[0]);
  const label = (s: number) => s === 1 ? '两条指定目标均T7，完成' : s === 0 ? '失去T7来源，停止' : `${compactCode(graph.states[s]!).tiers} / ${compactCode(graph.states[s]!).targets}`;
  // Concrete, positive-probability success example. It is explicitly not a
  // substitute for the complete policy above or the reported total probability.
  const nodes: { s: number; fp: number; previous: number; step: FiniteExampleStep | null }[] = [{ s: root, fp: maximumFp, previous: -1, step: null }];
  const visited = new Set([root * (maximumFp + 1) + maximumFp]); let end = root === 1 ? 0 : -1;
  for (let cursor = 0; cursor < nodes.length && cursor < 150000 && end < 0; cursor++) {
    const node = nodes[cursor]; if (node.s < 2 || !node.fp) continue;
    const a = solution.policies[node.fp][node.s]; if (a < 0) continue;
    const choice = graph.actions[node.s][a];
    const edges = [...choice.edges].filter(e => e.p > 0 && e.to !== 0).sort((a, b) => Number(b.to === 1) - Number(a.to === 1) || Number(a.kernel === 0) - Number(b.kernel === 0) || b.p - a.p);
    for (const e of edges) {
      const balances = solution.costs[e.kernel][node.fp], paid = balances.filter(b => b.fp > 0 && b.fp < node.fp);
      const candidates = [];
      if (paid.length) {
        const total = paid.reduce((v, b) => v + b.p, 0); let cumulative = 0;
        candidates.push(paid.find(b => { cumulative += b.p; return cumulative >= total / 2; })!, paid[paid.length - 1]);
      }
      candidates.push(...balances.filter(b => b.fp === node.fp || e.to === 1 && b.fp === 0));
      for (const b of candidates) {
        const key = e.to * (maximumFp + 1) + b.fp; if (visited.has(key) || !solution.values[b.fp][e.to]) continue; visited.add(key);
        nodes.push({ s: e.to, fp: b.fp, previous: cursor, step: { before: label(node.s), after: label(e.to), fromFp: node.fp, toFp: b.fp,
          action: compactActionText(graph.states[node.s]!, choice.action) } });
        if (e.to === 1) { end = nodes.length - 1; break; }
      }
      if (end >= 0) break;
    }
  }
  const example: FiniteExampleStep[] = [];
  if (end >= 0) for (let i = end; nodes[i].previous >= 0; i = nodes[i].previous) example.unshift(nodes[i].step!);
  return { decisions, example };
}

export async function solveCompactProfile(request: PlanRequest, catalog: Catalog, profile: FpType, hooks: FiniteSolveHooks): Promise<FiniteProfileResult | null> {
  const domain: CompactDomain | null = compactDomain(request, catalog); if (!domain) return null;
  const maximumFp = initialFp(request), key = domain.key, maxStates = request.search.maxStates;
  let entry = cache.get(key);
  if (!entry) { if (cache.size >= 2) cache.delete(cache.keys().next().value!); entry = { graphs: {}, solutions: {} }; cache.set(key, entry); }
  const graphType = profile === 'BLOOD' ? 'BLOOD' : 'NORMAL';
  let graph = entry.graphs[graphType];
  if (graph && graph.states.length > maxStates) return null;
  try {
    if (!graph) graph = new CompactGraph(domain, graphType, catalog.model.parameters, maxStates, hooks.stopped);
    const root = graph.include(domain.initial, hooks.stopped); entry.graphs[graphType] = graph;
    let solution = entry.solutions[profile]?.size === graph.states.length && entry.solutions[profile]!.maximumFp >= maximumFp ? entry.solutions[profile]!.solution : undefined;
    if (!solution) { solution = await solveCompactGraph(graph, profile, catalog.model.parameters, hooks, undefined, maximumFp); entry.solutions[profile] = { size: graph.states.length, solution, maximumFp }; }
    const p = solution.values[maximumFp][root], error = root < 2 ? 0 : solution.errors[maximumFp];
    const probability = { lower: Math.max(0, p - error), upper: Math.min(1, p + error) };
    const policy = exportPolicy(graph, solution, root, maximumFp), a = solution.policies[maximumFp][root];
    return { fpType: profile, label: FINITE_PROFILE_LABELS[profile], initialFp: maximumFp, probability, estimate: p,
      recommendation: finiteRecommendation(probability), status: 'COMPLETE', strategyKind: 'STATE_POLICY',
      strategyId: identifier(JSON.stringify([FINITE_POLICY_VERSION, key, domain.targetIds, domain.initial, profile, maximumFp])),
      firstAction: root === 1 ? '目标已满足，无需操作' : maximumFp===0 ? 'FP已耗尽，无法继续打造' : a < 0 ? '停止：当前动作范围内无法完成目标' : compactActionText(graph.states[root]!, graph.actions[root][a].action),
      actualMeanFp: solution.actualCosts[maximumFp][root], successActualMeanFp: p > 0 ? solution.successfulCosts[maximumFp][root] / p : null,
      ...policy, ...(hooks.includeSteps === false ? {} : { stepPlan: buildFiniteSteps(graph, solution, root, maximumFp) }), states: graph.states.length, optimalityGapUpper: 2 * error, maximumResidual: solution.maximumResidual,
      scope: '100级可锻造普通等权池、两条普通T7来源、两条指定普通T7目标；完整合法动作及失败后继续', note: null };
  } catch (error) {
    cache.delete(key); if (error instanceof FiniteStateLimit) return null; throw error;
  }
}
