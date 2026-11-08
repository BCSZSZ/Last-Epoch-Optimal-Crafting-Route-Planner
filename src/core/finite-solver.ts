import { boundedCostKernel } from './probability';
import { COMPACT_KERNELS, CompactGraph, FiniteStateLimit } from './finite-state';
import type { FpType } from './types';

export interface FiniteBalance { readonly fp: number; readonly p: number; readonly lo: number; readonly hi: number }
export interface CompactSolution {
  readonly values: readonly Float64Array[];
  readonly policies: readonly Int16Array[];
  readonly actualCosts: readonly Float64Array[];
  readonly successfulCosts: readonly Float64Array[];
  readonly errors: readonly number[];
  readonly costs: readonly (readonly (readonly FiniteBalance[])[])[];
  readonly maximumResidual: number;
}
export interface FiniteSolveHooks {
  /** Numeric baseline callers may omit the independent presentation rewards. */
  readonly includeSteps?: boolean;
  readonly stopped: () => boolean;
  readonly yieldControl?: () => Promise<void>;
  readonly progress?: (fp: number, states: number) => void;
}
type CostParameters = Parameters<typeof boundedCostKernel>[4];

export function compactCosts(profile: FpType, parameters: CostParameters): readonly (readonly (readonly FiniteBalance[])[])[] {
  return COMPACT_KERNELS.map(([upper, hope]) => Array.from({ length: 49 }, (_, fp) => upper ?
    boundedCostKernel(fp, upper, profile, hope, parameters).map(row => ({ fp: row.value, p: row.bounds.midpoint, lo: Math.max(0, row.bounds.lower), hi: row.bounds.upper })) :
    [{ fp, p: 1, lo: 1, hi: 1 }]));
}

/** Same-FP Bellman operator is contractive: every allowed atomic action has a
 * positive chance to consumeFP. Joint coefficients retain outward enclosures;
 * residual/rounding and lower-balance errors give an a-posteriori uniform bound
 * for both optimal values and the exported greedy policy (not residual alone).
 */
export async function solveCompactGraph(graph: CompactGraph, profile: FpType, parameters: CostParameters, hooks: FiniteSolveHooks, fixedPolicies?: readonly Int16Array[]): Promise<CompactSolution> {
  const candidates = (s: number, fp: number): number[] => fixedPolicies ? (fixedPolicies[fp][s] < 0 ? [] : [fixedPolicies[fp][s]]) : graph.actions[s].map((_, a) => a);
  const n = graph.states.length, costs = compactCosts(profile, parameters), values: Float64Array[] = [new Float64Array(n)],
    policies: Int16Array[] = [new Int16Array(n).fill(-1)], actualCosts: Float64Array[] = [new Float64Array(n)],
    successfulCosts: Float64Array[] = [new Float64Array(n)], errors = [0];
  values[0][1] = 1; let maximumResidual = 0;
  const check = () => { if (hooks.stopped()) throw new FiniteStateLimit('有限FP求解达到本次执行预算'); };
  for (let fp = 1; fp <= 48; fp++) {
    check(); const same = costs.map(k => k[fp].find(b => b.fp === fp)?.p ?? 0);
    const lower = costs.map(() => new Float64Array(n));
    for (let k = 0; k < costs.length; k++) for (const b of costs[k][fp]) if (b.fp < fp) {
      const old = values[b.fp], out = lower[k]; for (let s = 1; s < n; s++) out[s] += b.p * old[s];
    }
    const constants = graph.actions.map(actions => new Float64Array(actions.length));
    const self = graph.actions.map(actions => new Float64Array(actions.length));
    for (let s = 2; s < n; s++) graph.actions[s].forEach((action, a) => action.edges.forEach(e => {
      constants[s][a] += e.p * lower[e.kernel][e.to]; if (e.to === s) self[s][a] += e.p * same[e.kernel];
    }));
    const v = new Float64Array(n), policy = new Int16Array(n).fill(-1); v[1] = 1; let converged = false;
    for (let it = 0; it < 512; it++) {
      if (!(it & 7)) check(); let delta = 0;
      for (let s = 2; s < n; s++) {
        let best = 0;
        for (const a of candidates(s, fp)) {
          let q = constants[s][a];
          for (const e of graph.actions[s][a].edges) if (e.to !== s) q += e.p * same[e.kernel] * v[e.to];
          q /= 1 - self[s][a]; if (q > best) best = q;
        }
        best = Math.min(1, Math.max(0, best)); delta = Math.max(delta, Math.abs(best - v[s])); v[s] = best;
      }
      if (delta < 2e-13) { converged = true; break; }
    }
    if (!converged) throw new FiniteStateLimit('同FP循环未在本次预算内收敛');
    let residual = 0;
    for (let s = 2; s < n; s++) {
      let best = 0, chosen = -1;
      const qs: number[] = [];
      for (const a of candidates(s, fp)) {
        const action = graph.actions[s][a];
        let q = constants[s][a]; for (const e of action.edges) q += e.p * same[e.kernel] * v[e.to];
        qs[a] = q;
        if (q > best) { best = q; chosen = a; }
      }
      // Resolve numerically equal symmetric actions by their declared order.
      // The resulting policy residual is included in the certified error bound.
      if (fixedPolicies) chosen = fixedPolicies[fp][s] >= 0 ? fixedPolicies[fp][s] : -1;
      else if (best > 0) chosen = qs.findIndex(q => q > 0 && q >= best - 1e-12);
      policy[s] = chosen; residual = Math.max(residual, Math.abs(best - v[s]), chosen < 0 ? 0 : Math.abs(qs[chosen] - v[s]));
    }
    maximumResidual = Math.max(maximumResidual, residual);
    const kernelStats = costs.map(k => ({
      mass: k[fp].reduce((t, b) => t + b.p, 0),
      radius: k[fp].reduce((t, b) => t + Math.max(b.p - b.lo, b.hi - b.p), 0),
      sameHi: k[fp].find(b => b.fp === fp)?.hi ?? 0,
      earlierError: k[fp].reduce((t, b) => t + (b.fp < fp ? b.hi * errors[b.fp] : 0), 0),
    }));
    let bound = 0;
    for (let s = 2; s < n; s++) for (const a of candidates(s, fp)) {
      const action = graph.actions[s][a];
      let rho = 0, error = 0;
      for (const e of action.edges) {
        const k = kernelStats[e.kernel]; rho += e.hi * k.sameHi;
        error += Math.max(e.p - e.lo, e.hi - e.p) * k.mass + e.hi * (k.radius + k.earlierError);
      }
      if (rho >= 1) throw new FiniteStateLimit('当前免费回路缺少收敛证书');
      // Nonnegative finite sums: this exceeds gamma_n for all products/adds in
      // the lower-balance and atomic Bellman sums, including self elimination.
      const rounding = Number.EPSILON * (8 * fp + 16 * action.edges.length + 128) * 4;
      bound = Math.max(bound, (residual + error + rounding) / (1 - rho));
    }
    errors.push(bound); values.push(v); policies.push(policy);
    const evaluateReward = (history: readonly Float64Array[], successOnly: boolean): Float64Array => {
      const before = costs.map(() => new Float64Array(n));
      for (let k = 0; k < costs.length; k++) for (const b of costs[k][fp]) {
        const out = before[k], prev = b.fp < fp ? history[b.fp] : null, success = successOnly ? values[b.fp] : null;
        for (let s = 0; s < n; s++) out[s] += b.p * ((fp - b.fp) * (success ? success[s] : 1) + (prev?.[s] ?? 0));
      }
      const reward = new Float64Array(n);
      for (let it = 0; it < 512; it++) {
        let delta = 0;
        for (let s = 2; s < n; s++) {
          const a = policy[s]; if (a < 0) continue; let q = 0, loop = 0;
          for (const e of graph.actions[s][a].edges) {
            q += e.p * before[e.kernel][e.to];
            if (e.to === s) loop += e.p * same[e.kernel]; else q += e.p * same[e.kernel] * reward[e.to];
          }
          q /= 1 - loop; delta = Math.max(delta, Math.abs(q - reward[s])); reward[s] = q;
        }
        if (delta < 2e-11) return reward;
      }
      throw new FiniteStateLimit('实际FP消耗统计尚未收敛');
    };
    actualCosts.push(evaluateReward(actualCosts, false)); successfulCosts.push(evaluateReward(successfulCosts, true));
    if (fp % 4 === 0) { hooks.progress?.(fp, n); await hooks.yieldControl?.(); }
  }
  return { values, policies, actualCosts, successfulCosts, errors, costs, maximumResidual };
}
