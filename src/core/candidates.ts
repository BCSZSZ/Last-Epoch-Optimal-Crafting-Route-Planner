import { ordinary } from './catalog';
import { RuleEngine } from './rules';
import { targetReached } from './target';
import type { Macro, PlanRequest, Predicate, Requirement, Route, Selector } from './types';

export function macroKey(macro: Macro): string { return JSON.stringify(macro); }
export function routeKey(route: Route): string { return JSON.stringify(route.macros); }
export function routeId(macros: readonly Macro[]): string {
  const text = JSON.stringify(macros);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    first = Math.imul(first ^ text.charCodeAt(i), 0x01000193);
    second = Math.imul(second ^ text.charCodeAt(i), 0x85ebca6b);
  }
  return `r-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function macroActionKind(macro: Macro): string {
  return macro.kind === 'once' || macro.kind === 'repeat' ? macro.action.kind : macro.kind;
}

export function allowedMacro(macro: Macro, request: PlanRequest): boolean {
  return !request.constraints.allowedActions || request.constraints.allowedActions.some((kind) => kind === macroActionKind(macro));
}

/** Seed useful FULL routes, without turning the pattern list into an input whitelist. */
export function commonRoutes(request: PlanRequest, engine: RuleEngine): Route[] {
  const routes: Route[] = [];
  const seen = new Set<string>();
  const required = request.target.requirements.filter((row) => !row.optional);
  const ids = [...new Set(required.flatMap((row) => row.ids))];
  const exclusions = [...new Set([...ids, ...(request.constraints.protected?.map((row) => row.id) ?? [])])];
  const append = (macros: readonly Macro[], description: string) => {
    if (macros.length > request.search.macroStages || macros.some((macro) => !allowedMacro(macro, request))) return;
    const route = { id: routeId(macros), macros, description };
    const key = routeKey(route);
    if (!seen.has(key)) { seen.add(key); routes.push(route); }
  };
  const final: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
  const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
  const prepare = (selector: Selector): Macro => ({ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector } });
  const existing = new Set(request.item.affixes.map((row) => row.id));
  append([], '起点已达标时直接结束');
  if (targetReached(request.item, { requirements: required.map((row) => ({ ...row, minTier: 1, maxTier: 8 })) })) {
    append([final], '目标身份齐全后，浩劫至目标阶数布局');
  }
  append([{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: { kind: 'target' } }], '重复救赎，逐次检查完整目标');
  for (const requirement of required.filter((row) => row.slot === 'sealed' && row.minTier <= 4)) {
    for (const id of requirement.ids) {
      const existingAffix = request.item.affixes.find((row) => row.id === id);
      const prefix: Macro[] = existingAffix ? [] : [add(id)];
      const seal: Macro = { kind: 'seal', selector: { ids: [id], minTier: requirement.minTier, maxTier: Math.min(4, requirement.maxTier ?? 4) } };
      append([...prefix, seal], '封印指定目标词缀，失败立即停止');
      if (requirement.minTier > 1) append([...prefix, { kind: 'upgrade', id, tier: requirement.minTier, glyph: 'hope' }, seal], '升级到目标封印阶数后封印一次');
      append([...prefix, { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' },
        until: { kind: 'identity', requirement: { ...requirement, ids: [id], slot: 'ordinary' } } }, seal], '先浩劫到指定封印阶数，再封印一次');
    }
  }
  // All combinations of missing acceptable IDs and their orders are considered within this seed family.
  const assignments: number[][] = [];
  const assign = (index: number, chosen: number[]) => {
    if (assignments.length >= 256) return; // Priority seeds only; the full grammar below retains every identity.
    if (index >= required.length) { assignments.push(chosen); return; }
    for (const id of required[index].ids) if (!chosen.includes(id)) assign(index + 1, [...chosen, id]);
  };
  assign(0, []);
  for (const selected of assignments) {
    const missing = selected.filter((id) => !existing.has(id));
    const orders = missing.length === 2 ? [missing, [...missing].reverse()] : [missing];
    for (const order of orders) {
      const additions = order.map(add);
      append([...additions, final], '补齐缺失目标身份，再进行最终浩劫');
      append(additions, '直接添加缺失目标词缀');
      const upgrades: Macro[] = selected.flatMap((id, index) => {
        const tier = required[index].minTier;
        return tier <= 5 && ['ordinary', 'any'].includes(required[index].slot) ? [{ kind: 'upgrade', id, tier, glyph: 'hope' }] : [];
      });
      append([...additions, ...upgrades], '补词并升级到目标阶数');
      if (order.length < 1 || order.length > 2) continue;
      const last = order[order.length - 1];
      const side = engine.catalog.side(last);
      if (side === 2) continue;
      const junk: Selector = { side, excludedIds: exclusions, minTier: 1, maxTier: 4 };
      const t1: Selector = { ...junk, maxTier: 1, sealable: true };
      const prefix = order.slice(0, -1).map(add);
      append([...prefix, { kind: 'seal', selector: junk }, add(last), final], '封印该侧垃圾，补入目标，再浩劫');
      append([...prefix, prepare(t1), { kind: 'seal', selector: t1 }, add(last), final], '先浩劫制造合侧垃圾T1，再封印补词和最终浩劫');
      append([...prefix, { kind: 'removal', accepted: { side, excludedIds: exclusions }, glyph: 'hope' }, add(last), final], '剥离指定侧垃圾，失手即停止，再补词浩劫');
      // A three-slot existing-A item can require a separate filler in the original empty side.
      if (ordinary(request.item).length === 3 && order.length === 1) {
        const fillers = engine.catalog.model.affixes.filter((row) => row.special === 0 && row.side !== side && row.side < 2 &&
          !existing.has(row.id) && !selected.includes(row.id) && engine.catalog.hasShard(row.id) && engine.catalog.canRollOn(row.id, request.item.baseId));
        for (const filler of fillers) {
          append([{ kind: 'seal', selector: junk }, add(last), add(filler.id), final], '封印腾位、补目标及填充词缀，再浩劫');
          append([add(filler.id), prepare(t1), { kind: 'seal', selector: t1 }, add(last), final], '先填满四栏，再准备浩劫、封印补目标和最终浩劫');
        }
      }
      const identity: Requirement = { ids: [last], minTier: 1, maxTier: 5, slot: 'ordinary' };
      append([...prefix, { kind: 'chaos', selector: { side, excludedIds: exclusions, minTier: 1, maxTier: 4 }, until: identity }, final], '混沌至出现目标身份，再最终浩劫');
    }
  }
  for (const requirement of required) {
    const interim: Predicate = { kind: 'identity', requirement: { ...requirement, minTier: Math.min(6, requirement.minTier), maxTier: undefined } };
    append([{ kind: 'repeat', action: { kind: 'redemption', glyph: 'hope' }, until: interim }, final], '救赎至指定目标身份出现，再浩劫');
  }
  return routes;
}

/** Public finite macro grammar v1. It contains all legal-on-base filler IDs, not only final target IDs. */
export function macroLibrary(request: PlanRequest, engine: RuleEngine, seeds: readonly Route[]): readonly Macro[] {
  const macros: Macro[] = [];
  const seen = new Set<string>();
  const add = (macro: Macro) => { const key = macroKey(macro); if (!seen.has(key) && allowedMacro(macro, request)) { seen.add(key); macros.push(macro); } };
  for (const route of seeds) for (const macro of route.macros) add(macro);
  const requirements = request.target.requirements.filter((row) => !row.optional);
  const targetIds = [...new Set(requirements.flatMap((row) => row.ids))];
  const protectedIds = request.constraints.protected?.map((row) => row.id) ?? [];
  const selectors: Selector[] = [{}, { excludedIds: targetIds }, { excludedIds: [...new Set([...targetIds, ...protectedIds])] }];
  for (const side of [0, 1] as const) {
    for (let tier = 1; tier <= 4; tier++) selectors.push({ side, minTier: tier, maxTier: tier },
      { side, excludedIds: targetIds, minTier: tier, maxTier: tier });
    selectors.push({ side }, { side, excludedIds: targetIds, minTier: 1, maxTier: 4 });
  }
  const available = engine.catalog.model.affixes.filter((row) => row.special === 0 && row.side < 2 &&
    engine.catalog.hasShard(row.id) && (engine.catalog.canRollOn(row.id, request.item.baseId) || request.item.affixes.some((entry) => entry.id === row.id)));
  for (const definition of available) {
    for (const glyph of ['hope', 'none'] as const) add({ kind: 'once', action: { kind: 'add', id: definition.id, glyph } });
    for (let tier = 2; tier <= 5; tier++) for (const glyph of ['hope', 'order', 'none'] as const) add({ kind: 'upgrade', id: definition.id, tier, glyph });
    selectors.push({ ids: [definition.id], minTier: 1, maxTier: 4 });
  }
  for (const glyph of ['hope', 'none'] as const) {
    add({ kind: 'once', action: { kind: 'havoc', glyph } });
    add({ kind: 'once', action: { kind: 'redemption', glyph } });
    for (const selector of selectors) {
      add({ kind: 'repeat', action: { kind: 'havoc', glyph }, until: { kind: 'exists', selector } });
      add({ kind: 'removal', accepted: selector, glyph });
    }
    const predicates: Predicate[] = [{ kind: 'target' }];
    // Every nonempty subset of required entries is a fixed, serializable intermediate predicate.
    for (let mask = 1; mask < 2 ** requirements.length; mask++) {
      predicates.push({ kind: 'requirements', requirements: requirements.filter((_, index) => mask & (1 << index)) });
    }
    for (const until of predicates) {
      add({ kind: 'repeat', action: { kind: 'havoc', glyph }, until });
      add({ kind: 'repeat', action: { kind: 'redemption', glyph }, until });
    }
  }
  for (const selector of selectors) {
    add({ kind: 'seal', selector: { ...selector, minTier: Math.max(1, selector.minTier ?? 1), maxTier: Math.min(4, selector.maxTier ?? 4) } });
    for (const requirement of requirements) add({ kind: 'chaos', selector: { ...selector, maxTier: Math.min(4, selector.maxTier ?? 4) },
      until: { ...requirement, minTier: 1, maxTier: 5, slot: 'ordinary' } });
  }
  return macros;
}

export interface RouteSpace {
  readonly routes: Generator<Route>;
  readonly prune: (route: Route) => void;
  readonly pruned: () => number;
  readonly librarySize: number;
  readonly candidateUpperBound: string;
}

export function routeSpace(library: readonly Macro[], maximumStages: number, shouldStop: () => boolean = () => false): RouteSpace {
  const pruned = new Set<string>();
  const indices = new Map(library.map((macro, index) => [macroKey(macro), index]));
  let upper = 1n;
  for (let depth = 1; depth <= maximumStages; depth++) upper += BigInt(library.length) ** BigInt(depth);
  const walk = function* (prefix: Macro[], keys: number[], left: number): Generator<Route> {
    if (shouldStop()) return;
    if (pruned.has(keys.join(','))) return;
    if (left === 0) { yield { id: routeId(prefix), macros: prefix }; return; }
    for (let i = 0; i < library.length; i++) {
      const macro = library[i];
      const previous = prefix.at(-1);
      // Idempotent macros skip immediately after a successful identical macro.
      if (previous && ['repeat', 'upgrade'].includes(macro.kind) && macroKey(previous) === macroKey(macro)) continue;
      // Every successful ordinary seal permanently occupies the only regular sealed slot.
      if ((macro.kind === 'seal' || (macro.kind === 'once' && macro.action.kind === 'seal')) &&
          prefix.some((entry) => entry.kind === 'seal' || (entry.kind === 'once' && entry.action.kind === 'seal'))) continue;
      yield* walk([...prefix, macro], [...keys, i], left - 1);
      if (shouldStop()) return;
    }
  };
  const routes = function* (): Generator<Route> {
    yield { id: routeId([]), macros: [], description: '不执行制作动作' };
    for (let depth = 1; depth <= maximumStages; depth++) { yield* walk([], [], depth); if (shouldStop()) return; }
  };
  return { routes: routes(), librarySize: library.length, candidateUpperBound: upper.toString(),
    prune: (route) => {
      const keys = route.macros.map((macro) => indices.get(macroKey(macro)));
      if (keys.every((key) => key !== undefined)) pruned.add(keys.join(','));
    }, pruned: () => pruned.size };
}
