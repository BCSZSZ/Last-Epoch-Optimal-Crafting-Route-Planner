import { MODEL_ID } from './catalog';
import type { Catalog } from './catalog';
import { ANY_BASE_ID, catalogForInputModel } from './input-model';
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
export interface DraftSlot { readonly tier: number; readonly id: number | null; readonly isTarget?: boolean }
export type DraftSlots = Readonly<Record<DraftSlotKey, DraftSlot>>;
export interface GoalCounts { readonly desired: number; readonly owned: number; readonly ownedT7: number }
export interface CraftingDraft {
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
export function draftBase(catalog: Catalog, part: number | null): string | null {
  if (part === null) return ANY_BASE_ID;
  return catalog.model.bases.find((base) => base.baseType === part && base.ordinaryEquipment && !base.corrupted && !base.obsolete && !base.legacy)?.id ?? null;
}
export function draftAffixPool(catalog: Catalog, part: number | null, side: 0 | 1 | null, tier = 1): readonly number[] {
  const source = part === null ? catalogForInputModel('FORGEABLE_ANY_EQUAL') : catalog;
  const base = draftBase(source, part); if (!base) return [];
  return source.model.affixes.filter((row) => [0, 1, 2].includes(row.special) && row.side < 2 && (side === null || row.side === side) &&
    row.tiers.length >= Math.max(1, tier) && source.canRollOn(row.id, base)).map((row) => row.id);
}

export function readDraft(value: unknown): CraftingDraft | null {
  const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const count = (x: unknown, upper: number) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= upper;
  if (!object(value) || value.version !== 2 && value.version !== 3 || (value.part !== null && !count(value.part, 42)) ||
    !['NORMAL', 'ICE', 'BLOOD'].includes(String(value.fpType)) || !['COUNTS', 'SLOTS'].includes(String(value.targetMode))) return null;
  for (const slots of [value.slots, value.targetSlots]) {
    if (!object(slots)) return null;
    for (const descriptor of DRAFT_SLOTS) {
      const slot = slots[descriptor.key];
      if (!object(slot) || !count(slot.tier, 7) || (slot.id !== null && !count(slot.id, 65535)) ||
        slot.isTarget !== undefined && typeof slot.isTarget !== 'boolean') return null;
      if (slot.isTarget && (slot.tier === 0 || descriptor.slot === 'sealed')) return null;
    }
  }
  if (!Array.isArray(value.counts) || value.counts.length !== 2 || value.counts.some((row) => !object(row) ||
    !count(row.desired, 2) || value.version === 2 && (!count(row.owned, 2) || !count(row.ownedT7, 2)))) return null;
  const copySlots = (input: unknown): DraftSlots => {
    const slots = input as Record<string, DraftSlot>;
    return Object.fromEntries(DRAFT_SLOTS.map(({ key }) => [key, { tier: slots[key].tier, id: slots[key].id, isTarget: slots[key].isTarget ?? false }])) as unknown as DraftSlots;
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
    slots, targetMode: value.targetMode as CraftingDraft['targetMode'], counts: [{ desired: value.counts[0].desired }, { desired: value.counts[1].desired }],
    targetSlots: copySlots(value.targetSlots), ...(pending.length ? { legacyOwnership: pending } : {}) };
}

export function ownedGoalCounts(draft: CraftingDraft, side: 0 | 1): GoalCounts {
  const slots = DRAFT_SLOTS.filter(row => row.side === side).map(row => draft.slots[row.key]).filter(row => row.tier > 0 && row.isTarget);
  return { desired: draft.counts[side].desired, owned: slots.length, ownedT7: slots.filter(row => row.tier === 7).length };
}

/** Membership is stored only on starting slots; editing an empty slot clears its membership. */
export function withDraftSlots(draft: CraftingDraft, slots: DraftSlots, confirmedSide?: 0 | 1): CraftingDraft {
  const { legacyOwnership, ...source } = draft;
  const clean = Object.fromEntries(DRAFT_SLOTS.map(row => [row.key, { ...slots[row.key],
    isTarget: row.slot === 'ordinary' && slots[row.key].tier > 0 && Boolean(slots[row.key].isTarget) }])) as unknown as DraftSlots;
  const next = { ...source, slots: clean }, pending = legacyOwnership?.filter(row => row.side !== confirmedSide) ?? [];
  return { ...next, counts: [{ desired: Math.max(draft.counts[0].desired, ownedGoalCounts(next, 0).owned) },
    { desired: Math.max(draft.counts[1].desired, ownedGoalCounts(next, 1).owned) }], ...(pending.length ? { legacyOwnership: pending } : {}) };
}

/** UI contract: no base/level controls, optional identities, explicit reference model and finite role ambiguities. */
export function compileDraft(draft: CraftingDraft): CompiledDraft {
  const parsedDraft = readDraft(draft);
  if (!parsedDraft) return { scenarios: [], issues: [{ code: 'DRAFT_INPUT', message: '输入格式无效。' }], inputModel: 'FORGEABLE_EQUAL', assumptions: [] };
  draft = parsedDraft;
  const catalog = catalogForInputModel(draft.part === null ? 'FORGEABLE_ANY_EQUAL' : 'FORGEABLE_WEIGHTED'), baseId = draftBase(catalog, draft.part);
  const issues: Issue[] = [], scenarios: DraftScenario[] = [];
  const fail = (message: string, path?: string) => issues.push({ code: 'DRAFT_INPUT', message, path });
  const anonymous = DRAFT_SLOTS.some(({ key }) => draft.slots[key].tier > 0 && draft.slots[key].id === null);
  const mode: InputModel = draft.part === null ? 'FORGEABLE_ANY_EQUAL' : draft.targetMode === 'COUNTS' || anonymous ? 'FORGEABLE_EQUAL' : 'FORGEABLE_WEIGHTED';
  const assumptions = ['按可锻造前提计算；无需填写底材、角色等级或物品等级。',
    draft.part === null ? '未指定装备：候选按全装备词条并集等权处理，不是全装备平均概率；指定部位后使用该部位词条池。' : '词条池按所选部位的全职业通用范围；顺序采用前缀1、前缀2、后缀1、后缀2。',
    '未指定的起始词条按合法普通词条表示；详细目标中的指定身份视为尚未拥有，除非起始处明确填写。',
    mode !== 'FORGEABLE_WEIGHTED' ? '未指定词条使用等权正权重候选池，结果为简化参考。' : '已填写的词条按实际制作权重计算；通用池不等于指定职业底材池。'];
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
  if (draft.part === null && known.length + specificGoals.length > 0) {
    const concrete = catalogForInputModel('FORGEABLE_WEIGHTED'), ids = [...known, ...specificGoals];
    if (!concrete.model.bases.some(base => base.ordinaryEquipment && !base.corrupted && !base.obsolete && !base.legacy && ids.every(id => concrete.canRollOn(id, base.id)))) {
      fail('所选具体词条无法同时出现在同一装备部位，请调整词条或指定装备部位。'); return result();
    }
  }
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
    if (draft.legacyOwnership?.length) { fail('旧输入未明确已有目标的位置，请在左侧勾选确认目标词缀。'); return result(); }
    const selected = ([0, 1] as const).map(side => DRAFT_SLOTS.filter(row => row.side === side && draft.slots[row.key].tier > 0 && draft.slots[row.key].isTarget)
      .map(row => slotIndex.get(row.key)!));
    for (const side of [0, 1] as const) if (selected[side].length > draft.counts[side].desired) fail(`${side === 0 ? '前缀' : '后缀'}目标T7数不能少于左侧勾选的目标词缀数。`);
    if (issues.length) return result();
    {
      const used = new Set(affixes.map((row) => row.id)), names = { ...aliases }, requirements: Requirement[] = [];
      for (const side of [0, 1] as const) {
        const label = side === 0 ? '前缀' : '后缀';
        for (let goal = 0; goal < draft.counts[side].desired; goal++) {
          const index = selected[side][goal], id = index === undefined ? fresh(side, 7, used) : affixes[index].id;
          if (id === undefined) { fail('该部位没有足够的合法目标词条。'); return result(); }
          used.add(id); names[id] = `${index === undefined ? '待补' : '已有'}目标${label}${goal + 1}`;
          requirements.push({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' });
        }
      }
      addScenario(requirements, names, '', `count-${selected[0].join('-')}-${selected[1].join('-')}`);
    }
  }
  if (issues.length) return { ...result(), scenarios: [] };
  return result();
}
