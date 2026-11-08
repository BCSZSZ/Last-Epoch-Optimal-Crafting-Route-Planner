import type { Catalog } from './catalog';
import { evaluateCompletion } from './completion';
import { FINITE_INITIAL_FP, FINITE_PROFILE_LABELS, finiteRecommendation } from './finite-policy';
import type { FiniteProfileResult } from './finite-policy';
import { CompactGraph, compactActionText, compactCode, compactDomain } from './finite-state';
import { solveCompactGraph } from './finite-solver';
import { RuleEngine } from './rules';
import type { PlanRequest } from './types';

/** Replay the exported choices, not a fresh optimization which might silently
 * select a different policy. Missing reachable state/FP decisions are errors. */
export async function replayFiniteProfile(request: PlanRequest, catalog: Catalog, report: FiniteProfileResult) {
  if (report.initialFp !== FINITE_INITIAL_FP || report.label !== FINITE_PROFILE_LABELS[report.fpType]) throw new Error('FP profile metadata differs');
  const input = { ...request, item: { ...request.item, fpType: report.fpType } };
  let p: number, mean: number | null = null, successMean: number | null = null;
  if (report.strategyKind === 'FIXED_ROUTE') {
    if (!report.fixedRoute) {
      if (report.status !== 'INCOMPLETE' || report.probability !== null || report.recommendation !== 'UNRESOLVED') throw new Error('Missing fixed route');
      return { fpType: report.fpType, status: 'UNRESOLVED_NO_ROUTE', probability: null };
    }
    const result = evaluateCompletion(new RuleEngine(catalog), input, report.fixedRoute, undefined, 48);
    if (!result.probability || result.status !== 'COMPLETE') throw new Error('Exported fixed route did not finish replay');
    p = (result.probability.lower + result.probability.upper) / 2;
  } else {
    const domain = compactDomain(input, catalog); if (!domain) throw new Error('Exported policy is outside compact domain');
    const graph = new CompactGraph(domain, report.fpType, catalog.model.parameters, input.search.maxStates, () => false);
    const root = graph.include(domain.initial), n = graph.states.length;
    const keys = new Map<string, number>();
    const key = (roles: readonly number[], tiers: string, sealed: string) => JSON.stringify([roles, tiers, sealed]);
    graph.states.forEach((state, s) => { if (state) { const code = compactCode(state); keys.set(key(state.roles, code.tiers, code.sealed), s); } });
    const policies = Array.from({ length: 49 }, () => new Int16Array(n).fill(-2));
    for (const row of report.decisions) {
      const s = keys.get(key(row.roles, row.tiers, row.sealed)); if (s === undefined) throw new Error('Unknown exported policy state');
      if (compactCode(graph.states[s]!).targets !== row.targets) throw new Error('Exported target mask differs');
      const a = row.choice === null ? -1 : graph.actions[s].findIndex(choice => JSON.stringify(choice.action) === JSON.stringify(row.choice) && compactActionText(graph.states[s]!, choice.action) === row.action);
      if (a < 0 && row.action !== '停止：当前动作范围内已无法完成目标') throw new Error('Illegal exported action');
      for (const fp of row.fp) {
        if (!Number.isInteger(fp) || fp < 1 || fp > 48 || policies[fp][s] !== -2) throw new Error('Duplicate or invalid policy balance');
        policies[fp][s] = a;
      }
    }
    // Walk all positive joint branches of the submitted policy, including free loops.
    const { compactCosts } = await import('./finite-solver');
    const costs = compactCosts(report.fpType, catalog.model.parameters), seen = new Set<number>([root * 49 + 48]), todo = [[root, 48]];
    for (let i = 0; i < todo.length; i++) {
      const [s, fp] = todo[i]; if (s < 2 || !fp) continue;
      const a = policies[fp][s]; if (a === -2) throw new Error('Missing reachable policy decision'); if (a < 0) continue;
      for (const e of graph.actions[s][a].edges) if (e.p > 0) for (const b of costs[e.kernel][fp]) if (b.p > 0) {
        const next = e.to * 49 + b.fp; if (!seen.has(next)) { seen.add(next); todo.push([e.to, b.fp]); }
      }
    }
    const result = await solveCompactGraph(graph, report.fpType, catalog.model.parameters, { stopped: () => false }, policies);
    p = result.values[48][root]; mean = result.actualCosts[48][root]; successMean = p > 0 ? result.successfulCosts[48][root] / p : null;
    if (report.actualMeanFp === null || Math.abs(report.actualMeanFp - mean) > 1e-7 ||
      (successMean !== null && (report.successActualMeanFp === null || Math.abs(report.successActualMeanFp - successMean) > 1e-6))) throw new Error('Exported FP reward differs');
  }
  if (!report.probability || report.estimate === null || Math.abs(report.estimate - p) > 1e-9 || p < report.probability.lower - 1e-9 || p > report.probability.upper + 1e-9 ||
    finiteRecommendation(report.probability) !== report.recommendation) throw new Error('Exported completion probability/recommendation differs');
  return { fpType: report.fpType, status: 'PASS_EXPORTED_POLICY_REPLAY', probability: p, actualMeanFp: mean, successActualMeanFp: successMean };
}
