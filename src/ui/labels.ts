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
export const affixName = (catalog: Catalog, id: number) => affixNames[id] ?? (catalog.hasAffix(id) ? catalog.affix(id).name : `未知ID ${id}`);
export const affixLabel = (catalog: Catalog, id: number) => `${affixName(catalog, id)} · #${id}`;

function glyph(value: string): string { return value === 'hope' ? '，配希望雕文' : value === 'order' ? '，配秩序雕文' : ''; }
export function requirementText(requirement: Requirement, catalog: Catalog): string {
  const ids = requirement.ids.map((id) => affixName(catalog, id)).join('／');
  const tier = requirement.maxTier === requirement.minTier ? `恰好T${requirement.minTier}` : `至少T${requirement.minTier}`;
  return `${ids}（${tier}，${slotNames[requirement.slot]}${requirement.minRollByte === undefined ? '' : `，原始roll≥${requirement.minRollByte}`}）`;
}

export function selectorText(selector: Selector, catalog: Catalog): string {
  const side = selector.side === 0 ? '前缀' : selector.side === 1 ? '后缀' : '普通词缀';
  const identity = selector.ids?.length ? selector.ids.map((id) => affixName(catalog, id)).join('／') : `${side}中符合条件的词缀`;
  const tier = selector.minTier !== undefined && selector.maxTier === selector.minTier ? `T${selector.minTier}` :
    selector.maxTier !== undefined ? `T${selector.minTier ?? 1}–T${selector.maxTier}` : '';
  const exclude = selector.excludedIds?.length ? `，排除${selector.excludedIds.map((id) => affixName(catalog, id)).join('／')}` : '';
  return `${tier}${identity}${selector.sealable ? '（须可封印）' : ''}${exclude}`;
}

function predicateText(predicate: Predicate, catalog: Catalog): string {
  if (predicate.kind === 'target') return '完整目标达成';
  if (predicate.kind === 'exists') return `出现${selectorText(predicate.selector, catalog)}`;
  if (predicate.kind === 'requirements') return predicate.requirements.map((row) => requirementText(row, catalog)).join('，且');
  return requirementText(predicate.requirement, catalog);
}

export function macroText(macro: Macro, catalog: Catalog): { title: string; condition: string } {
  if (macro.kind === 'seal') return { title: `封印一次：${selectorText(macro.selector, catalog)}`, condition: '按当前原生顺序选择第一个合法对象；必要封印失败后立即终止整条路线。' };
  if (macro.kind === 'removal') return { title: `剥离一次${glyph(macro.glyph)}`, condition: `仅允许移除${selectorText(macro.accepted, catalog)}；命中其他词缀，完整结算后立即终止。` };
  if (macro.kind === 'upgrade') return { title: `升级${affixName(catalog, macro.id)}至T${macro.tier}${glyph(macro.glyph)}`, condition: '已满足此阶数时跳过；达到局部目标或无合法制作机会时退出。' };
  if (macro.kind === 'chaos') return { title: `用混沌升级${selectorText(macro.selector, catalog)}`, condition: `直到${requirementText(macro.until, catalog)}；每次使用同一选择规则，无可升对象时停止。` };
  if (macro.kind === 'repeat') return { title: `反复使用${actionNames[macro.action.kind]}${'glyph' in macro.action ? glyph(macro.action.glyph) : ''}`,
    condition: `直到${predicateText(macro.until, catalog)}。${macro.action.kind === 'redemption' ? '每次会重抽全部未封印崇高词缀，在完整动作结束后检查。' : ''}潜能耗尽或动作不再合法时停止。` };
  const action = macro.action;
  return { title: `${actionNames[action.kind]}${'id' in action ? `：${affixName(catalog, action.id)}` : '一次'}${'glyph' in action ? glyph(action.glyph) : ''}`,
    condition: action.kind === 'seal' ? '封印失败立即终止整条路线。' : action.kind === 'removal' ? `只接受ID：${action.acceptedIds.join('、')}，失手立即停止。` : '完整结算后进入下一阶段；全部目标提前达成时直接结束。' };
}

export const failureNames: Record<string, string> = { FP_EXHAUSTED: '潜能耗尽', REQUIRED_SEAL_FAILED: '必要封印失败',
  UNACCEPTED_REMOVAL: '剥离未命中允许对象', ROUTE_EXHAUSTED: '路线结束仍未达标', INAPPLICABLE_NEXT_STAGE: '下一阶段条件不满足',
  PROTECTION_RISK: '动作可能违反保护', PLAYER_LEVEL_TOO_LOW: '角色等级不足', NO_LEGAL_SLOT: '没有合法空栏',
  DUPLICATE_ID: '已有目标ID，不能再次添加', MAX_CRAFTABLE_TIER: '达到普通升级上限', SEALED_SLOT_OCCUPIED: '封印槽已占用',
  NO_ORDINARY_TARGET: '缺少可操作的普通词缀', ACTION_DISABLED: '动作已被禁用', NO_AFFIX_SHARD: '该词缀没有碎片',
  OPERATION_LIMIT: '达到显式操作次数上限', NO_EXALTED_TARGET: '没有可救赎的崇高词缀', HAVOC_INAPPLICABLE: '不满足浩劫资格',
  IDENTICAL_TIERS: '普通词缀阶数全相同', INCOMPATIBLE_AFFIX: '词缀不符合制作资格' };
