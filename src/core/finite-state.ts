import type { Catalog } from './catalog';
import { ordinary } from './catalog';
import { isConcreteModel } from './input-model';
import { exact, Interval, ONE, ZERO, ratio } from './interval';
import { tierPermutations } from './probability';
import type { ActionKind, FpType, PlanRequest } from './types';

export class FiniteStateLimit extends Error {}
export interface CompactState { readonly roles: readonly number[]; readonly tiers: readonly number[]; readonly sealed: number }
export interface CompactAction { readonly kind: ActionKind; readonly slot?: number; readonly role?: number }
export interface CompactEdge { readonly to: number; readonly kernel: number; readonly p: number; readonly lo: number; readonly hi: number }
export interface CompactChoice { readonly action: CompactAction; readonly edges: readonly CompactEdge[] }
export interface CompactDomain {
  readonly poolSizes: readonly number[];
  readonly experimentalRole?: number;
  readonly goalSides: readonly number[];
  readonly targetIds: readonly number[];
  readonly initial: CompactState;
  readonly allowed: ReadonlySet<ActionKind>;
  readonly key: string;
}

/** Exact exchangeability domain: ordinary, forgeable uniform pools atL100.
 * The UI's eight digits are only a display; pool exclusions and sealed IDs are
 * retained as counts, with one distinct experimental identity where applicable.
 */
export function compactDomain(request: PlanRequest, catalog: Catalog): CompactDomain | null {
  const goals = request.target.requirements.filter(row => !row.optional);
  const experiments = request.item.affixes.filter(row => catalog.affix(row.id).special === 1);
  if (experiments.length > 1 || experiments.some(row => !isConcreteModel(request.inputModel) || row.slot !== 'ordinary' ||
      catalog.hasShard(row.id) || !catalog.canRollOn(row.id, request.item.baseId))) return null;
  const experimentalId = experiments[0]?.id;
  if (goals.length !== 2 || request.target.requirements.length !== 2 || goals.some(row => row.ids.length !== 1 ||
      row.slot !== 'ordinary' || row.minTier !== 7 || row.maxTier !== 7 || row.minRollByte !== undefined) ||
      request.item.corrupted || request.item.itemLevel !== 100 || request.craftingContext.playerLevel !== 100 ||
      request.constraints.maxAttempts !== undefined || request.constraints.protected?.length ||
      request.item.affixes.some(row => !['ordinary', 'sealed'].includes(row.slot) || (catalog.affix(row.id).special !== 0 && row.id !== experimentalId) ||
        row.slot === 'ordinary' && ![1, 2, 3, 4, 5, 7].includes(row.tier)) || ordinary(request.item).filter(row => row.tier === 7).length !== 2) return null;
  const targetIds = goals.map(row => row.ids[0]);
  if (targetIds[0] === targetIds[1]) return null;
  const experimentalRole = experimentalId === undefined ? undefined : (targetIds.indexOf(experimentalId) + 1 || 4);
  const goalSides = targetIds.map(id => catalog.side(id));
  if (goalSides.some(side => side > 1) || request.item.affixes.some(row => row.slot === 'sealed' && targetIds.includes(row.id))) return null;
  const pools = [0, 1].map(side => catalog.model.affixes.filter(row => row.special === 0 && row.side === side &&
    catalog.canRollOn(row.id, request.item.baseId) && catalog.craftWeight(row.id, request.item.baseId) > 0));
  if (pools.some(pool => pool.length < 4 || pool.some(row => !catalog.hasShard(row.id) || row.tiers.length < 7) ||
      pool.some(row => catalog.craftWeight(row.id, request.item.baseId) !== catalog.craftWeight(pool[0].id, request.item.baseId)))) return null;
  if (request.item.affixes.some(row => row.id !== experimentalId && !pools[catalog.side(row.id)].some(candidate => candidate.id === row.id)) ||
      targetIds.some((id, i) => id !== experimentalId && !pools[goalSides[i]].some(row => row.id === id))) return null;
  const roles: number[] = [], tiers: number[] = [];
  for (const side of [0, 1]) {
    const rows = ordinary(request.item).filter(row => catalog.side(row.id) === side);
    for (const row of rows) { roles.push(targetIds.includes(row.id) ? targetIds.indexOf(row.id) + 1 : row.id === experimentalId ? 4 : 3); tiers.push(row.tier); }
    for (let i = rows.length; i < 2; i++) { roles.push(0); tiers.push(0); }
  }
  const sealed = request.item.affixes.find(row => row.slot === 'sealed');
  const allowed = new Set<ActionKind>(request.constraints.allowedActions ?? ['add', 'upgrade', 'seal', 'chaos', 'havoc', 'redemption', 'removal']);
  const poolSizes = pools.map(pool => pool.length);
  return { poolSizes, goalSides, targetIds, experimentalRole, initial: { roles, tiers, sealed: sealed ? 3 + 16 * catalog.side(sealed.id) : 0 }, allowed,
    key: JSON.stringify([catalog.model.modelId, poolSizes, goalSides, experimentalRole, [...allowed].sort()]) };
}

type WeightedState = { roles: number[]; p: Interval };
export const COMPACT_KERNELS: readonly (readonly [number, boolean])[] = [[0, false], [10, true], [12, true], [18, true], [20, true], [25, true], [24, true], [10, false], [12, false], [18, false], [24, false]];
const kernelForTier = (tier: number, hope: boolean) => hope ? [1, 2, 3, 6][tier - 1] : [7, 8, 9, 10][tier - 1];

export class CompactGraph {
  readonly states: (CompactState | null)[] = [null, null];
  readonly actions: CompactChoice[][] = [[], []];
  readonly indices = new Map<number, number>();
  private built = 2;
  private readonly critical: Interval;
  constructor(readonly domain: CompactDomain, profile: FpType, parameters: { critical: number; blood: number; sealMultipliers: readonly number[] },
    private readonly maxStates: number, private readonly stopped: () => boolean) {
    this.critical = profile === 'BLOOD' ? exact(parameters.critical).add(exact(parameters.critical).complement().mul(exact(parameters.blood))) : exact(parameters.critical);
    this.sealMultipliers = parameters.sealMultipliers;
  }
  private readonly sealMultipliers: readonly number[];
  intern(roles: readonly number[], tiers: readonly number[], sealed: number): number {
    const experiment = this.domain.experimentalRole;
    if ((experiment === 1 || experiment === 2) && !roles.some((role, i) => role === experiment && tiers[i])) return 0;
    if (tiers.filter(t => t === 7).length < 2) return 0;
    if ([1, 2].every(role => roles.some((id, i) => id === role && tiers[i] === 7))) return 1;
    const ids = roles.map((role, i) => tiers[i] ? role : 0), ts = [...tiers];
    for (const side of [0, 2]) if (!ts[side]) { ids[side] = ids[side + 1]; ts[side] = ts[side + 1]; ids[side + 1] = 0; ts[side + 1] = 0; }
    let code = sealed * 4294967296;
    for (let i = 0; i < 4; i++) code += (ts[i] ? ids[i] * 8 + ts[i] : 0) * 2 ** (8 * i);
    const old = this.indices.get(code); if (old !== undefined) return old;
    if (this.states.length >= this.maxStates) throw new FiniteStateLimit('完整状态超过本次计算预算');
    const index = this.states.length; this.indices.set(code, index); this.states.push({ roles: ids, tiers: ts, sealed }); this.actions.push([]); return index;
  }
  include(initial: CompactState, stopped = this.stopped): number {
    const root = this.intern(initial.roles, initial.tiers, initial.sealed);
    while (this.built < this.states.length) {
      if ((this.built & 63) === 0 && stopped()) throw new FiniteStateLimit('完整状态搜索已中断');
      const s = this.built++; this.actions[s] = this.build(this.states[s]!);
    }
    return root;
  }
  private isExperimental(role: number): boolean {
    return role === this.domain.experimentalRole;
  }
  private reroll(roles: readonly number[], tiers: readonly number[], sealed: number, slot: number): WeightedState[] {
    const side = slot >> 1, counts = [0, 0, 0, 0];
    roles.forEach((role, i) => { if (tiers[i] && (i >> 1) === side && !this.isExperimental(role)) counts[role]++; });
    if (sealed && Math.floor(sealed / 16) === side) counts[3]++;
    const first = Number(this.domain.goalSides[0] === side && !this.isExperimental(1));
    const second = Number(this.domain.goalSides[1] === side && !this.isExperimental(2));
    const totals = [0, first, second, this.domain.poolSizes[side] - first - second];
    const total = totals.reduce((v, x, i) => v + x - counts[i], 0);
    if (!total) return [];
    return [1, 2, 3].flatMap(role => {
      const count = totals[role] - counts[role]; if (!count) return [];
      const ids = [...roles]; ids[slot] = role; return [{ roles: ids, p: ratio(count, total) }];
    });
  }
  private build(state: CompactState): CompactChoice[] {
    const { roles, tiers, sealed } = state, choices: CompactChoice[] = [];
    const append = (action: CompactAction, outcomes: readonly { roles: readonly number[]; tiers: readonly number[]; sealed: number; p: Interval; kernel: number }[]) => {
      if (!this.domain.allowed.has(action.kind) || !outcomes.length) return;
      const merged = new Map<string, { to: number; kernel: number; p: Interval }>();
      for (const outcome of outcomes) {
        if (outcome.p.upper <= 0) continue;
        const to = this.intern(outcome.roles, outcome.tiers, outcome.sealed), key = `${to}:${outcome.kernel}`, old = merged.get(key);
        merged.set(key, { to, kernel: outcome.kernel, p: old ? old.p.add(outcome.p) : outcome.p });
      }
      const edges = [...merged.values()].map(e => ({ to: e.to, kernel: e.kernel, p: e.p.midpoint, lo: Math.max(0, e.p.lower), hi: e.p.upper }));
      if (edges.length) choices.push({ action, edges });
    };
    type Exit = Parameters<typeof append>[1][number];
    const craft = (ids: readonly number[], ts: readonly number[], seal: number, primary: number, kernel: number, mass = ONE): Exit[] => {
      const outcomes: Exit[] = [{ roles: ids, tiers: ts, sealed: seal, p: mass.mul(this.critical.complement()), kernel }];
      const eligible = ts.flatMap((t, i) => t > 0 && t < 5 ? [i] : []);
      if (!eligible.length) outcomes.push({ roles: ids, tiers: ts, sealed: seal, p: mass.mul(this.critical), kernel: 0 });
      else for (const slot of eligible) {
        const p = !eligible.includes(primary) || eligible.length === 1 ? ratio(1, eligible.length) : slot === primary ?
          exact(.25).add(ratio(.5, eligible.length)) : ratio(.25, eligible.length - 1).add(ratio(.5, eligible.length));
        const next = [...ts]; next[slot]++;
        outcomes.push({ roles: ids, tiers: next, sealed: seal, p: mass.mul(this.critical).mul(p), kernel: 0 });
      }
      return outcomes;
    };
    for (let slot = 0; slot < 4; slot++) {
      const side = slot >> 1;
      if (!tiers[slot]) {
        const available = [3, 1, 2].filter(role => role < 3 ? this.domain.goalSides[role - 1] === side && !roles.includes(role) && !this.isExperimental(role) :
          this.domain.poolSizes[side] - this.domain.goalSides.filter((s, i) => s === side && !this.isExperimental(i + 1)).length > roles.filter((r, i) => r === 3 && tiers[i] && (i >> 1) === side).length + Number(sealed > 0 && Math.floor(sealed / 16) === side));
        for (const role of available) { const ids = [...roles], ts = [...tiers]; ids[slot] = role; ts[slot] = 1; append({ kind: 'add', slot, role }, craft(ids, ts, sealed, slot, 3)); }
      }
      if (tiers[slot] > 0 && tiers[slot] < 5 && !this.isExperimental(roles[slot])) {
        const ts = [...tiers]; ts[slot]++;
        append({ kind: 'upgrade', slot }, craft(roles, ts, sealed, slot, kernelForTier(tiers[slot], true)));
        if (!sealed && roles[slot] === 3) {
          const weight = exact(.6).add(exact(.15).mul(exact(tiers.filter(Boolean).length))).add(exact(.3)).mul(exact(this.sealMultipliers[tiers[slot] - 1]));
          const success = new Interval(Math.min(1, weight.lower), Math.min(1, weight.upper));
          const after = [...tiers]; after[slot] = 0;
          append({ kind: 'seal', slot }, [{ roles, tiers: after, sealed: 3 + 16 * side, p: success, kernel: kernelForTier(tiers[slot], false) },
            ...craft(roles, ts, 0, slot, kernelForTier(tiers[slot], false), success.complement())]);
        }
        append({ kind: 'chaos', slot }, this.reroll(roles, tiers, sealed, slot).map(r => ({ roles: r.roles, tiers: ts, sealed, p: r.p, kernel: kernelForTier(tiers[slot], false) })));
      }
    }
    const occupied = tiers.flatMap((t, i) => t ? [i] : []);
    const removable = occupied.filter(slot => !this.isExperimental(roles[slot]));
    if (occupied.length > 2) append({ kind: 'removal' }, removable.map(slot => {
      const ts = [...tiers]; ts[slot] = 0;
      return { roles, tiers: ts, sealed, p: ratio(1, removable.length), kernel: 5 };
    }));
    if (occupied.length === 4) {
      const permutations = tierPermutations(tiers).filter(ts => ts.some((t, i) => t !== tiers[i]));
      if (permutations.length) append({ kind: 'havoc' }, permutations.map(ts => ({ roles, tiers: ts, sealed, p: ratio(1, permutations.length), kernel: 4 })));
    }
    let redeemed: WeightedState[] = [{ roles: [...roles], p: ONE }];
    for (let slot = 0; slot < 4; slot++) if (tiers[slot] === 7) redeemed = redeemed.flatMap(before =>
      this.reroll(before.roles, tiers, sealed, slot).map(after => ({ roles: after.roles, p: before.p.mul(after.p) })));
    append({ kind: 'redemption' }, redeemed.map(r => ({ roles: r.roles, tiers, sealed, p: r.p, kernel: 4 })));
    return choices;
  }
}

export function compactCode(state: CompactState): { tiers: string; targets: string; sealed: string } {
  return { tiers: state.tiers.join(''), targets: state.roles.map((r, i) => state.tiers[i] && (r === 1 || r === 2) ? '1' : '0').join(''),
    sealed: !state.sealed ? '无' : Math.floor(state.sealed / 16) ? '后缀非目标' : '前缀非目标' };
}

export function compactActionText(state: CompactState, action: CompactAction): string {
  if (action.kind === 'havoc') return '浩劫＋希望';
  if (action.kind === 'redemption') return '救赎＋希望';
  if (action.kind === 'removal') return '剥离＋希望';
  const slot = action.slot!, name = ['前缀1', '前缀2', '后缀1', '后缀2'][slot], tier = state.tiers[slot];
  if (action.kind === 'add') return `在${name}补${action.role === 3 ? '非目标占位' : `缺失目标${action.role === 1 ? 'A' : 'B'}`}T1＋希望`;
  if (action.kind === 'seal') return `封印${name}的非目标T${tier}（绝望）`;
  const identity = state.roles[slot] === 3 ? '非目标' : `目标${state.roles[slot] === 1 ? 'A' : 'B'}`;
  if (action.kind === 'chaos') return `升级${name}的${identity}T${tier}并用混沌重掷`;
  return `升级${name}的${identity}T${tier}→T${tier + 1}＋希望`;
}

export { ZERO };
