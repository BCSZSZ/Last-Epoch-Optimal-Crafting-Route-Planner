import { ordinary } from './catalog';
import { exact, ONE, ZERO } from './interval';
import { boundedCostKernel } from './probability';
import { maximumSuccessFp } from './policy';
import { RuleEngine } from './rules';
import type { Macro, PlanRequest, Predicate, Route } from './types';

export interface RedemptionCertificate {
  readonly decision: 'SINGLE_CAST_BELOW_MINIMUM' | 'REPEATED_SUCCESS_FP_ABOVE_MAXIMUM';
  readonly perCastSuccessUpperBound: number;
  readonly successfulFpLowerBound: number | null;
  readonly certainlyEventuallySucceeds: boolean;
}

/** History-uniform union bound; each slot excludes its own old ID and all IDs placed earlier in this cast. */
export function twoTargetCastBound(request: PlanRequest, engine: RuleEngine): { upper: number; clearingPossible: boolean } | null {
  const goals = request.target.requirements.filter((row) => !row.optional), rows = ordinary(request.item);
  if (engine.constructor !== RuleEngine || goals.length !== 2 || rows.length !== 4 ||
    goals.some((row) => row.ids.length !== 1 || row.slot !== 'ordinary' || row.minTier !== 7 || row.maxTier !== 7 || row.minRollByte !== undefined) ||
    rows.filter((row) => row.tier === 7).length !== 2 || request.constraints.protected?.length) return null;
  const ids = goals.map((row) => row.ids[0]);
  if (ids[0] === ids[1] || ids.some((id) => request.item.affixes.some((row) => row.id === id))) return null;
  const sides = ids.map((id) => engine.catalog.side(id));
  if (sides.some((side) => side > 1)) return null;
  const pools = ([0, 1] as const).map((side) => engine.catalog.rerollPool({ ...request.item, affixes: [] }, side));
  const selected = ([0, 1] as const).map((side) => rows.filter((row) => row.tier >= 6 && engine.catalog.side(row.id) === side).length);
  const excluded = ([0, 1] as const).map((side) => request.item.affixes.filter((row) => engine.catalog.side(row.id) === side).length);
  const needed = ([0, 1] as const).map((side) => sides.filter((value) => value === side).length);
  if (ids.some((id, i) => !pools[sides[i]].some((row) => row.id === id))) return null;
  const perDraw = ids.map((id, i) => {
    const pool = pools[sides[i]], target = pool.find((row) => row.id === id)!;
    // At most k other IDs can be excluded. Choosing the k heaviest gives a denominator valid for EVERY history.
    const heaviest = pool.filter((row) => row.id !== id).sort((a, b) => b.bounds.upper - a.bounds.upper).slice(0, excluded[sides[i]]);
    const denominator = ONE.sub(heaviest.reduce((sum, row) => sum.add(row.bounds), ZERO));
    return denominator.lower <= 0 ? ONE : target.bounds.div(denominator).clamp(0, 1);
  });
  const pairs = sides[0] === sides[1] ? selected[sides[0]] * (selected[sides[0]] - 1) : selected[sides[0]] * selected[sides[1]];
  const upper = perDraw[0].mul(perDraw[1]).mul(exact(pairs)).clamp(0, 1).upper;
  // Enough fresh non-goal IDs lets every state clear to garbage in one cast, then hit both goals next cast.
  // Finite pools with positive weights give a uniform positive two-cast hitting probability, hence absorption P=1.
  const clearingPossible = pools.every((pool, side) => selected[side] >= needed[side] && pool.every((row) => row.bounds.lower > 0) &&
    (selected[side] === 0 || pool.length >= excluded[side] + needed[side] + 1));
  return { upper, clearingPossible };
}

function identityGoals(predicate: Predicate, ids: readonly number[]): boolean {
  const parts = predicate.kind === 'all' ? predicate.predicates : [predicate];
  return parts.length === ids.length && ids.every((id) => parts.some((part) => part.kind === 'identity' &&
    part.requirement.ids.length === 1 && part.requirement.ids[0] === id && part.requirement.slot === 'ordinary' &&
    part.requirement.minTier === 1 && (part.requirement.maxTier ?? 8) === 8 && part.requirement.minRollByte === undefined));
}

/** Only the pure double-hit family; no certificate is extrapolated to first-hit/acquisition hybrids. */
export function redemptionCertificate(request: PlanRequest, route: Route, engine: RuleEngine): RedemptionCertificate | null {
  const [first, ...tail] = route.macros;
  if ((first?.kind !== 'once' && first?.kind !== 'repeat') || first.action.kind !== 'redemption' ||
    tail.length === 0 || tail.some((macro: Macro) => macro.kind !== 'fill' && !(macro.kind === 'repeat' && macro.action.kind === 'havoc' && macro.until.kind === 'target')) ||
    !tail.some((macro) => macro.kind === 'repeat') || request.constraints.allowedActions &&
      (!request.constraints.allowedActions.includes('redemption') || !request.constraints.allowedActions.includes('havoc')) ||
    engine.eligibility(request.item, 63, first.action, request.craftingContext, request.constraints).length) return null;
  const bound = twoTargetCastBound(request, engine); if (!bound) return null;
  const cost = boundedCostKernel(63, 20, request.item.fpType, first.action.glyph === 'hope', engine.catalog.model.parameters)
    .reduce((sum, row) => sum.add(row.bounds.mul(exact(63 - row.value))), ZERO);
  if (first.kind === 'once' && bound.upper < 0.15) return { decision: 'SINGLE_CAST_BELOW_MINIMUM', perCastSuccessUpperBound: bound.upper,
    successfulFpLowerBound: bound.upper > 0 ? cost.lower : null, certainlyEventuallySucceeds: false };
  if (first.kind !== 'repeat' || request.constraints.maxAttempts !== undefined || !bound.clearingPossible || bound.upper <= 0 ||
    !identityGoals(first.until, request.target.requirements.filter((row) => !row.optional).map((row) => row.ids[0]))) return null;
  const lower = cost.div(exact(bound.upper)).lower;
  return lower > maximumSuccessFp(engine.catalog.model) ? { decision: 'REPEATED_SUCCESS_FP_ABOVE_MAXIMUM', perCastSuccessUpperBound: bound.upper,
    successfulFpLowerBound: lower, certainlyEventuallySucceeds: true } : null;
}
