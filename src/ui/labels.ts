import type { Catalog } from '../core/catalog';
import type { Macro, Predicate, Requirement, Selector } from '../core/types';

const affixNames: Record<number, string> = { 1: '护甲', 2: '近战攻击速度', 4: '施法速度', 5: '暴击几率',
  7: '虚空抗性', 8: '闪避值', 10: '腐化抗性', 26: '召唤物伤害',
  501: '力量', 502: '智力', 503: '敏捷', 504: '协调', 505: '体质' };
const typeNames: Record<number, string> = { 0: '头盔', 1: '胸甲', 2: '腰带', 3: '鞋子', 4: '手套', 5: '单手斧',
  6: '匕首', 7: '单手钉锤', 8: '权杖', 9: '单手剑', 10: '魔杖', 12: '双手斧', 13: '双手钉锤',
  14: '长矛', 15: '法杖', 16: '双手剑', 17: '箭袋', 18: '盾牌', 19: '法器', 20: '护身符', 21: '戒指', 22: '遗物', 23: '弓' };

export const slotNames = { ordinary: '普通未封印栏', sealed: '普通封印槽', primordial: '先古T8槽', corrupted: '腐化槽', any: '任意槽位' };
export const fpNames = { NORMAL: '普通潜能', ICE: '冰潜能', BLOOD: '血潜能' };
export const actionNames = { add: '添加词缀', upgrade: '普通升级', seal: '绝望封印', chaos: '混沌', havoc: '浩劫', redemption: '救赎', removal: '剥离' };
export const typeName = (id: number, fallback: string) => typeNames[id] ?? fallback;
export type NameAliases = Readonly<Record<number, string>>;
export const affixName = (catalog: Catalog, id: number, aliases: NameAliases = {}) => aliases[id] ?? affixNames[id] ?? (catalog.hasAffix(id) ? catalog.affix(id).name : `未知ID ${id}`);
export const affixLabel = (catalog: Catalog, id: number) => `${affixName(catalog, id)} · #${id}`;

function glyph(value: string): string { return value === 'order' ? '（秩序）' : value === 'none' ? '（不用希望）' : ''; }
export function requirementText(requirement: Requirement, catalog: Catalog, aliases: NameAliases = {}): string {
  const sides = new Set(requirement.ids.map((id) => catalog.side(id)));
  const ids = requirement.ids.length > 8 ? `符合目标的${sides.size === 1 ? sides.has(0) ? '前缀' : '后缀' : '词条'}` :
    requirement.ids.map((id) => affixName(catalog, id, aliases)).join('／');
  const tier = requirement.maxTier === requirement.minTier ? `恰好T${requirement.minTier}` :
    requirement.maxTier !== undefined && requirement.maxTier < 8 ? `T${requirement.minTier}–T${requirement.maxTier}` : `至少T${requirement.minTier}`;
  return `${ids}（${tier}，${slotNames[requirement.slot]}${requirement.minRollByte === undefined ? '' : `，原始roll≥${requirement.minRollByte}`}）`;
}

export function selectorText(selector: Selector, catalog: Catalog, aliases: NameAliases = {}): string {
  const side = selector.side === 0 ? '前缀' : selector.side === 1 ? '后缀' : '普通词缀';
  const identity = selector.ids?.length && selector.ids.length <= 8 ? selector.ids.map((id) => affixName(catalog, id, aliases)).join('／') : `${selector.excludedIds?.length ? '非目标' : ''}${side}`;
  const tier = selector.minTier !== undefined && selector.maxTier === selector.minTier ? `T${selector.minTier}` :
    selector.maxTier !== undefined ? `T${selector.minTier ?? 1}–T${selector.maxTier}` : '';
  return `${identity}${tier ? `（${tier}）` : ''}`;
}

export function predicateText(predicate: Predicate, catalog: Catalog, aliases: NameAliases): string {
  if (predicate.kind === 'any' || predicate.kind === 'all') return predicate.predicates.map((part) => predicateText(part, catalog, aliases)).join(predicate.kind === 'any' ? '，或' : '，且');
  if (predicate.kind === 'target') return '完整目标达成';
  if (predicate.kind === 'exists') return `出现${selectorText(predicate.selector, catalog, aliases)}`;
  if (predicate.kind === 'count') return `至少${predicate.minimum}条${selectorText(predicate.selector, catalog, aliases)}`;
  if (predicate.kind === 'requirements') return predicate.requirements.map((row) => requirementText(row, catalog, aliases)).join('，且');
  if (predicate.requirement.minTier === 1 && (predicate.requirement.maxTier ?? 8) === 8 && predicate.requirement.minRollByte === undefined) return `取得${predicate.requirement.ids.map((id) => affixName(catalog, id, aliases)).join('／')}`;
  return requirementText(predicate.requirement, catalog, aliases);
}

export function macroText(macro: Macro, catalog: Catalog, aliases: NameAliases = {}): { title: string; condition: string } {
  if (macro.kind === 'conditional') return { title: '按词缀情况分支',
    condition: `成立时：${macro.then.map((part) => macroText(part, catalog, aliases).title).join(' → ') || '跳过'}；否则：${macro.otherwise?.map((part) => macroText(part, catalog, aliases).title).join(' → ') || '跳过'}。` };
  if (macro.kind === 'fill') return { title: '补词', condition: '补满普通槽；已有四条则跳过。' };
  if (macro.kind === 'seal') return { title: '封印', condition: selectorText(macro.selector, catalog, aliases) };
  if (macro.kind === 'removal') return { title: `剥离${glyph(macro.glyph)}`, condition: `仅接受${selectorText(macro.accepted, catalog, aliases)}` };
  if (macro.kind === 'upgrade') return { title: `升级${glyph(macro.glyph)}`, condition: `${affixName(catalog, macro.id, aliases)}至T${macro.tier}；已满足则跳过。` };
  if (macro.kind === 'chaos') return { title: '混沌直至命中目标', condition: `${requirementText(macro.until, catalog, aliases)}；${macro.prepareWithHavoc ? '需要时浩劫恢复低阶窗口；' : ''}${macro.onExhausted === 'CONTINUE' ? '耗尽后进入后续补救。' : '窗口耗尽即停止。'}` };
  if (macro.kind === 'repeat') return { title: `${actionNames[macro.action.kind]}直至${macro.until.kind === 'target' ? '目标达成' : predicateText(macro.until, catalog, aliases)}${'glyph' in macro.action ? glyph(macro.action.glyph) : ''}`,
    condition: macro.action.kind === 'redemption' ? '每次完整重抽后检查。' : '' };
  const action = macro.action;
  return { title: `${action.kind === 'seal' ? '封印' : actionNames[action.kind]}${'glyph' in action ? glyph(action.glyph) : ''}`,
    condition: 'id' in action ? affixName(catalog, action.id, aliases) : action.kind === 'removal' ? `仅接受${action.acceptedIds.map((id) => affixName(catalog, id, aliases)).join('、')}` : '' };
}

export const failureNames: Record<string, string> = { FP_EXHAUSTED: '潜能耗尽', REQUIRED_SEAL_FAILED: '必要封印失败',
  UNACCEPTED_REMOVAL: '剥离未命中允许对象', ROUTE_EXHAUSTED: '路线结束仍未达标', INAPPLICABLE_NEXT_STAGE: '下一阶段条件不满足',
  PROTECTION_RISK: '动作可能违反保护', PLAYER_LEVEL_TOO_LOW: '角色等级不足', NO_LEGAL_SLOT: '没有合法空栏',
  DUPLICATE_ID: '已有目标ID，不能再次添加', MAX_CRAFTABLE_TIER: '达到普通升级上限', SEALED_SLOT_OCCUPIED: '封印槽已占用',
  NO_ORDINARY_TARGET: '缺少可操作的普通词缀', ACTION_DISABLED: '动作已被禁用', NO_AFFIX_SHARD: '该词缀没有碎片',
  OPERATION_LIMIT: '达到显式操作次数上限', NO_EXALTED_TARGET: '没有可救赎的崇高词缀', HAVOC_INAPPLICABLE: '不满足浩劫资格',
  IDENTICAL_TIERS: '普通词缀阶数全相同', INCOMPATIBLE_AFFIX: '词缀不符合制作资格' };
