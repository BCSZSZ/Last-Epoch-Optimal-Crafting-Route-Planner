import type { Catalog } from './catalog';
import { ordinary } from './catalog';
import { boundedCostKernel, tierPermutations } from './probability';
import { targetReached } from './target';
import type { PlanRequest, Route } from './types';
import type { FiniteStepPlan } from './finite-steps';
import { macroStep, predicateReached } from './evaluation';
import { RuleEngine } from './rules';
import type { Macro } from './types';

/** A lone Havoc-until-goal controller has an exact finite48 scalar recurrence,
 * even when identity weights prevent using the equal-pool policy solver. */
export function finishStep(request: PlanRequest, route: Route, catalog: Catalog): { stepPlan: FiniteStepPlan; mean: number; successMean: number | null; p: number } | null {
  const engine = new RuleEngine(catalog);
  const active = (macros: readonly Macro[]): Macro | null => {
    for (const macro of macros) {
      if (macro.kind === 'conditional') { const result = active(predicateReached(request.item, macro.when, request, engine) ? macro.then : macro.otherwise ?? []); if (result) return result; }
      else if (macroStep(macro, request.item, request, engine) !== 'SKIP') return macro;
    }
    return null;
  };
  const macro = active(route.macros), rows = ordinary(request.item);
  if (macro?.kind !== 'repeat' || macro.action.kind !== 'havoc' || macro.until.kind !== 'target' ||
    request.constraints.protected?.length || request.constraints.maxAttempts !== undefined || rows.length !== 4 ||
    request.target.requirements.length !== 2 || request.target.requirements.some(r => r.ids.length !== 1 || r.slot !== 'ordinary' || r.minTier !== 7 || r.maxTier !== 7 || r.minRollByte !== undefined || !rows.some(row => row.id === r.ids[0]))) return null;
  const permutations = tierPermutations(rows.map(row => row.tier));
  if (permutations.length < 2 || targetReached(request.item, request.target)) return null;
  const hits = permutations.filter(ts => targetReached({ ...request.item, affixes: [...request.item.affixes.filter(r => r.slot !== 'ordinary'), ...rows.map((r, i) => ({ ...r, tier: ts[i] }))] }, request.target)).length;
  const q = hits / (permutations.length - 1), p = [0], mean = [0], moment = [0];
  for (let fp = 1; fp <= 48; fp++) {
    const costs = boundedCostKernel(fp, 20, request.item.fpType, macro.action.glyph === 'hope', catalog.model.parameters);
    let a = 0, e = 0, m = 0, same = 0;
    for (const b of costs) {
      const w = b.bounds.midpoint, r = b.value, spent = fp - r;
      if (r === fp) { same += w * (1 - q); a += w * q; continue; }
      const success = q + (1 - q) * p[r];
      a += w * success; e += w * (spent + (1 - q) * mean[r]); m += w * (spent * success + (1 - q) * moment[r]);
    }
    p.push(a / (1 - same)); mean.push(e / (1 - same)); moment.push(m / (1 - same));
  }
  return { p: p[48], mean: mean[48], successMean: p[48] > 0 ? moment[48] / p[48] : null,
    stepPlan: { main: [1], totalExpectedFp: mean[48], costMeaning: 'ACTUAL48_PHASE_COST_PER_ENTRY', steps: [{ key: 'havoc:finish', id: 1, operation: '浩劫', criterion: '目标A、目标B均为T7', expectedFp: mean[48], expectedEntries: 1, totalFpContribution: mean[48], next: [] }] } };
}
