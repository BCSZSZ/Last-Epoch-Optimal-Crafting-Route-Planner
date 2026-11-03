import { Catalog, itemKey, ordinary } from './catalog';
import { requiredLevelAfterShard, requiredLevelWithAffix } from './levels';
import { assertUnitMass, boundedCostKernel, sum, tierPermutations } from './probability';
import { exact, Interval, ONE, ratio } from './interval';
import { validateItem } from './validation';
import type { Affix, AtomicAction, AtomicDistribution, AtomicOutcome, Constraints, CraftingContext, Issue, Item } from './types';

interface Variant {
  readonly probability: number;
  readonly weight: Interval;
  readonly item: Item;
  readonly sealed: boolean;
  readonly abort: AtomicOutcome['abort'];
  readonly critical: boolean;
  readonly removedId?: number;
}

export interface TransitionOptions {
  readonly constraints?: Constraints;
  /** Expand byte draws only when roll predicates/protection require their values. */
  readonly trackRolls?: boolean;
  readonly maxOutcomes?: number;
}

export class OutcomeLimitError extends Error {
  constructor(readonly limit: number) { super(`原子分布超过${limit}个结果；计算未完成`); }
}

function replace(item: Item, index: number, affix: Affix): Item {
  return { ...item, affixes: item.affixes.map((row, i) => i === index ? affix : row) };
}

function variant(item: Item, weight = ONE): Variant {
  return { item, weight, probability: weight.midpoint, sealed: false, critical: false, abort: null };
}

function scaled(state: Variant, weight: Interval): Variant {
  const result = state.weight.mul(weight);
  return { ...state, weight: result, probability: result.midpoint };
}

function rollVariants(item: Item, index: number, trackRolls: boolean): Variant[] {
  if (!trackRolls) return [variant(replace(item, index, { ...item.affixes[index], roll: null }))];
  return Array.from({ length: 256 }, (_, roll) => variant(replace(item, index, { ...item.affixes[index], roll }), exact(1 / 256)));
}

function protectionViolated(before: Item, after: Item, constraints: Constraints): boolean {
  return constraints.protected?.some((rule) => {
    const previous = before.affixes.find((row) => row.id === rule.id);
    const current = after.affixes.find((row) => row.id === rule.id);
    return (rule.identity && !current) ||
      (rule.minTier !== undefined && (!current || current.tier < rule.minTier)) ||
      (rule.roll && (!current || previous?.roll !== current.roll));
  }) ?? false;
}

/** Complete action settlement lives here; callers never combine an average cost with a separate state change. */
export class RuleEngine {
  readonly catalog: Catalog;
  readonly #costCache = new Map<string, ReturnType<typeof boundedCostKernel>>();

  constructor(catalog = new Catalog()) { this.catalog = catalog; }

  sealChance(item: Item, id: number): number {
    const affix = item.affixes.find((row) => row.id === id && row.slot === 'ordinary');
    if (!affix || affix.tier < 1 || affix.tier > 4) return 0;
    // Native hasExalted scans ALL entries, including sealed affixes.
    const exalted = item.affixes.some((row) => row.tier >= 6);
    return this.#sealWeight(item, affix.tier, exalted).midpoint;
  }

  #sealWeight(item: Item, tier: number, exalted = item.affixes.some((row) => row.tier >= 6)): Interval {
    const raw = exact(0.6).add(exact(0.15).mul(exact(ordinary(item).length))).add(exact(0.3).mul(exact(Number(exalted))))
      .mul(exact(this.catalog.model.parameters.sealMultipliers[tier - 1]));
    return new Interval(Math.min(1, raw.lower), Math.min(1, raw.upper));
  }

  eligibility(item: Item, fp: number, action: AtomicAction, context: CraftingContext, constraints: Constraints = {}): Issue[] {
    const issues = validateItem(item, context, this.catalog);
    const fail = (code: string, message: string) => issues.push({ code, message });
    if (issues.length) return issues;
    if (item.corrupted || this.catalog.base(item.baseId).corrupted) fail('CORRUPTED_ITEM', '已腐化装备不能继续制作');
    if (!Number.isInteger(fp) || fp < 1 || fp > this.catalog.model.fpMaximum) fail('FP_EXHAUSTED', '制作前必须有1至63点潜能');
    if (constraints.allowedActions && !constraints.allowedActions.includes(action.kind)) fail('ACTION_DISABLED', '该动作已被限制禁用');
    const unsealed = ordinary(item);
    if ('id' in action) {
      if (!this.catalog.hasAffix(action.id)) { fail('UNKNOWN_AFFIX', '找不到指定词缀'); return issues; }
      const definition = this.catalog.affix(action.id);
      const existing = item.affixes.find((row) => row.id === action.id);
      if (!this.catalog.hasShard(action.id)) fail('NO_AFFIX_SHARD', '该词缀没有可使用的普通碎片');
      if (!this.catalog.canForgeOn(action.id, item.baseId, existing !== undefined)) fail('INCOMPATIBLE_AFFIX', '词缀不符合底材或职业制作资格');
      if (action.kind === 'add') {
        if (existing) fail('DUPLICATE_ID', '装备已有该ID，不能重复添加');
        if (definition.special !== 0 || definition.side > 1) fail('UNSUPPORTED_ADDITION', '普通添加仅生成合法普通前后缀');
        if (unsealed.length >= 4 || unsealed.filter((row) => this.catalog.side(row.id) === definition.side).length >= 2) fail('NO_LEGAL_SLOT', '该侧没有空普通栏');
      } else {
        if (!existing || existing.slot !== 'ordinary') fail('NO_ORDINARY_TARGET', '需指定已有普通未封印栏');
        else if (existing.tier >= 5) fail('MAX_CRAFTABLE_TIER', '普通碎片不能将T5及以上继续升阶');
      }
      if (action.kind === 'seal' && item.affixes.some((row) => row.slot === 'sealed')) fail('SEALED_SLOT_OCCUPIED', '普通封印槽已占用');
      if (requiredLevelAfterShard(item, action.id, this.catalog) > context.playerLevel) fail('PLAYER_LEVEL_TOO_LOW', '角色等级不足以执行这次碎片制作');
      if (action.kind === 'chaos' && existing && this.catalog.rerollPool(item, this.catalog.side(existing.id)).length === 0) fail('EMPTY_REROLL_POOL', '没有合法的新词缀候选');
    } else if (action.kind === 'havoc') {
      if (unsealed.length !== 4 || !item.affixes.some((row) => row.tier >= 6)) fail('HAVOC_INAPPLICABLE', '浩劫要求崇高装备及四条普通未封印词缀');
      if (new Set(unsealed.map((row) => row.tier)).size < 2) fail('IDENTICAL_TIERS', '所有普通词缀阶数相同，无法重排');
    } else if (action.kind === 'redemption') {
      if (!unsealed.some((row) => row.tier >= 6)) fail('NO_EXALTED_TARGET', '救赎需要至少一个未封印崇高词缀');
    } else if (action.kind === 'removal') {
      if (!unsealed.some((row) => this.catalog.affix(row.id).special === 0)) fail('NO_REMOVABLE_AFFIX', '没有可剥离的普通未封印词缀');
    }
    return issues;
  }

  transition(item: Item, fp: number, action: AtomicAction, context: CraftingContext, options: TransitionOptions = {}): AtomicDistribution {
    const constraints = options.constraints ?? {};
    const issues = this.eligibility(item, fp, action, context, constraints);
    const empty = (errors: readonly Issue[]): AtomicDistribution => ({ outcomes: [], issues: errors, probabilityMass: 0, evaluation: 'OUTWARD_ROUNDED_UNDER_DECLARED_MODEL' });
    if (issues.length) return empty(issues);
    const maximum = options.maxOutcomes ?? 200000;
    const trackRolls = options.trackRolls || constraints.protected?.some((row) => row.roll) || false;
    const primary = 'id' in action ? action.id : undefined;
    const index = primary === undefined ? -1 : item.affixes.findIndex((row) => row.id === primary);
    const states = this.#operation(item, action, index, trackRolls, maximum);
    const eligibleForCritical = action.kind === 'add' || action.kind === 'upgrade' || action.kind === 'seal';
    const p = this.catalog.model.parameters;
    const criticalChance = item.fpType === 'BLOOD' ? exact(p.critical).add(exact(p.critical).complement().mul(exact(p.blood))) : exact(p.critical);
    const variants: Variant[] = [];
    for (const state of states) {
      const chance = eligibleForCritical && !state.sealed ? criticalChance : exact(0);
      variants.push(scaled(state, chance.complement()));
      if (chance.upper > 0 && primary !== undefined) {
        const preservePrimary = action.kind === 'upgrade' && action.glyph === 'order';
        for (const extra of this.#extraTier(state.item, primary, preservePrimary, context, trackRolls)) {
          variants.push({ ...scaled(state, chance.mul(extra.weight)), item: extra.item, critical: true });
        }
      }
      if (variants.length > maximum) throw new OutcomeLimitError(maximum);
    }
    // Reject a risky action as a whole; never renormalize away a protection-violating branch.
    if (variants.some((row) => row.probability > 0 && protectionViolated(item, row.item, constraints))) {
      return empty([{ code: 'PROTECTION_RISK', message: '该动作可能违反明确设置的全程保护条件' }]);
    }
    const upper = action.kind === 'havoc' || action.kind === 'redemption' ? 20 : action.kind === 'removal' ? 25 :
      action.kind === 'add' ? (ordinary(item).length === 0 ? 10 : ordinary(item).length === 1 ? 14 : 18) :
      [0, 10, 12, 18, 24][item.affixes[index].tier];
    const hope = 'glyph' in action && action.glyph === 'hope';
    const cacheKey = `${fp}:${upper}:${item.fpType}:${Number(hope)}`;
    let cost = this.#costCache.get(cacheKey);
    if (!cost) { cost = boundedCostKernel(fp, upper, item.fpType, hope, p); this.#costCache.set(cacheKey, cost); }
    const outcomes = new Map<string, AtomicOutcome>();
    for (const state of variants) {
      if (state.probability === 0) continue;
      const stateKey = `${itemKey(state.item)}|${state.critical}|${state.sealed}|${state.abort}|${state.removedId ?? '-'}`;
      for (const remaining of state.critical ? [{ value: fp, probability: 1, bounds: ONE }] : cost) {
        const key = `${stateKey}|${remaining.value}`;
        const weight = state.weight.mul(remaining.bounds);
        const previous = outcomes.get(key);
        const bounds = previous ? weight.add(new Interval(previous.probabilityBounds.lower, previous.probabilityBounds.upper)) : weight;
        const { weight: _weight, ...details } = state;
        outcomes.set(key, { ...details, fp: remaining.value, probability: bounds.midpoint, probabilityBounds: bounds.report() });
        if (outcomes.size > maximum) throw new OutcomeLimitError(maximum);
      }
    }
    const result = [...outcomes.values()];
    const mass = assertUnitMass(result.map((row) => row.probability));
    return { outcomes: result, issues: [], probabilityMass: mass, evaluation: 'OUTWARD_ROUNDED_UNDER_DECLARED_MODEL' };
  }

  #operation(item: Item, action: AtomicAction, index: number, trackRolls: boolean, maximum: number): Variant[] {
    if (action.kind === 'add') {
      const added = { ...item, affixes: [...item.affixes, { id: action.id, tier: 1, slot: 'ordinary' as const, roll: null }] };
      return rollVariants(added, added.affixes.length - 1, trackRolls);
    }
    if (action.kind === 'upgrade' || action.kind === 'chaos') {
      const upgraded = replace(item, index, { ...item.affixes[index], tier: item.affixes[index].tier + 1 });
      const rolled = action.kind === 'upgrade' && action.glyph === 'order' ? [variant(upgraded)] : rollVariants(upgraded, index, trackRolls);
      return action.kind === 'chaos' ? this.#reroll(rolled, index, maximum) : rolled;
    }
    if (action.kind === 'seal') {
      const chance = this.#sealWeight(item, item.affixes[index].tier);
      const original = item.affixes[index];
      const sealed: Item = { ...item, affixes: [{ ...original, slot: 'sealed' }, ...item.affixes.filter((_, i) => i !== index)] };
      const output: Variant[] = [{ ...variant(sealed, chance), sealed: true }];
      if (chance.lower < 1) {
        const failed = replace(item, index, { ...original, tier: original.tier + 1 });
        output.push(...rollVariants(failed, index, trackRolls).map((row) => ({ ...scaled(row, chance.complement()), abort: 'REQUIRED_SEAL_FAILED' as const })));
      }
      return output;
    }
    if (action.kind === 'havoc') {
      const indices = item.affixes.flatMap((row, i) => row.slot === 'ordinary' ? [i] : []);
      const tiers = indices.map((i) => item.affixes[i].tier);
      const changed = tierPermutations(tiers).filter((layout) => layout.some((tier, i) => tier !== tiers[i]));
      return changed.map((layout) => {
        const byIndex = new Map(indices.map((i, j) => [i, layout[j]]));
        return variant({ ...item, affixes: item.affixes.map((row, i) => byIndex.has(i) ? { ...row, tier: byIndex.get(i)! } : row) }, ratio(1, changed.length));
      });
    }
    if (action.kind === 'redemption') {
      const indices = item.affixes.flatMap((row, i) => row.slot === 'ordinary' && row.tier >= 6 ? [i] : []);
      let states = [variant(item)];
      for (const i of indices) states = this.#reroll(states, i, maximum);
      return states;
    }
    if (action.kind !== 'removal') throw new Error('未知原子动作');
    const candidates = item.affixes.flatMap((row, i) => row.slot === 'ordinary' && this.catalog.affix(row.id).special === 0 ? [i] : []);
    return candidates.map((i) => ({ ...variant({ ...item, affixes: item.affixes.filter((_, j) => i !== j) }, ratio(1, candidates.length)),
      removedId: item.affixes[i].id, abort: action.acceptedIds.includes(item.affixes[i].id) ? null : 'UNACCEPTED_REMOVAL' }));
  }

  #reroll(states: readonly Variant[], index: number, maximum: number): Variant[] {
    const results: Variant[] = [];
    for (const state of states) {
      const pool = this.catalog.rerollPool(state.item, this.catalog.side(state.item.affixes[index].id));
      if (!pool.length) throw new Error('原生候选池为空，尚未覆盖该特殊输入');
      for (const entry of pool) {
        results.push({ ...scaled(state, entry.bounds),
          item: replace(state.item, index, { ...state.item.affixes[index], id: entry.id }) });
        if (results.length > maximum) throw new OutcomeLimitError(maximum);
      }
    }
    return results;
  }

  #extraTier(item: Item, primary: number, preservePrimary: boolean, context: CraftingContext, trackRolls: boolean): Variant[] {
    const eligible = item.affixes.flatMap((row, i) => row.slot === 'ordinary' && row.tier < 5 ? [i] : []);
    if (!eligible.length) return [variant(item)];
    const primaryIndex = eligible.find((i) => item.affixes[i].id === primary);
    const choices: { index: number; weight: Interval; preserve: boolean }[] = [];
    if (primaryIndex === undefined) {
      choices.push(...eligible.map((index) => ({ index, weight: ratio(1, eligible.length), preserve: false })));
    } else {
      // First 50% leaves primary in the fallback pool: all of that path rerolls.
      choices.push(...eligible.map((index) => ({ index, weight: ratio(0.5, eligible.length), preserve: false })));
      const others = eligible.filter((i) => i !== primaryIndex);
      choices.push({ index: primaryIndex, weight: exact(others.length ? 0.25 : 0.5), preserve: preservePrimary });
      choices.push(...others.map((index) => ({ index, weight: ratio(0.25, others.length), preserve: false })));
    }
    const output: Variant[] = [];
    for (const choice of choices) {
      const original = item.affixes[choice.index];
      // Selection precedes the level test; a blocked selection is not replaced by another slot.
      if (requiredLevelWithAffix(item, original.id, original.tier + 1, this.catalog) > context.playerLevel) {
        output.push(variant(item, choice.weight));
        continue;
      }
      const upgraded = replace(item, choice.index, { ...original, tier: original.tier + 1 });
      const rolled = choice.preserve ? [variant(upgraded)] : rollVariants(upgraded, choice.index, trackRolls);
      output.push(...rolled.map((row) => scaled(row, choice.weight)));
    }
    if (Math.abs(sum(output.map((row) => row.probability)) - 1) > 1e-12) throw new Error('额外升阶概率质量错误');
    return output;
  }
}
