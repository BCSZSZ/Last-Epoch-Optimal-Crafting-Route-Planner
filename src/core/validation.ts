import { Catalog, ordinary } from './catalog';
import type { CraftingContext, Issue, Item, PlanRequest, Requirement } from './types';
import { targetReached } from './target';

export function validateItem(item: Item, context: CraftingContext, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const error = (code: string, message: string, path?: string) => issues.push({ code, message, path });
  if (!catalog.hasBase(item.baseId)) { error('UNKNOWN_BASE', '找不到指定底材', 'item.baseId'); return issues; }
  const base = catalog.base(item.baseId);
  if (!base.ordinaryEquipment) error('UNSUPPORTED_ITEM_TYPE', '当前规划对象必须是普通装备底材');
  if (!['NORMAL', 'ICE', 'BLOOD'].includes(item.fpType)) error('INVALID_FP_TYPE', '未知潜能类型');
  if (!Number.isInteger(item.itemLevel) || item.itemLevel < 1 || item.itemLevel > 100) error('INVALID_ITEM_LEVEL', '物品等级需为1至100');
  if (!Number.isInteger(context.playerLevel) || context.playerLevel < 1 || context.playerLevel > 100) error('INVALID_PLAYER_LEVEL', '角色等级需为1至100');
  if (new Set(item.affixes.map((row) => row.id)).size !== item.affixes.length) error('DUPLICATE_AFFIX_ID', '同一装备不能重复使用词缀ID');
  const counts = { ordinary: 0, sealed: 0, primordial: 0, corrupted: 0 };
  const sides = [0, 0, 0];
  for (const [index, row] of item.affixes.entries()) {
    const path = `item.affixes.${index}`;
    if (!catalog.hasAffix(row.id)) { error('UNKNOWN_AFFIX', `未知词缀ID：${row.id}`, path); continue; }
    if (!(row.slot in counts)) { error('INVALID_SLOT', '未知词缀槽位', path); continue; }
    counts[row.slot]++;
    if (row.slot === 'ordinary') sides[catalog.side(row.id)]++;
    if (!Number.isInteger(row.tier) || row.tier < 1 || row.tier > catalog.affix(row.id).tiers.length) error('INVALID_TIER', '阶数超出该词缀定义', path);
    if (row.slot === 'ordinary' && row.tier > 7) error('ORDINARY_T8', 'T8必须位于独立先古槽', path);
    if (row.slot === 'primordial' && row.tier !== 8) error('PRIMORDIAL_NOT_T8', '先古槽必须是T8', path);
    if (row.roll !== null && (!Number.isInteger(row.roll) || row.roll < 0 || row.roll > 255)) error('INVALID_ROLL_BYTE', '词缀原始roll需为0至255', path);
    if (row.slot === 'corrupted' && catalog.affix(row.id).special !== 6) error('INVALID_CORRUPTED_AFFIX', '腐化槽需使用腐化词缀类别', path);
    if (row.slot === 'ordinary' && catalog.affix(row.id).special > 2) error('UNSUPPORTED_ORDINARY_AFFIX', '该词缀类别不能作为普通装备栏输入', path);
  }
  if (counts.ordinary > 4 || sides[0] > 2 || sides[1] > 2) error('AFFIX_CAPACITY', '普通栏最多四条，前后缀各最多两条');
  if (counts.sealed > 1 || counts.primordial > 1 || counts.corrupted > 1) error('SEALED_CAPACITY', '每种附加槽最多一条');
  return issues;
}

function validateRequirement(row: Requirement, index: number, catalog: Catalog): Issue[] {
  const issues: Issue[] = [];
  const path = `target.requirements.${index}`;
  if (!row.ids.length || new Set(row.ids).size !== row.ids.length || row.ids.some((id) => !catalog.hasAffix(id))) {
    issues.push({ code: 'INVALID_TARGET_IDS', message: '目标需包含已知且不重复的可接受词缀ID', path });
  }
  if (!Number.isInteger(row.minTier) || row.minTier < 1 || row.minTier > 8 ||
      (row.maxTier !== undefined && (!Number.isInteger(row.maxTier) || row.maxTier < row.minTier || row.maxTier > 8))) {
    issues.push({ code: 'INVALID_TARGET_TIER', message: '目标阶数范围无效', path });
  }
  if (!['ordinary', 'sealed', 'primordial', 'corrupted', 'any'].includes(row.slot)) {
    issues.push({ code: 'INVALID_TARGET_SLOT', message: '目标槽位无效', path });
  }
  if (row.minRollByte !== undefined && (!Number.isInteger(row.minRollByte) || row.minRollByte < 0 || row.minRollByte > 255)) {
    issues.push({ code: 'INVALID_TARGET_ROLL', message: '目标原始roll下界需为0至255', path });
  }
  return issues;
}

export function validateRequest(request: PlanRequest, catalog: Catalog): Issue[] {
  const issues = validateItem(request.item, request.craftingContext, catalog);
  if (request.modelId !== catalog.model.modelId) issues.push({ code: 'MODEL_MISMATCH', message: '请求与计算模块的机制版本不一致' });
  if ((request.item.corrupted || (catalog.hasBase(request.item.baseId) && catalog.base(request.item.baseId).corrupted)) &&
      !targetReached(request.item, request.target)) {
    issues.push({ code: 'CORRUPTED_ITEM', message: '已腐化装备无法继续制作' });
  }
  if (!request.target.requirements.length) issues.push({ code: 'EMPTY_TARGET', message: '请至少指定一项目标' });
  request.target.requirements.forEach((row, i) => issues.push(...validateRequirement(row, i, catalog)));
  if ((request.target.requirements.some((row) => row.minRollByte !== undefined) || request.constraints.protected?.some((row) => row.roll)) &&
      request.item.affixes.some((row) => row.roll === null)) {
    issues.push({ code: 'UNKNOWN_INITIAL_ROLL', message: '计算roll目标或保护时需提供起始词缀的原始roll；不能对未知旧值假定均匀分布' });
  }
  const requiredTargets = request.target.requirements.filter((row) => !row.optional);
  if (requiredTargets.filter((row) => row.slot === 'ordinary').length > 4 ||
      ['sealed', 'primordial', 'corrupted'].some((slot) => requiredTargets.filter((row) => row.slot === slot).length > 1)) {
    issues.push({ code: 'TARGET_SLOT_CAPACITY', message: '目标数量超过相应槽位容量' });
  }
  for (const side of [0, 1]) {
    if (requiredTargets.filter((row) => row.slot === 'ordinary' && row.ids.length && row.ids.every((id) => catalog.hasAffix(id) && catalog.side(id) === side)).length > 2) {
      issues.push({ code: 'TARGET_SIDE_CAPACITY', message: '目标需要超过两条同侧普通词缀' });
    }
  }
  // Necessary distinct-ID matching; optional entries never make a request impossible.
  const owners = new Map<number, number>();
  const assign = (index: number, seen: Set<number>): boolean => {
    for (const id of requiredTargets[index].ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const previous = owners.get(id);
      if (previous === undefined || assign(previous, seen)) { owners.set(id, index); return true; }
    }
    return false;
  };
  if (requiredTargets.some((_, index) => !assign(index, new Set()))) {
    issues.push({ code: 'TARGET_ID_CONFLICT', message: '可接受ID集合无法分配给互不重复的目标词缀' });
  }
  const protectedIds = request.constraints.protected?.map((row) => row.id) ?? [];
  if (protectedIds.some((id) => !request.item.affixes.some((row) => row.id === id))) issues.push({ code: 'PROTECTED_ID_MISSING', message: '被保护词缀必须存在于起始装备中' });
  if (request.constraints.protected?.some((rule) => rule.roll && request.item.affixes.find((row) => row.id === rule.id)?.roll === null)) issues.push({ code: 'UNKNOWN_PROTECTED_ROLL', message: '保护roll时需提供该词缀的实际原始roll字节' });
  if (request.constraints.maxAttempts !== undefined && (!Number.isInteger(request.constraints.maxAttempts) || request.constraints.maxAttempts < 1)) issues.push({ code: 'INVALID_ATTEMPT_LIMIT', message: '显式操作次数上限必须为正整数' });
  const maximum = request.scoring.maximumFp ?? 63;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 63) issues.push({ code: 'INVALID_SCORING_DOMAIN', message: '评分域上界必须为1至63' });
  if (request.scoring.weights && (request.scoring.weights.length !== maximum ||
      request.scoring.weights.some((w) => !Number.isFinite(w) || w < 0) || request.scoring.weights.every((w) => w === 0))) {
    issues.push({ code: 'INVALID_SCORING_WEIGHTS', message: '每个预算需对应一个非负权重，且权重和须大于零' });
  }
  for (const [name, value] of Object.entries(request.search)) {
    if (!Number.isFinite(value) || value <= 0 || (name !== 'milliseconds' && !Number.isInteger(value))) issues.push({ code: 'INVALID_SEARCH_BUDGET', message: `搜索预算${name}必须为正数；数量上限须为整数` });
  }
  // A sound necessary condition: these operations cannot manufacture ordinary T6/T7 tiers.
  const required = request.target.requirements.filter((row) => !row.optional && row.slot === 'ordinary');
  for (const tier of [6, 7, 8]) {
    if (required.filter((row) => row.minTier >= tier).length > ordinary(request.item).filter((row) => row.tier >= tier).length) {
      issues.push({ code: 'UNREACHABLE_EXALTED_TIERS', message: `起始普通栏没有足够的T${tier}以上阶数；当前操作不能凭空生成它们` });
      break;
    }
  }
  return issues;
}
