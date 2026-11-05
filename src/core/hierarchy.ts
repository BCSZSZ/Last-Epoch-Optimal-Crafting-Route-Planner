import { ordinary } from './catalog';
import { allowedMacro, routeId, routeKey } from './candidates';
import { macroStep, predicateReached } from './evaluation';
import { RuleEngine } from './rules';
import { tierPermutations } from './probability';
import { matches, targetReached } from './target';
import { exact } from './interval';
import type { Item, Macro, PlanRequest, Predicate, Route, Selector } from './types';

export type StructureClass = '220' | '211' | '202' | '210' | '201' | '200';
export type TemplateFamily = 'DONE' | 'FINISH' | 'DIRECT' | 'SEAL' | 'PREPARE_SEAL' | 'REMOVE' | 'PREPARE_REMOVE' |
  'INTERLEAVED_ACQUIRE' | 'INTERLEAVED_MIN_SEAL' | 'CHAOS' | 'PREPARE_CHAOS' | 'REDEMPTION' | 'REDEMPTION_SINGLE_CAST' | 'REDEMPTION_ANY_THEN_ACQUIRE' | 'REDEMPTION_PROTECTED_SECOND';
export interface UpperNode {
  readonly key: string;
  readonly group: StructureClass;
  readonly ordinaryCount: number;
  readonly sealedCount: 0 | 1;
  readonly terminal: boolean;
  readonly routeNode: string;
  readonly families: readonly TemplateFamily[];
}
const occupations: Readonly<Record<StructureClass, readonly number[]>> = {
  '220': [2, 3, 4], '211': [3, 4], '202': [4], '210': [2, 3, 4], '201': [3, 4], '200': [2, 3, 4],
};
export const UPPER_NODES: readonly UpperNode[] = Object.entries(occupations).flatMap(([group, counts]) => counts.flatMap((n) =>
  ([0, 1] as const).map((s): UpperNode => ({ key: `${group}-N${n}-S${s}`, group: group as StructureClass,
    ordinaryCount: n, sealedCount: s, terminal: group === '220', routeNode: group === '220' ? 'DONE' : `${group}-N${n}-S${s}`,
    families: group === '220' ? ['DONE'] : ['211', '202'].includes(group) ? ['FINISH'] : [
      'DIRECT', ...(s ? [] : ['SEAL', 'PREPARE_SEAL', 'INTERLEAVED_ACQUIRE', 'INTERLEAVED_MIN_SEAL'] as const), 'REMOVE', 'PREPARE_REMOVE', 'CHAOS', 'PREPARE_CHAOS',
      'REDEMPTION', 'REDEMPTION_SINGLE_CAST', 'REDEMPTION_ANY_THEN_ACQUIRE', 'REDEMPTION_PROTECTED_SECOND'],
  }))));

export interface Structure {
  readonly node: UpperNode;
  readonly targetIds: readonly [number, number];
  readonly targetSides: readonly number[];
  readonly presentMask: number;
  readonly emptyBySide: readonly number[];
  readonly sealedIds: readonly number[];
  readonly ordinary: readonly { id: number; tier: number; side: number; special: number; nativeIndex: number; target: boolean }[];
  readonly refinements: readonly string[];
}

/** Scope is explicit: two distinct Standard ordinary T7 goals, exactly two ordinary T7 sources, no roll goals. */
export function classifyStructure(request: PlanRequest, engine: RuleEngine, item: Item = request.item): Structure | null {
  const required = request.target.requirements.filter((row) => !row.optional);
  if (required.length !== 2 || required.some((row) => row.ids.length !== 1 || row.slot !== 'ordinary' || row.minTier !== 7 ||
    (row.maxTier !== undefined && row.maxTier !== 7) || row.minRollByte !== undefined || engine.catalog.affix(row.ids[0]).special !== 0)) return null;
  const ids: [number, number] = [required[0].ids[0], required[1].ids[0]];
  if (ids[0] === ids[1] || ordinary(item).filter((row) => row.tier === 7).length !== 2) return null;
  const rows = item.affixes.flatMap((row, nativeIndex) => row.slot === 'ordinary' ? [{ id: row.id, tier: row.tier,
    side: engine.catalog.side(row.id), special: engine.catalog.affix(row.id).special, nativeIndex, target: ids.includes(row.id) }] : []);
  const correct7 = rows.filter((row) => row.target && row.tier === 7).length;
  const correctLow = rows.filter((row) => row.target && row.tier !== 7).length;
  const key = `2${correct7}${correctLow}-N${rows.length}-S${Number(item.affixes.some((row) => row.slot === 'sealed'))}`;
  const node = UPPER_NODES.find((row) => row.key === key);
  if (!node) return null;
  return { node, targetIds: ids, targetSides: ids.map((id) => engine.catalog.side(id)),
    presentMask: ids.reduce((mask, id, index) => mask | (rows.some((row) => row.id === id) ? 1 << index : 0), 0),
    emptyBySide: [0, 1].map((side) => 2 - rows.filter((row) => row.side === side).length),
    sealedIds: item.affixes.filter((row) => row.slot === 'sealed').map((row) => row.id), ordinary: rows,
    refinements: ['EMPTY_PREFIX_SUFFIX', 'TARGET_IDENTITY_AND_TIER', 'GARBAGE_TIER_AND_ELIGIBILITY', 'NATIVE_ORDER',
      'SEALED_AND_EXTRA_ID_EXCLUSIONS', 'T6_REDEMPTION_PARTICIPATION', 'BASE_LEVEL_PROTECTION_ACTIONS'],
  };
}

export interface StrategyTemplate extends Route { readonly family: TemplateFamily; readonly upperNode: string }
export interface TemplateCompilation {
  readonly structure: Structure;
  readonly templates: readonly StrategyTemplate[];
  readonly rejected: readonly { templateId: string; reason: string; probabilityUpperBound?: number }[];
  readonly grammar: 'HIERARCHICAL_FIXED_TEMPLATES_V2';
}
export function macroStages(macros: readonly Macro[]): number {
  return macros.reduce((sum, macro) => sum + (macro.kind === 'conditional' ? Math.max(macroStages(macro.then), macroStages(macro.otherwise ?? [])) : 1), 0);
}
const identity = (id: number, maxTier = 8): Predicate => ({ kind: 'identity', requirement: { ids: [id], minTier: 1, maxTier, slot: 'ordinary' } });

/** A finite, reviewable controller grammar; no Cartesian permutation of an atomic-action library. */
export function compileTemplates(request: PlanRequest, engine: RuleEngine): TemplateCompilation | null {
  const structure = classifyStructure(request, engine);
  if (!structure) return null;
  const templates: StrategyTemplate[] = [];
  const rejected: { templateId: string; reason: string; probabilityUpperBound?: number }[] = [];
  const seen = new Set<string>();
  const ids = structure.targetIds;
  const excluded = [...ids, ...(request.constraints.protected?.map((row) => row.id) ?? [])];
  // This ordered filler policy is part of the declared template scope, not an ID-equivalence claim.
  const fillers = engine.catalog.model.affixes.filter((row) => row.special === 0 && row.side < 2 && !ids.includes(row.id) &&
    engine.catalog.hasShard(row.id) && engine.catalog.canRollOn(row.id, request.item.baseId)).map((row) => row.id).sort((a, b) => a - b);
  const fill: Macro = { kind: 'fill', ids: fillers, glyph: 'hope' };
  const finish: Macro[] = [fill, { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } }];
  const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
  const prepare = (selector: Selector): Macro => ({ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector } });
  const allIds = (values: readonly number[]): Predicate => ({ kind: 'all', predicates: values.map((id) => identity(id)) });
  const t4Cap = exact(0.6).add(exact(0.15).mul(exact(4))).add(exact(0.3))
    .mul(exact(engine.catalog.model.parameters.sealMultipliers[3])).clamp(0, 1);
  const append = (macros: readonly Macro[], family: TemplateFamily, description: string, probabilityUpperBound?: number) => {
    const id = routeId(macros), key = routeKey({ id, macros });
    if (seen.has(key)) return;
    seen.add(key);
    if (macroStages(macros) > request.search.macroStages) { rejected.push({ templateId: id, reason: 'DECLARED_MACRO_STAGE_SCOPE' }); return; }
    if (macros.some((macro) => !allowedMacro(macro, request))) { rejected.push({ templateId: id, reason: 'ACTION_DISABLED' }); return; }
    if (probabilityUpperBound !== undefined && probabilityUpperBound < 0.15) {
      rejected.push({ templateId: id, reason: 'CERTIFIED_SUCCESS_BELOW_15_PERCENT', probabilityUpperBound }); return;
    }
    // Only prove a first-step rejection on the actual entry. Never extrapolate it past a random preparation.
    const initial = firstAction(macros, request.item, request, engine);
    if (initial === 'INAPPLICABLE') { rejected.push({ templateId: id, reason: 'PROVEN_INAPPLICABLE_FIRST_STEP' }); return; }
    templates.push({ id, macros, family, upperNode: structure.node.routeNode, description });
  };
  if (structure.node.terminal) append([], 'DONE', '两个目标已经各为T7，无需制作');
  else if (structure.presentMask === 3) append(finish, 'FINISH', '身份齐全：必要时补满普通栏，再浩劫收尾');
  else {
    interface Method { family: TemplateFamily; name: string; build: (id: number, desired: readonly number[]) => readonly Macro[] }
    const methods: Method[] = [{ family: 'DIRECT', name: '直接添加', build: (id) => [add(id)] }];
    for (let tier = 1; tier <= 4; tier++) {
      if (structure.node.sealedCount === 0) {
        for (const preparation of [false, true]) methods.push({ family: preparation ? 'PREPARE_SEAL' : 'SEAL', name: `${preparation ? '补栏浩劫准备后' : ''}封T${tier}`,
          build: (id) => {
            const selector: Selector = { side: engine.catalog.side(id) as 0 | 1, excludedIds: excluded, minTier: tier, maxTier: tier, sealable: true };
            return [...(preparation ? [fill, prepare(selector)] : []), { kind: 'seal', selector }, add(id)];
          } });
      }
    }
    // A first-hit set is a different fixed controller from waiting for one tier.
    // Accepting T1 OR T2 can save enough preparation FP to pass the practical limit.
    if (structure.node.sealedCount === 0) for (const maximum of [2, 3, 4]) {
      methods.push({ family: 'PREPARE_SEAL', name: `补栏浩劫准备后封T1至T${maximum}`,
        build: (id) => {
          const selector: Selector = { side: engine.catalog.side(id) as 0 | 1, excludedIds: excluded,
            minTier: 1, maxTier: maximum, sealable: true };
          return [fill, prepare(selector), { kind: 'seal', selector }, add(id)];
        } });
    }
    for (const preparation of [false, true]) methods.push({ family: preparation ? 'PREPARE_REMOVE' : 'REMOVE', name: `${preparation ? '补栏浩劫准备后' : ''}剥离垃圾`,
      build: (id) => { const accepted: Selector = { side: engine.catalog.side(id) as 0 | 1, excludedIds: excluded, minTier: 1, maxTier: 6, eligibleAction: 'removal' };
        return [...(preparation ? [fill, prepare(accepted)] : []), { kind: 'removal', accepted, glyph: 'hope' }, add(id)]; } });
    for (const preparation of [false, true]) methods.push({ family: preparation ? 'PREPARE_CHAOS' : 'CHAOS', name: `${preparation ? '补栏浩劫准备后' : ''}混沌窗口`,
      build: (id) => { const selector: Selector = { side: engine.catalog.side(id) as 0 | 1, excludedIds: excluded, minTier: 1, maxTier: 4, eligibleAction: 'chaos' };
        return [...(preparation ? [fill, prepare(selector)] : []), { kind: 'chaos', selector, until: { ids: [id], minTier: 1, maxTier: 5, slot: 'ordinary' } }]; } });
    methods.push({ family: 'REDEMPTION', name: '救赎至所需身份齐全', build: (_id, desired) => [
      { kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: allIds(desired) }] });
    // Exhaustion of a Chaos window is a policy decision, not native destruction. These fallbacks are explicit.
    const fallbackMethods = methods.filter((method) => method.family === 'PREPARE_SEAL' || method.family === 'PREPARE_REMOVE' || method.family === 'REDEMPTION');
    methods.push({ family: 'PREPARE_CHAOS', name: '浩劫恢复剩余低阶混沌窗口', build: (id) => [fill,
      { kind: 'chaos', selector: { side: engine.catalog.side(id) as 0 | 1, excludedIds: excluded, minTier: 1, maxTier: 4, eligibleAction: 'chaos' },
        until: { ids: [id], minTier: 1, maxTier: 5, slot: 'ordinary' }, prepareWithHavoc: true }] });
    const acquire = (id: number, method: Method, desired: readonly number[]): Macro => ({ kind: 'conditional', when: identity(id), then: [], otherwise: method.build(id, desired) });
    const owned = ids.filter((id) => ordinary(request.item).some((row) => row.id === id));
    const missing = ids.filter((id) => !owned.includes(id));
    const orders = missing.length === 2 ? [missing, [...missing].reverse()] : [missing];
    if (missing.length === 2) {
      const garbage: Selector = { excludedIds: excluded, minTier: 1, maxTier: 6, eligibleAction: 'removal' };
      const remove: Macro = { kind: 'removal', accepted: garbage, glyph: 'hope' };
      const requiredSides: Predicate[] = ([0, 1] as const).flatMap((side) => {
        const count = ids.filter((id) => engine.catalog.side(id) === side).length;
        return count ? [{ kind: 'count', selector: { ...garbage, side }, minimum: count }] : [];
      });
      const reposition: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'all', predicates: requiredSides } };
      for (const order of orders) for (const prepared of [false, true]) {
        const before = prepared ? [fill, reposition] : [];
        append([...before, remove, remove, ...order.map(add), ...finish], 'REMOVE', '先连续剥离两个垃圾位置，再补A/B并收尾');
        if (!structure.node.sealedCount && (prepared || structure.node.ordinaryCount === 4)) {
          const [a, b] = order, sameSide = engine.catalog.side(a) === engine.catalog.side(b);
          const accepted: Selector = sameSide ? { ...garbage, side: engine.catalog.side(a) as 0 | 1 } : garbage;
          // Accept either useful vacancy. The branch is declared BEFORE rolling, not optimized after the result.
          for (const sealTier of [0, null, 1, 2, 3, 4] as const) {
            const complete = (first: number, last: number): readonly Macro[] => {
              if (sealTier === 0) {
                const sealAt = (tier: number): readonly Macro[] => {
                  const selector: Selector = { excludedIds: excluded, side: engine.catalog.side(last) as 0 | 1, minTier: tier, maxTier: tier, sealable: true };
                  return [prepare(selector), { kind: 'seal', selector }];
                };
                // A newly added T1 can rise only to T2. Choose the lowest available tier by a fixed, exhaustive branch.
                return [add(first), { kind: 'conditional', when: { kind: 'exists', selector: { minTier: 1, maxTier: 1 } },
                  then: sealAt(1), otherwise: sealAt(2) }, add(last)];
              }
              const selector: Selector = { excludedIds: excluded, side: engine.catalog.side(last) as 0 | 1,
                minTier: sealTier ?? 1, maxTier: sealTier ?? 4, sealable: true };
              return [add(first), ...(sealTier === null ? [] : [prepare(selector)]), { kind: 'seal', selector }, add(last)];
            };
            const after: readonly Macro[] = sameSide ? complete(a, b) : [{ kind: 'conditional',
              when: { kind: 'count', selector: { side: engine.catalog.side(a) as 0 | 1 }, minimum: 2 },
              then: complete(b, a), otherwise: complete(a, b) }];
            const directHighTier = sealTier === null && structure.node.ordinaryCount === 4 && structure.ordinary.every((row) => row.special === 0) &&
              structure.ordinary.filter((row) => row.tier !== 7).every((row) => row.tier >= 4);
            append([...before, { kind: 'removal', accepted, glyph: 'hope' }, ...after, ...finish], sealTier === 0 ? 'INTERLEAVED_MIN_SEAL' : 'INTERLEAVED_ACQUIRE',
              `剥离 → 按空槽补目标 → ${sealTier === 0 ? '固定T1／T2分支准备最低阶封印' : sealTier === null ? '直接封印剩余垃圾' : `浩劫准备T${sealTier}再封印`} → 补另一目标 → 收尾`,
              directHighTier ? t4Cap.mul(exact(0.5)).upper : undefined);
          }
        }
        if (!structure.node.sealedCount) for (let tier = 1; tier <= 4; tier++) {
          const seal: Macro = { kind: 'seal', selector: { excludedIds: excluded, minTier: tier, maxTier: tier, sealable: true } };
          const sealFirst = [...before, seal, remove, ...order.map(add), ...finish];
          const removalFirst = [...before, remove, seal, ...order.map(add), ...finish];
          if (tier === 4 && structure.ordinary.every((row) => row.special === 0) && (prepared || structure.node.ordinaryCount === 4)) {
            // Two T7s + two Standard garbage slots: seal→remove <= .15/3; remove→seal <= (2/4)*.15.
            // This is a probability threshold certificate, NOT a universal seal-vs-removal dominance claim.
            for (const [macros, bound] of [[sealFirst, t4Cap.div(exact(3)).upper], [removalFirst, t4Cap.mul(exact(0.5)).upper]] as const) {
              if (bound < 0.15) rejected.push({ templateId: routeId(macros), reason: 'CERTIFIED_SUCCESS_BELOW_15_PERCENT', probabilityUpperBound: bound });
              else append(macros, 'SEAL', 'T4封印与剥离开位后补A/B');
            }
          } else {
            append(sealFirst, 'SEAL', `先封T${tier}再剥离，开两个位置后补A/B`);
            append(removalFirst, 'SEAL', `先剥离再封T${tier}，开两个位置后补A/B`);
          }
        }
      }
    }
    // Fallback suffixes are composed separately to keep the two-identity product small and reviewable.
    for (const id of missing) for (const fallback of fallbackMethods) {
      const chaos: Macro = { kind: 'chaos', selector: { side: engine.catalog.side(id) as 0 | 1, excludedIds: excluded,
        minTier: 1, maxTier: 4, eligibleAction: 'chaos' }, until: { ids: [id], minTier: 1, maxTier: 5, slot: 'ordinary' }, onExhausted: 'CONTINUE', prepareWithHavoc: true };
      const suffix = [acquire(id, fallback, [...owned, id]), ...missing.filter((other) => other !== id).map((other) => acquire(other, fallback, ids)), ...finish];
      append([fill, chaos, ...suffix], 'PREPARE_CHAOS', `混沌窗口耗尽后按既定${fallback.name}补救，再取得剩余身份`);
    }
    // Product is over PURPOSED acquisition methods for at most two missing IDs, not arbitrary macro sequences.
    for (const order of orders) {
      if (order.length === 1) for (const method of methods) append([acquire(order[0], method, ids), ...finish], method.family, `${method.name}补齐缺失目标，再收尾`);
      else {
        // Put cheap/common complete methods first so a finite execution budget does useful work.
        for (const second of methods) for (const first of methods) {
          // Neither method can create the OTHER ID. Both missing IDs would therefore require two successful ordinary seals.
          if (['SEAL', 'PREPARE_SEAL'].includes(first.family) && ['SEAL', 'PREPARE_SEAL'].includes(second.family)) {
            rejected.push({ templateId: `two-required-seals-${order.join('-')}-${first.name}-${second.name}`, reason: 'TWO_UNAVOIDABLE_ORDINARY_SEALS' }); continue;
          }
          append([acquire(order[0], first, [order[0]]), acquire(order[1], second, ids), ...finish], second.family,
            `${first.name}取得#${order[0]} → ${second.name}取得#${order[1]} → 收尾`);
        }
      }
    }
    // A first-hit ANY predicate and its predeclared missing-ID branches preserve the useful hybrid family.
    for (const method of methods) append([
      { kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'any', predicates: ids.map((id) => identity(id)) } },
      { kind: 'conditional', when: identity(ids[0]), then: [acquire(ids[1], method, ids)], otherwise: [acquire(ids[0], method, ids)] }, ...finish,
    ], 'REDEMPTION_ANY_THEN_ACQUIRE', `救赎首次命中任一目标 → 按既定分支${method.name}补另一目标 → 收尾`);
    for (const [a, b] of [ids, [...ids].reverse()]) append([
      { kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: identity(a) }, fill,
      { kind: 'conditional', when: identity(b), then: [], otherwise: [
        { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'all', predicates: [identity(a, 5),
          { kind: 'exists', selector: { side: engine.catalog.side(b) as 0 | 1, excludedIds: excluded, minTier: 6 } }] } },
        { kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: allIds(ids) },
      ] }, ...finish,
    ], 'REDEMPTION_PROTECTED_SECOND', '先救赎取得一个身份，浩劫降至T5以下，再救赎取得另一个并收尾');
    // Direct repeat-to-both is distinct from a one-cast, double-hit-or-NG gamble.
    append([{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: allIds(ids) }, ...finish], 'REDEMPTION', '重复救赎至两个目标身份齐全，再收尾');
    append([{ kind: 'once', action: { kind: 'redemption', glyph: 'hope' } }, ...finish], 'REDEMPTION_SINGLE_CAST', '只救赎一发，身份仍缺即放弃该模板；身份齐全则收尾');
  }
  // Breadth of preparation matters more than iterating many equivalent long prefixes first.
  const containsRedemption = (macros: readonly Macro[]): boolean => macros.some((macro) => macro.kind === 'conditional' ?
    containsRedemption([...macro.then, ...(macro.otherwise ?? [])]) : (macro.kind === 'repeat' || macro.kind === 'once') && macro.action.kind === 'redemption');
  const containsChaos = (macros: readonly Macro[]): boolean => macros.some((macro) => macro.kind === 'conditional' ?
    containsChaos([...macro.then, ...(macro.otherwise ?? [])]) : macro.kind === 'chaos');
  const guardedT1 = (macros: readonly Macro[]): boolean => macros.some((macro) => macro.kind === 'conditional' ?
    guardedT1([...macro.then, ...(macro.otherwise ?? [])]) : macro.kind === 'repeat' && macro.action.kind === 'havoc' &&
      macro.until.kind === 'exists' && macro.until.selector.sealable === true && macro.until.selector.maxTier === 1);
  const priority = (route: StrategyTemplate) => (containsRedemption(route.macros) ? 1000 : containsChaos(route.macros) ? 500 : guardedT1(route.macros) ? -100 : 0) + macroStages(route.macros);
  templates.sort((a, b) => priority(a) - priority(b) || a.id.localeCompare(b.id, 'en'));
  // Fair deterministic coverage before deeper variants; a low route budget must not hide an entire useful family.
  const head: StrategyTemplate[] = [];
  const pick = (test: (route: StrategyTemplate) => boolean) => { const found = templates.find((row) => !head.includes(row) && test(row)); if (found) head.push(found); };
  pick((row) => row.family === 'DONE' || row.family === 'FINISH');
  pick((row) => row.family === 'INTERLEAVED_MIN_SEAL');
  pick((row) => row.family === 'INTERLEAVED_ACQUIRE' && guardedT1(row.macros));
  pick((row) => row.family === 'INTERLEAVED_ACQUIRE' && !guardedT1(row.macros));
  pick((row) => guardedT1(row.macros) && !containsRedemption(row.macros) && !containsChaos(row.macros));
  pick((row) => row.family === 'PREPARE_SEAL' && row.description?.includes('封T1至T2') === true &&
    !containsRedemption(row.macros) && !containsChaos(row.macros));
  pick((row) => row.family === 'DIRECT');
  pick((row) => row.description?.includes('连续剥离') ?? false);
  pick((row) => (row.family === 'SEAL' || row.family === 'PREPARE_SEAL') && !containsRedemption(row.macros) && !containsChaos(row.macros));
  pick((row) => row.family === 'REDEMPTION_SINGLE_CAST');
  const lowTiers = structure.ordinary.filter((row) => row.tier !== 7).map((row) => row.tier);
  if (structure.node.ordinaryCount < 4) lowTiers.push(1);
  const bestTier = Math.min(...lowTiers);
  pick((row) => row.family === 'REDEMPTION_ANY_THEN_ACQUIRE' && (structure.node.sealedCount ? row.description?.includes('准备后剥离') : row.description?.includes(`准备后封T${bestTier}`)) === true);
  pick((row) => row.family === 'REDEMPTION_PROTECTED_SECOND');
  pick((row) => row.family === 'REDEMPTION' && row.description?.startsWith('重复救赎') === true);
  pick((row) => row.family === 'CHAOS' || row.family === 'PREPARE_CHAOS');
  templates.splice(0, templates.length, ...head, ...templates.filter((row) => !head.includes(row)));
  return { structure, templates, rejected, grammar: 'HIERARCHICAL_FIXED_TEMPLATES_V2' };
}

function firstAction(macros: readonly Macro[], item: Item, request: PlanRequest, engine: RuleEngine): 'OK' | 'INAPPLICABLE' {
  for (const macro of macros) {
    if (macro.kind === 'conditional') {
      const branch = predicateReached(item, macro.when, request, engine) ? macro.then : macro.otherwise ?? [];
      const result = firstAction(branch, item, request, engine);
      if (result === 'INAPPLICABLE') return result;
      if (branch.length) return 'OK';
      continue;
    }
    const step = macroStep(macro, item, request, engine);
    if (step === 'SKIP') continue;
    if (step === 'INAPPLICABLE') return step;
    if (macro.kind === 'repeat' && step.action.kind === 'havoc') {
      const indices = item.affixes.flatMap((row, index) => row.slot === 'ordinary' ? [index] : []);
      const reachable = tierPermutations(ordinary(item).map((row) => row.tier)).some((tiers) => {
        const affixes = [...item.affixes]; indices.forEach((index, i) => { affixes[index] = { ...affixes[index], tier: tiers[i] }; });
        const layout = { ...item, affixes };
        return targetReached(layout, request.target) || predicateReached(layout, macro.until, request, engine);
      });
      if (!reachable) return 'INAPPLICABLE';
    }
    if (macro.kind === 'repeat' && step.action.kind === 'redemption') {
      const possible = (predicate: Predicate): boolean => {
        if (predicate.kind === 'all') return predicate.predicates.every(possible);
        if (predicate.kind === 'any') return predicate.predicates.some(possible);
        if (predicate.kind === 'exists' || predicate.kind === 'count') return true;
        const requirements = predicate.kind === 'target' ? request.target.requirements.filter((row) => !row.optional) :
          predicate.kind === 'requirements' ? predicate.requirements : [predicate.requirement];
        return requirements.every((requirement) => item.affixes.some((row) => matches(row, requirement)) || requirement.ids.some((id) =>
          engine.catalog.affix(id).special === 0 && engine.catalog.canRollOn(id, item.baseId) && engine.catalog.craftWeight(id, item.baseId) > 0 &&
          !item.affixes.some((row) => row.id === id && (row.slot !== 'ordinary' || row.tier < 6)) &&
          ordinary(item).some((row) => row.tier >= 6 && row.tier >= requirement.minTier && row.tier <= (requirement.maxTier ?? 8) &&
            engine.catalog.side(row.id) === engine.catalog.side(id))));
      };
      if (!possible(macro.until)) return 'INAPPLICABLE';
    }
    return engine.eligibility(item, 63, step.action, request.craftingContext, request.constraints).length ? 'INAPPLICABLE' : 'OK';
  }
  return 'OK';
}
