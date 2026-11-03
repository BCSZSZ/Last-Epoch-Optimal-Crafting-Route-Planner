/** Research reward calculation with continuously sufficient FP, not the shipped planner. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID, itemKey } from '../src/core/catalog';
import { macroStep, predicateReached } from '../src/core/evaluation';
import { exampleRequest } from '../src/core/examples';
import { tierPermutations } from '../src/core/probability';
import { RuleEngine } from '../src/core/rules';
import { targetReached } from '../src/core/target';
import type { FpType, Item, Macro, PlanRequest, Route } from '../src/core/types';

interface Metrics { success: number; fp: number; successFpMoment: number; attempts: number }
const zero = (): Metrics => ({ success: 0, fp: 0, successFpMoment: 0, attempts: 0 });
function accumulate(a: Metrics, b: Metrics, probability: number) {
  for (const key of ['success', 'fp', 'successFpMoment', 'attempts'] as const) a[key] += probability * b[key];
}
function summarize(value: Metrics) {
  return { ...value, fpGivenSuccess: value.success > 0 ? value.successFpMoment / value.success : null };
}
class IntrinsicResearchEvaluator {
  readonly engine = new RuleEngine();
  readonly cache = new Map<string, Metrics>();
  constructor(readonly request: PlanRequest, readonly route: Route) {}
  evaluate(item = this.request.item, stage = 0): Metrics {
    if (targetReached(item, this.request.target)) return { ...zero(), success: 1 };
    if (stage >= this.route.macros.length) return zero();
    const key = `${stage}|${itemKey(item)}`;
    const cached = this.cache.get(key); if (cached) return cached;
    const macro = this.route.macros[stage];
    const step = macroStep(macro, item, this.request, this.engine);
    let result = zero();
    if (step === 'SKIP') result = this.evaluate(item, stage + 1);
    else if (step !== 'INAPPLICABLE') {
      if (macro.kind === 'repeat' && macro.action.kind === 'havoc') {
        const indices = item.affixes.flatMap((row, index) => row.slot === 'ordinary' ? [index] : []);
        const layouts = tierPermutations(indices.map((index) => item.affixes[index].tier));
        const goals = layouts.map((tiers) => {
          const affixes = [...item.affixes];
          for (const [index, originalIndex] of indices.entries()) affixes[originalIndex] = { ...affixes[originalIndex], tier: tiers[index] };
          return { ...item, affixes };
        }).filter((candidate) => targetReached(candidate, this.request.target) || predicateReached(candidate, macro.until, this.request, this.engine));
        if (!goals.length) throw new Error('Non-terminating Havoc stage in research route');
        const distribution = this.engine.transition(item, 63, step.action, this.request.craftingContext, { constraints: this.request.constraints });
        if (distribution.issues.length) throw new Error(distribution.issues[0].message);
        const perAttempt = distribution.outcomes.reduce((sum, row) => sum + row.probability * (63 - row.fp), 0);
        const attempts = (layouts.length - 1) / goals.length;
        for (const goal of goals) accumulate(result, this.evaluate(goal, stage + 1), 1 / goals.length);
        const prefixFp = perAttempt * attempts;
        result.successFpMoment += prefixFp * result.success;
        result.fp += prefixFp; result.attempts += attempts;
      } else {
        if (step.action.kind === 'redemption') throw new Error('Use the independent compressed Redemption chain');
        const distribution = this.engine.transition(item, 63, step.action, this.request.craftingContext, { constraints: this.request.constraints });
        if (!distribution.issues.length) {
          result.attempts = 1;
          const grouped = new Map<string, { item: Item; abort: boolean; probability: number; fpMoment: number }>();
          for (const outcome of distribution.outcomes) {
            const nextKey = `${outcome.abort ?? '-'}|${itemKey(outcome.item)}`;
            const row = grouped.get(nextKey) ?? { item: outcome.item, abort: outcome.abort !== null, probability: 0, fpMoment: 0 };
            row.probability += outcome.probability; row.fpMoment += outcome.probability * (63 - outcome.fp); grouped.set(nextKey, row);
          }
          for (const row of grouped.values()) {
            const child = row.abort ? zero() : this.evaluate(row.item, step.advance ? stage + 1 : stage);
            result.success += row.probability * child.success;
            result.fp += row.fpMoment + row.probability * child.fp;
            result.successFpMoment += row.fpMoment * child.success + row.probability * child.successFpMoment;
            result.attempts += row.probability * child.attempts;
          }
        }
      }
    }
    this.cache.set(key, result); return result;
  }
}
const root = new URL('../', import.meta.url);
const final: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
const rows: (ReturnType<typeof summarize> & { fpType: FpType; case: string; route: Route })[] = [];
for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
  const base = exampleRequest('7710-direct');
  const request = { ...base, item: { ...base.item, fpType } };
  const junk = { side: 0 as const, excludedIds: [4, 5], minTier: 1, maxTier: 1 };
  const plain: Route = { id: '7710-direct-no-t1-guard', macros: [add(4), { kind: 'seal', selector: { ...junk, maxTier: 4 } }, add(5), final] };
  const guarded: Route = { id: '7710-prepare-t1-before-seal', macros: [add(4), { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' },
    until: { kind: 'exists', selector: junk } }, { kind: 'seal', selector: junk }, add(5), final] };
  for (const route of [plain, guarded]) rows.push({ fpType, case: route.id, route, ...summarize(new IntrinsicResearchEvaluator(request, route).evaluate()) });
  const missing: PlanRequest = { ...request, item: { ...request.item, affixes: [
    { id: 7, tier: 7, slot: 'ordinary', roll: null }, { id: 10, tier: 7, slot: 'ordinary', roll: null },
    { id: 2, tier: 3, slot: 'ordinary', roll: null }, { id: 26, tier: 2, slot: 'ordinary', roll: null },
  ] } };
  const removals: Route = { id: '7732-two-removals', macros: [
    { kind: 'removal', accepted: { ids: [2, 26] }, glyph: 'hope' }, { kind: 'removal', accepted: { ids: [2, 26] }, glyph: 'hope' }, add(4), add(5), final] };
  const sealRemoval: Route = { id: '7732-seal-t2-remove-t3', macros: [
    { kind: 'seal', selector: { ids: [26], minTier: 2, maxTier: 2 } }, { kind: 'removal', accepted: { ids: [2] }, glyph: 'hope' }, add(4), add(5), final] };
  for (const route of [removals, sealRemoval]) rows.push({ fpType, case: route.id, route, ...summarize(new IntrinsicResearchEvaluator(missing, route).evaluate()) });
}
interface RedemptionExit {
  probability: number; representativeT7Ids: number[]; castCountFirstMoment: number;
  fpFirstMomentIce: number; fpFirstMomentNormalAndBlood: number;
}
const redemption: { gloveFixture: Record<'atLeastOne' | 'targetA', { terminalOrderedWeightGroupDistribution: RedemptionExit[] }> } =
  JSON.parse(readFileSync(new URL('research/redemption-intrinsic.json', root), 'utf8'));
const hybridRows = [];
for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
  for (const mode of ['atLeastOne', 'targetA'] as const) {
    const joined = zero();
    const exits = redemption.gloveFixture[mode].terminalOrderedWeightGroupDistribution;
    for (const exit of exits) {
      const base = exampleRequest('7732-missing');
      const request: PlanRequest = { ...base, item: { ...base.item, fpType,
        affixes: base.item.affixes.map((affix, index) => index < 2 ? { ...affix, id: exit.representativeT7Ids[index] } : affix) } };
      const missing = [4, 5].filter((id) => !request.item.affixes.some((affix) => affix.id === id));
      if (missing.length > 1) throw new Error('Redemption stopping predicate was not satisfied');
      const junk = { side: 0 as const, excludedIds: [4, 5], minTier: 2, maxTier: 2 };
      const route: Route = { id: `rescue-one-then-seal-add-${missing[0] ?? 'complete'}`, macros: missing.length ? [
        { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector: junk } },
        { kind: 'seal', selector: junk }, add(missing[0]), final,
      ] : [] };
      const next = new IntrinsicResearchEvaluator(request, route).evaluate();
      const prefixMoment = fpType === 'ICE' ? exit.fpFirstMomentIce : exit.fpFirstMomentNormalAndBlood;
      joined.success += exit.probability * next.success;
      joined.fp += prefixMoment + exit.probability * next.fp;
      joined.successFpMoment += prefixMoment * next.success + exit.probability * next.successFpMoment;
      joined.attempts += exit.castCountFirstMoment + exit.probability * next.attempts;
    }
    hybridRows.push({ fpType, mode, ...summarize(joined),
      route: 'Complete each Redemption cast until the declared first-hit predicate. If both targets reached, stop. Otherwise move T2 onto the non-target prefix by Havoc, seal once, add the missing target, then final Havoc. Any seal failure aborts. Missing-ID branches are declared in advance; no optimization at execution time.' });
  }
}
const hash = (path: string) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex');
const thresholdDecision = (entry: { success: number; fpGivenSuccess: number | null }) => {
  const reasons = [...(entry.success < 0.15 ? ['OPERATION_SUCCESS_BELOW_15_PERCENT'] : []),
    ...(entry.fpGivenSuccess !== null && entry.fpGivenSuccess > 100 ? ['SUCCESS_PATH_MEAN_FP_ABOVE_100'] : [])];
  return { display: reasons.length ? '已放弃' : '保留', reasons };
};
const output = { schemaVersion: 1, modelId: MODEL_ID, date: '2026-11-03',
  rows: rows.map((row) => ({ ...row, thresholdDecision: thresholdDecision(row) })),
  hybridRows: hybridRows.map((row) => ({ ...row, thresholdDecision: thresholdDecision(row) })),
  analysisModel: 'INTRINSIC_OPERATION_SUCCESS_AND_SUCCESS_PATH_FP_V1',
  semantics: { success: 'OPERATION_SUCCESS_WITH_CONTINUOUSLY_SUFFICIENT_FP', fpThresholdMetric: 'EXPECTED_FP_GIVEN_FINAL_SUCCESS',
    minimumSuccess: 0.15, maximumExpectedSuccessFp: 100, equalityPasses: true,
    fpBoundaryPreservation: 'NOT_APPLICABLE_TO_THE_RESOURCE_DEMAND_METRIC; NO_STARTING_FP_BALANCE',
    ordinaryFpUpperBoundInActualGame: 63, shippedPlannerChanged: false },
  qualification: 'Research nominal arithmetic under the declared iid rule model; not a finite-budget completion probability, client measurement or global dominance proof. Havoc uses its changed-layout symmetry. Fixed one-shot actions preserve joint outcome and FP costs.',
  sourceHashes: Object.fromEntries(['src/generated/model.json', 'research/redemption-intrinsic.json', 'scripts/research_intrinsic_routes.ts'].map((path) => [path, hash(path)])) };
for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
  const find = (name: string) => rows.find((row) => row.fpType === fpType && row.case === name)!;
  const critical = fpType === 'BLOOD' ? 0.384 : 0.12;
  const check = (actual: number, expected: number) => { if (Math.abs(actual - expected) > 1e-10) throw new Error('Independent analytic check differs'); };
  check(find('7710-direct-no-t1-guard').success, 1 - critical * 0.5 * 0.31);
  check(find('7710-prepare-t1-before-seal').success, 1);
  check(find('7732-two-removals').success, 1 / 6);
  check(find('7732-seal-t2-remove-t3').success, 0.69 / 3);
  const scale = fpType === 'ICE' ? 0.7 : 1;
  const expectedDoubleRemovalFp = scale * (2 * 8.043515625 + 2 * (1 - critical) * 5.794411764705882 +
    6.436875 * (5 + critical - 0.75 * critical ** 2));
  check(find('7732-two-removals').fpGivenSuccess!, expectedDoubleRemovalFp);
}
const outputPath = new URL('research/intrinsic-route-examples.json', root);
if (process.argv.includes('--verify-only')) {
  const compare = (left: unknown, right: unknown): void => {
    if (typeof left === 'number' && typeof right === 'number') {
      if (!Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) > 1e-12 * Math.max(1, Math.abs(left), Math.abs(right))) throw new Error('Saved research number differs');
    } else if (left && right && typeof left === 'object' && typeof right === 'object') {
      if (JSON.stringify(Object.keys(left).sort()) !== JSON.stringify(Object.keys(right).sort())) throw new Error('Saved research fields differ');
      for (const [key, value] of Object.entries(left)) compare(value, Reflect.get(right, key));
    } else if (left !== right) throw new Error('Saved research field differs');
  };
  compare(output, JSON.parse(readFileSync(outputPath, 'utf8')));
} else writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(rows.map(({ route: _route, ...row }) => row)));
console.log(JSON.stringify(hybridRows));
export { IntrinsicResearchEvaluator, summarize };
