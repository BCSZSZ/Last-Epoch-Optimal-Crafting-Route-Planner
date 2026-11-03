import { MODEL_ID } from './catalog';
import type { Catalog } from './catalog';
import { catalogForInputModel } from './input-model';
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
export interface DraftSlot { readonly tier: number; readonly id: number | null }
export type DraftSlots = Readonly<Record<DraftSlotKey, DraftSlot>>;
export interface GoalCounts { readonly desired: number; readonly owned: number; readonly ownedT7: number }
export interface CraftingDraft {
  readonly version: 2;
  readonly part: number | null;
  readonly fpType: FpType;
  readonly slots: DraftSlots;
  readonly targetMode: 'COUNTS' | 'SLOTS';
  readonly counts: readonly [GoalCounts, GoalCounts];
  readonly targetSlots: DraftSlots;
}
export interface DraftScenario {
  readonly key: string;
  readonly condition: string;
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
  const empty = (): DraftSlot => ({ tier: 0, id: null });
  return { prefix1: empty(), prefix2: empty(), suffix1: empty(), suffix2: empty(), sealed: empty() };
}
export function emptyDraft(): CraftingDraft {
  return { version: 2, part: null, fpType: 'NORMAL', slots: emptyDraftSlots(), targetMode: 'COUNTS',
    counts: [{ desired: 0, owned: 0, ownedT7: 0 }, { desired: 0, owned: 0, ownedT7: 0 }], targetSlots: emptyDraftSlots() };
}
export function draftBase(catalog: Catalog, part: number | null): string | null {
  return catalog.model.bases.find((base) => base.baseType === part && base.ordinaryEquipment && !base.corrupted && !base.obsolete && !base.legacy)?.id ?? null;
}
export function draftAffixPool(catalog: Catalog, part: number | null, side: 0 | 1 | null, tier = 1): readonly number[] {
  const base = draftBase(catalog, part); if (!base) return [];
  return catalog.model.affixes.filter((row) => [0, 1, 2].includes(row.special) && row.side < 2 && (side === null || row.side === side) &&
    row.tiers.length >= Math.max(1, tier) && catalog.canRollOn(row.id, base)).map((row) => row.id);
}

export function readDraft(value: unknown): CraftingDraft | null {
  const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const count = (x: unknown, upper: number) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= upper;
  if (!object(value) || value.version !== 2 || (value.part !== null && !count(value.part, 42)) ||
    !['NORMAL', 'ICE', 'BLOOD'].includes(String(value.fpType)) || !['COUNTS', 'SLOTS'].includes(String(value.targetMode))) return null;
  for (const slots of [value.slots, value.targetSlots]) {
    if (!object(slots)) return null;
    for (const descriptor of DRAFT_SLOTS) {
      const slot = slots[descriptor.key];
      if (!object(slot) || !count(slot.tier, 7) || (slot.id !== null && !count(slot.id, 65535))) return null;
    }
  }
  if (!Array.isArray(value.counts) || value.counts.length !== 2 || value.counts.some((row) => !object(row) ||
    !count(row.desired, 2) || !count(row.owned, 2) || !count(row.ownedT7, 2))) return null;
  return value as unknown as CraftingDraft;
}

function combinations(values: readonly number[], n: number): number[][] {
  if (n === 0) return [[]];
  return values.flatMap((value, index) => combinations(values.slice(index + 1), n - 1).map((rest) => [value, ...rest]));
}

/** UI contract: no base/level controls, optional identities, explicit reference model and finite role ambiguities. */
export function compileDraft(draft: CraftingDraft): CompiledDraft {
  if (!readDraft(draft)) return { scenarios: [], issues: [{ code: 'DRAFT_INPUT', message: '输入格式无效。' }], inputModel: 'FORGEABLE_EQUAL', assumptions: [] };
  const catalog = catalogForInputModel('FORGEABLE_WEIGHTED'), baseId = draftBase(catalog, draft.part);
  const issues: Issue[] = [], scenarios: DraftScenario[] = [];
  const fail = (message: string, path?: string) => issues.push({ code: 'DRAFT_INPUT', message, path });
  const anonymous = DRAFT_SLOTS.some(({ key }) => draft.slots[key].tier > 0 && draft.slots[key].id === null);
  const mode: InputModel = draft.targetMode === 'COUNTS' || anonymous ? 'FORGEABLE_EQUAL' : 'FORGEABLE_WEIGHTED';
  const assumptions = ['按可锻造前提计算；无需填写底材、角色等级或物品等级。',
    '词条池按所选部位的全职业通用范围；顺序采用前缀1、前缀2、后缀1、后缀2。',
    '未指定的起始词条按合法普通词条表示；详细目标中的指定身份视为尚未拥有，除非起始处明确填写。',
    mode === 'FORGEABLE_EQUAL' ? '未指定词条使用等权正权重候选池，结果为简化参考。' : '已填写的词条按实际制作权重计算；通用池不等于指定职业底材池。'];
  const result = (): CompiledDraft => ({ scenarios, issues, inputModel: mode, assumptions });
  if (!baseId) { fail('请选择装备部位。', 'part'); return result(); }
  const specificGoals = draft.targetMode === 'SLOTS' ? DRAFT_SLOTS.flatMap(({ key }) => draft.targetSlots[key].tier && draft.targetSlots[key].id !== null ? [draft.targetSlots[key].id!] : []) : [];
  for (const [source, slots] of [['起始', draft.slots], ['目标', draft.targetSlots]] as const) {
    if (source === '目标' && draft.targetMode !== 'SLOTS') continue;
    for (const descriptor of DRAFT_SLOTS) {
      const row = slots[descriptor.key]; if (!row.tier || row.id === null) continue;
      if (!draftAffixPool(catalog, draft.part, descriptor.side, row.tier).includes(row.id)) fail(`${source}${descriptor.label}的词条不适用于该部位或T级。`);
    }
  }
  if (issues.length) return result();
  const known = DRAFT_SLOTS.flatMap(({ key }) => draft.slots[key].tier && draft.slots[key].id !== null ? [draft.slots[key].id!] : []);
  const reserved = new Set([...known, ...specificGoals]);
  const fresh = (side: 0 | 1 | null, tier: number, used: Set<number>): number | undefined => draftAffixPool(catalog, draft.part, side, tier)
    .find((id) => !used.has(id) && catalog.affix(id).special === 0 && catalog.hasShard(id) && catalog.craftWeight(id, baseId) > 0);
  const affixes: Affix[] = [], slotIndex = new Map<DraftSlotKey, number>(), aliases: Record<number, string> = {};
  for (const descriptor of DRAFT_SLOTS) {
    const slot = draft.slots[descriptor.key]; if (!slot.tier) continue;
    const id = slot.id ?? fresh(descriptor.side, slot.tier, reserved);
    if (id === undefined) { fail(`无法为${descriptor.label}建立合法的未指定词条。`); return result(); }
    reserved.add(id); slotIndex.set(descriptor.key, affixes.length);
    affixes.push({ id, tier: slot.tier, slot: descriptor.slot, roll: null });
    if (slot.id === null) aliases[id] = `未指定${descriptor.label}词条`;
  }
  const addScenario = (requirements: readonly Requirement[], names: Record<number, string>, condition: string, key: string) => {
    const request: PlanRequest = { modelId: MODEL_ID, inputModel: mode,
      item: { baseId, itemLevel: 100, fpType: draft.fpType, corrupted: false, affixes }, craftingContext: { playerLevel: 100 },
      target: { requirements }, constraints: {}, scoring: {}, search: { milliseconds: 12000, maxRoutes: 48, macroStages: 12, maxStates: 25000 } };
    const parsed = parsePlanRequest(request, catalogForInputModel(mode));
    if (!parsed.request) { issues.push(...parsed.issues); return; }
    scenarios.push({ key, condition, aliases: names, request });
  };
  if (draft.targetMode === 'SLOTS') {
    const requirements = DRAFT_SLOTS.flatMap((descriptor): Requirement[] => {
      const slot = draft.targetSlots[descriptor.key]; if (!slot.tier) return [];
      return [{ ids: slot.id === null ? draftAffixPool(catalog, draft.part, descriptor.side, slot.tier) : [slot.id], minTier: slot.tier,
        ...(slot.tier === 7 ? { maxTier: 7 } : {}), slot: descriptor.slot }];
    });
    if (!requirements.length) fail('请至少设置一项目标T级。', 'targetSlots');
    else addScenario(requirements, { ...aliases }, '', 'detailed');
  } else {
    if (!draft.counts.some((row) => row.desired > 0)) { fail('请设置所需的目标前缀数或后缀数。', 'counts'); return result(); }
    const assignments = ([0, 1] as const).map((side) => {
      const counts = draft.counts[side], candidates = DRAFT_SLOTS.filter((row) => row.slot === 'ordinary' && row.side === side);
      const seven = candidates.flatMap((row) => draft.slots[row.key].tier === 7 ? [slotIndex.get(row.key)!] : []);
      const low = candidates.flatMap((row) => draft.slots[row.key].tier > 0 && draft.slots[row.key].tier < 7 ? [slotIndex.get(row.key)!] : []);
      if (counts.owned > counts.desired || counts.ownedT7 > counts.owned || counts.ownedT7 > seven.length || counts.owned - counts.ownedT7 > low.length) {
        fail(`${side === 0 ? '前缀' : '后缀'}的已有目标数量与起始槽位不一致。`, `counts.${side}`); return [];
      }
      return combinations(seven, counts.ownedT7).flatMap((high) => combinations(low, counts.owned - counts.ownedT7).map((lower) => [...high, ...lower].sort((a, b) => a - b)));
    });
    if (issues.length) return result();
    for (const prefix of assignments[0]) for (const suffix of assignments[1]) {
      const selected = [prefix, suffix], used = new Set(affixes.map((row) => row.id)), names = { ...aliases }, requirements: Requirement[] = [], conditions: string[] = [];
      for (const side of [0, 1] as const) {
        const label = side === 0 ? '前缀' : '后缀';
        for (let goal = 0; goal < draft.counts[side].desired; goal++) {
          const index = selected[side][goal], id = index === undefined ? fresh(side, 7, used) : affixes[index].id;
          if (id === undefined) { fail('该部位没有足够的合法目标词条。'); return result(); }
          used.add(id); names[id] = `${index === undefined ? '待补' : '已有'}目标${label}${goal + 1}`;
          requirements.push({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' });
        }
        if (assignments[side].length > 1) {
          const positions = selected[side].map((index) => DRAFT_SLOTS.find((row) => slotIndex.get(row.key) === index)!.label).join('、');
          conditions.push(`已有目标位于${positions}`);
        }
      }
      addScenario(requirements, names, conditions.join('；'), `count-${prefix.join('-')}-${suffix.join('-')}`);
    }
    if (scenarios.length > 1) {
      const milliseconds = Math.max(1000, Math.floor(12000 / scenarios.length));
      for (let i = 0; i < scenarios.length; i++) scenarios[i] = { ...scenarios[i], request: { ...scenarios[i].request, search: { ...scenarios[i].request.search, milliseconds } } };
      assumptions.push('同侧已有目标位置不唯一，分别计算各个符合数量的结构，不假定某种分布。');
    }
  }
  if (issues.length) return { ...result(), scenarios: [] };
  return result();
}
