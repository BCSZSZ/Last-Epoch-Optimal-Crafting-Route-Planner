import { MODEL_ID } from './catalog';
import { AVERAGE_BASE_ID, AVERAGE_EXPERIMENT_BASE_ID, catalogForInputModel, closestPoolGroup, ordinaryBaseGroups, poolSizes } from './input-model';
import type { Catalog } from './catalog';
import type { BaseGroup } from './input-model';
import { parsePlanRequest } from './request';
import type { Affix, FpType, InputModel, Issue, PlanRequest, Requirement } from './types';

export const DRAFT_SLOTS = [
  { key: 'prefix1', label: '前缀1', side: 0, slot: 'ordinary' },
  { key: 'prefix2', label: '前缀2', side: 0, slot: 'ordinary' },
  { key: 'suffix1', label: '后缀1', side: 1, slot: 'ordinary' },
  { key: 'suffix2', label: '后缀2', side: 1, slot: 'ordinary' },
  { key: 'sealed', label: '封印', side: null, slot: 'sealed' },
] as const;
export type DraftSlotKey = typeof DRAFT_SLOTS[number]['key'];
export interface DraftSlot { readonly tier: number; readonly id: number | null; readonly isTarget?: boolean; readonly isExperimental?: boolean }
export type DraftSlots = Readonly<Record<DraftSlotKey, DraftSlot>>;
export interface GoalCounts { readonly desired: number; readonly owned: number; readonly ownedT7: number }
export interface CraftingDraft {
  readonly initialFp?: number;
  readonly version: 3;
  readonly part: number | null;
  readonly fpType: FpType;
  readonly slots: DraftSlots;
  readonly targetMode: 'COUNTS' | 'SLOTS';
  readonly counts: readonly [{ readonly desired: number }, { readonly desired: number }];
  readonly targetSlots: DraftSlots;
  readonly legacyOwnership?: readonly { readonly side: 0 | 1; readonly owned: number; readonly ownedT7: number }[];
}
export interface DraftScenario {
  readonly key: string;
  readonly condition: string;
  readonly part: number;
  readonly baseIds: readonly string[];
  readonly aliases: Readonly<Record<number, string>>;
  readonly request: PlanRequest;
}
export interface CompiledDraft {
  readonly scenarios: readonly DraftScenario[];
  readonly issues: readonly Issue[];
  readonly inputModel: InputModel;
  readonly assumptions: readonly string[];
}

export function emptyDraftSlots(): DraftSlots {
  const empty = (): DraftSlot => ({ tier: 0, id: null, isTarget: false });
  return { prefix1: empty(), prefix2: empty(), suffix1: empty(), suffix2: empty(), sealed: empty() };
}
export function emptyDraft(): CraftingDraft {
  return { version: 3, part: null, fpType: 'NORMAL', slots: emptyDraftSlots(), targetMode: 'COUNTS',
    counts: [{ desired: 0 }, { desired: 0 }], targetSlots: emptyDraftSlots() };
}
const concreteCatalog = catalogForInputModel('CONCRETE_WEIGHTED');
const playerLevel = 100;
const baseGroups = ordinaryBaseGroups(concreteCatalog);
const eligibleByBase = new Map<string, readonly number[]>();

function eligibleIds(baseId: string): readonly number[] {
  let ids = eligibleByBase.get(baseId);
  if (!ids) {
    ids = concreteCatalog.model.affixes.filter(a => a.side < 2 && [0, 1, 2].includes(a.special) &&
      concreteCatalog.canRollOn(a.id, baseId)).map(a => a.id);
    eligibleByBase.set(baseId, ids);
  }
  return ids;
}

function matchesSlot(id: number, side: 0 | 1 | null, tier: number, experimental?: boolean, catalog: Catalog = concreteCatalog): boolean {
  const a = catalog.affix(id);
  return (side === null || a.side === side) && a.tiers.length >= Math.max(1, tier) &&
    (experimental === undefined || (a.special === 1) === experimental);
}

function activeSlots(draft: CraftingDraft) {
  return (draft.targetMode === 'SLOTS' ? [false, true] : [false]).flatMap(target =>
    DRAFT_SLOTS.map(descriptor => ({ descriptor, target, row: (target ? draft.targetSlots : draft.slots)[descriptor.key] })))
    .filter(({ row }) => row.tier > 0);
}

function compatibleGroups(draft: CraftingDraft, slots = activeSlots(draft)): BaseGroup[] {
  return baseGroups.filter(group => (draft.part === null || draft.part === group.part) && slots.every(({ row, descriptor, target }) => {
    const { baseId } = group;
    if (row.id !== null) return eligibleIds(baseId).includes(row.id) && matchesSlot(row.id, descriptor.side, row.tier);
    if (!target && row.isExperimental) return eligibleIds(baseId).some(id => matchesSlot(id, descriptor.side, row.tier, true));
    return true;
  }));
}

/** The picker projects the still-compatible real bases, without locking the slot being edited. */
export function draftSlotPool(draft: CraftingDraft, key: DraftSlotKey, target = false): readonly number[] {
  const descriptor = DRAFT_SLOTS.find(s => s.key === key)!;
  const row = (target ? draft.targetSlots : draft.slots)[key];
  const rest = activeSlots(draft).filter(s => s.descriptor.key !== key || s.target !== target);
  const occupied = new Set(rest.filter(s => s.target === target).map(s => s.row.id));
  const existing = new Set(activeSlots(draft).filter(s => !s.target).map(s => s.row.id));
  const ids = new Set(compatibleGroups(draft, rest).flatMap(b => eligibleIds(b.baseId)));
  return [...ids].filter(id => !occupied.has(id) && matchesSlot(id, descriptor.side, row.tier,
    target ? undefined : key === 'prefix2' && Boolean(row.isExperimental ||
      row.id !== null && concreteCatalog.hasAffix(row.id) && concreteCatalog.affix(row.id).special === 1)) &&
    (!target || concreteCatalog.affix(id).special === 0 || existing.has(id))).sort((a, b) => a - b);
}

export function readDraft(value: unknown): CraftingDraft | null {
  const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const count = (x: unknown, upper: number) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= upper;
  if (!object(value) || value.version !== 2 && value.version !== 3 || (value.part !== null && !count(value.part, 42)) ||
    !['NORMAL', 'ICE', 'BLOOD'].includes(String(value.fpType)) || !['COUNTS', 'SLOTS'].includes(String(value.targetMode))) return null;
  if (value.initialFp !== undefined && !count(value.initialFp, 63)) return null;
  for (const slots of [value.slots, value.targetSlots]) {
    if (!object(slots)) return null;
    for (const descriptor of DRAFT_SLOTS) {
      const slot = slots[descriptor.key];
      if (!object(slot) || !count(slot.tier, 7) || (slot.id !== null && !count(slot.id, 65535)) ||
        slot.isTarget !== undefined && typeof slot.isTarget !== 'boolean' ||
        slot.isExperimental !== undefined && typeof slot.isExperimental !== 'boolean') return null;
      if (slot.isTarget && (slot.tier === 0 || descriptor.slot === 'sealed')) return null;
      if (slot.isExperimental && (slot.tier === 0 || descriptor.key !== 'prefix2')) return null;
    }
  }
  if (!Array.isArray(value.counts) || value.counts.length !== 2 || value.counts.some((row) => !object(row) ||
    !count(row.desired, 2) || value.version === 2 && (!count(row.owned, 2) || !count(row.ownedT7, 2)))) return null;
  const copySlots = (input: unknown): DraftSlots => {
    const slots = input as Record<string, DraftSlot>;
    return Object.fromEntries(DRAFT_SLOTS.map(({ key }) => [key, { tier: slots[key].tier, id: slots[key].id, isTarget: slots[key].isTarget ?? false,
      ...(slots[key].isExperimental !== undefined ? { isExperimental: slots[key].isExperimental } : {}) }])) as unknown as DraftSlots;
  };
  let slots = copySlots(value.slots);
  const pending: NonNullable<CraftingDraft['legacyOwnership']>[number][] = [];
  if (value.version === 2) for (const side of [0, 1] as const) {
    const row = value.counts[side], ordinary = DRAFT_SLOTS.filter(slot => slot.side === side);
    const high = ordinary.filter(slot => slots[slot.key].tier === 7), low = ordinary.filter(slot => slots[slot.key].tier > 0 && slots[slot.key].tier < 7);
    const lowCount = row.owned - row.ownedT7;
    if (row.owned > row.desired || row.ownedT7 > row.owned || row.ownedT7 > high.length || lowCount > low.length ||
      row.ownedT7 !== 0 && row.ownedT7 !== high.length || lowCount !== 0 && lowCount !== low.length) {
      pending.push({ side, owned: row.owned, ownedT7: row.ownedT7 }); continue;
    }
    const selected = [...(row.ownedT7 ? high : []), ...(lowCount ? low : [])];
    for (const slot of selected) slots = { ...slots, [slot.key]: { ...slots[slot.key], isTarget: true } };
  }
  if (value.version === 3 && value.legacyOwnership !== undefined) {
    if (!Array.isArray(value.legacyOwnership) || value.legacyOwnership.length > 2) return null;
    for (const row of value.legacyOwnership) {
      if (!object(row) || !count(row.side, 1) || !count(row.owned, 2) || !count(row.ownedT7, 2) || pending.some(entry => entry.side === row.side)) return null;
      pending.push({ side: row.side as 0 | 1, owned: row.owned as number, ownedT7: row.ownedT7 as number });
    }
  }
  return { version: 3, part: value.part as number | null, fpType: value.fpType as FpType,
    ...(value.initialFp === undefined ? {} : { initialFp: value.initialFp as number }),
    slots, targetMode: value.targetMode as CraftingDraft['targetMode'], counts: [{ desired: value.counts[0].desired }, { desired: value.counts[1].desired }],
    targetSlots: copySlots(value.targetSlots), ...(pending.length ? { legacyOwnership: pending } : {}) };
}

export function ownedGoalCounts(draft: CraftingDraft, side: 0 | 1): GoalCounts {
  const slots = DRAFT_SLOTS.filter(row => row.side === side).map(row => draft.slots[row.key]).filter(row => row.tier > 0 && row.isTarget);
  return { desired: draft.counts[side].desired, owned: slots.length, ownedT7: slots.filter(row => row.tier === 7).length };
}

/** Havoc can move source T7s across sides, but cannot create another one. */
export function maximumGoalCount(draft: CraftingDraft, side: 0 | 1): number {
  const sources = DRAFT_SLOTS.filter(row => row.slot === 'ordinary' && draft.slots[row.key].tier === 7).length;
  return Math.max(0, Math.min(2, sources - draft.counts[side === 0 ? 1 : 0].desired));
}

/** Membership is stored only on starting slots; editing an empty slot clears its membership. */
export function withDraftSlots(draft: CraftingDraft, slots: DraftSlots, confirmedSide?: 0 | 1): CraftingDraft {
  const { legacyOwnership, ...source } = draft;
  const clean = Object.fromEntries(DRAFT_SLOTS.map(row => [row.key, { ...slots[row.key],
    ...(slots[row.key].isExperimental !== undefined ? { isExperimental: row.key === 'prefix2' && slots[row.key].tier > 0 && Boolean(slots[row.key].isExperimental) } : {}),
    isTarget: row.slot === 'ordinary' && slots[row.key].tier > 0 && Boolean(slots[row.key].isTarget) }])) as unknown as DraftSlots;
  const next = { ...source, slots: clean }, pending = legacyOwnership?.filter(row => row.side !== confirmedSide) ?? [];
  return { ...next, counts: [{ desired: Math.max(draft.counts[0].desired, ownedGoalCounts(next, 0).owned) },
    { desired: Math.max(draft.counts[1].desired, ownedGoalCounts(next, 1).owned) }], ...(pending.length ? { legacyOwnership: pending } : {}) };
}

/** Any uses one reference; explicit parts retain their compatible concrete groups. */
export function compileDraft(input: CraftingDraft): CompiledDraft {
  const draft = readDraft(input), issues: Issue[] = [], scenarios: DraftScenario[] = [];
  const fail = (message: string, path?: string) => issues.push({ code: 'DRAFT_INPUT', message, path });
  const slots = draft ? activeSlots(draft) : [];
  const known = new Set(slots.flatMap(({ row }) => row.id === null ? [] : [row.id]));
  const any = draft?.part === null;
  const mode = known.size ? 'CONCRETE_WEIGHTED' : any ? 'AVERAGE_EQUAL' : 'CONCRETE_EQUAL';
  const assumptions = ['按角色和物品等级100计算。',
    mode === 'AVERAGE_EQUAL' ? '兼容范围内先按部位内底材等权，再按部位等权求池大小。前后缀数量各自取整，使用一个等权虚拟池估算。' :
      any ? '在满足已填词缀和职业条件的实际底材中，选择前后缀池大小最接近兼容范围均值的一组求解。' :
        '按该部位内兼容底材等权汇总。相同资格的底材合并求解。',
    known.size ? '有明确词缀时，重抽保留实际制作权重。未指定的起始身份以该底材的合法词缀作代表。' :
      '完全匿名时对池内合法候选等权。'];
  const result = (): CompiledDraft => ({ scenarios, issues, inputModel: mode, assumptions });
  if (!draft) { fail('输入格式无效。'); return result(); }
  for (const { descriptor, row, target } of slots) {
    if (row.id === null) continue;
    const path = `${target ? '目标' : '起始'}${descriptor.label}`;
    if (!concreteCatalog.hasAffix(row.id) || ![0, 1, 2].includes(concreteCatalog.affix(row.id).special) ||
        concreteCatalog.side(row.id) > 1 || !matchesSlot(row.id, descriptor.side, row.tier)) {
      fail(`${path}的词条不符合栏位或T级。`);
      continue;
    }
    const experiment = concreteCatalog.affix(row.id).special === 1;
    if (row.isExperimental !== undefined && row.isExperimental !== experiment) fail(`${path}的实验标记与具体词条不一致。`);
    if (!target && experiment && descriptor.key !== 'prefix2') fail('起始实验词缀请填写在前缀2。');
  }
  if (draft.targetMode === 'SLOTS') {
    if (!slots.some(s => s.target)) fail('请至少设置一项目标T级。');
  } else {
    if (!draft.counts.some(row => row.desired)) fail('请设置所需的目标前缀数或后缀数。');
    if (draft.legacyOwnership?.length) fail('旧输入未明确已有目标的位置，请在左侧勾选确认目标词缀。');
    const sourceT7s = slots.filter(s => !s.target && s.descriptor.slot === 'ordinary' && s.row.tier === 7).length;
    if (draft.counts[0].desired + draft.counts[1].desired > sourceT7s) fail(`目标T7合计不能超过起始普通栏的${sourceT7s}条T7；封印词缀不计入。`);
    for (const side of [0, 1] as const) if (ownedGoalCounts(draft, side).owned > draft.counts[side].desired) {
      fail(`${side === 0 ? '前缀' : '后缀'}目标T7数不能少于左侧勾选的目标词缀数。`);
    }
  }
  if (issues.length) return result();

  const catalog = catalogForInputModel(mode), failures: Issue[] = [];
  const experiment = slots.some(s => !s.target && s.row.isExperimental);
  const averageBase = experiment ? AVERAGE_EXPERIMENT_BASE_ID : AVERAGE_BASE_ID;
  const groups = mode === 'AVERAGE_EQUAL' ? (catalog.hasBase(averageBase) ? [{ baseId: averageBase, baseIds: [averageBase], part: -1 }] : []) :
    compatibleGroups(draft, slots);
  for (const { baseId, baseIds, part } of groups) {
    const reserved = new Set(known);
    const pool = mode === 'AVERAGE_EQUAL' ? catalog.model.affixes.filter(a => catalog.canRollOn(a.id, baseId)).map(a => a.id) :
      eligibleIds(baseId);
    const fresh = (side: 0 | 1 | null, tier: number, experimental = false) => pool.find(id =>
      !reserved.has(id) && matchesSlot(id, side, tier, experimental, catalog) &&
      (experimental || catalog.affix(id).special === 0 && catalog.hasShard(id) && catalog.craftWeight(id, baseId) > 0));
    const affixes: Affix[] = [], owned: number[][] = [[], []], aliases: Record<number, string> = {};
    for (const { descriptor, row, target } of slots) {
      if (target) continue;
      const id = row.id ?? fresh(descriptor.side, row.tier, row.isExperimental);
      if (id === undefined) break;
      reserved.add(id);
      affixes.push({ id, tier: row.tier, slot: descriptor.slot, roll: null });
      if (row.id === null) aliases[id] = `未指定${row.isExperimental ? '实验' : ''}${descriptor.label}词条`;
      if (row.isTarget && descriptor.side !== null) owned[descriptor.side].push(id);
    }
    if (affixes.length !== slots.filter(s => !s.target).length) continue;
    const requirements: Requirement[] = [];
    if (draft.targetMode === 'SLOTS') {
      for (const { descriptor, row, target } of slots) {
        if (!target) continue;
        const ids = row.id !== null ? [row.id] : pool.filter(id => matchesSlot(id, descriptor.side, row.tier, undefined, catalog) &&
          (catalog.affix(id).special === 0 || affixes.some(a => a.id === id)));
        requirements.push({ ids, minTier: row.tier, ...(row.tier === 7 ? { maxTier: 7 } : {}), slot: descriptor.slot });
      }
    } else {
      for (const side of [0, 1] as const) {
        const label = side === 0 ? '前缀' : '后缀';
        for (let goal = 0; goal < draft.counts[side].desired; goal++) {
          const existing = owned[side][goal], id = existing ?? fresh(side, 7);
          if (id === undefined) break;
          reserved.add(id);
          aliases[id] = `${existing === undefined ? '待补' : '已有'}目标${label}${goal + 1}`;
          requirements.push({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' });
        }
      }
      if (requirements.length !== draft.counts[0].desired + draft.counts[1].desired) continue;
    }
    // Experimental states track the surviving identity in addition to four ordinary tiers.
    const milliseconds = mode !== 'CONCRETE_WEIGHTED' && experiment ? 90000 : 12000;
    const request: PlanRequest = { modelId: MODEL_ID, inputModel: mode, ...(draft.initialFp === undefined ? {} : { initialFp: draft.initialFp }),
      item: { baseId, itemLevel: 100, fpType: draft.fpType, corrupted: false, affixes }, craftingContext: { playerLevel },
      target: { requirements }, constraints: {}, scoring: {}, search: { milliseconds, maxRoutes: 4096, macroStages: 12, maxStates: 25000 } };
    const parsed = parsePlanRequest(request, catalog);
    if (parsed.request) {
      let condition = '';
      if (mode === 'AVERAGE_EQUAL') {
        const [prefix, suffix] = poolSizes(catalog, baseId);
        condition = `任意 · 平均词缀池（前缀${prefix}／后缀${suffix}）`;
      } else if (any) condition = `任意 · 兼容底材参考（${catalog.base(baseId).name}）`;
      scenarios.push({ key: baseId, condition, part, baseIds, aliases, request: parsed.request });
    } else if (!failures.length) failures.push(...parsed.issues);
  }
  if (any && mode === 'CONCRETE_WEIGHTED' && scenarios.length > 1) {
    const valid = new Set(scenarios.map(scenario => scenario.key));
    const closest = closestPoolGroup(catalog, groups.filter(group => valid.has(group.baseId)))!;
    const chosen = scenarios.find(scenario => scenario.key === closest.baseId)!;
    scenarios.splice(0, scenarios.length, chosen);
  }
  if (!scenarios.length) {
    if (failures.length) issues.push(...failures);
    else fail('找不到能同时满足这些词条与栏位的同一装备，请调整部位或词条。');
  }
  return result();
}
