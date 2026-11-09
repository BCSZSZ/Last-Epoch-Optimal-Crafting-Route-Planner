import { Catalog, snapshot } from './catalog';
import type { Model } from './catalog';
import type { InputModel, Item } from './types';

const derived = new Map<InputModel, Catalog>();
export const ANY_BASE_ID = 'reference:any-equipment';
export const AVERAGE_BASE_ID = 'reference:average-equipment';
export const AVERAGE_EXPERIMENT_BASE_ID = 'reference:average-experimental-equipment';

export interface BaseGroup {
  readonly part: number;
  readonly baseId: string;
  readonly baseIds: string[];
}

export function ordinaryBaseGroups(catalog: Catalog): BaseGroup[] {
  const groups = new Map<string, BaseGroup>();
  for (const base of catalog.model.bases) {
    if (!base.ordinaryEquipment || base.corrupted || base.obsolete || base.legacy || base.levelRequirement > 100) continue;
    // At L100, these fields determine crafting equivalence between real bases.
    const key = JSON.stringify([base.baseType, base.equipmentType, base.classRequirement, base.maxAffixes,
      [29, 30].includes(base.equipmentType) ? base.subType : null]);
    const group = groups.get(key);
    if (group) group.baseIds.push(base.id);
    else groups.set(key, { part: base.baseType, baseId: base.id, baseIds: [base.id] });
  }
  return [...groups.values()].sort((a, b) => a.part - b.part);
}

export function poolSizes(catalog: Catalog, baseId: string): [number, number] {
  const empty: Item = { baseId, affixes: [], fpType: 'NORMAL', corrupted: false, itemLevel: 100 };
  return [catalog.rerollPool(empty, 0).length, catalog.rerollPool(empty, 1).length];
}

function poolReference(catalog: Catalog, groups: readonly BaseGroup[]) {
  const parts = new Map<number, { prefix: number; suffix: number; count: number }>();
  const sizes = groups.map(group => {
    const size = poolSizes(catalog, group.baseId);
    const part = parts.get(group.part) ?? { prefix: 0, suffix: 0, count: 0 };
    part.prefix += size[0] * group.baseIds.length;
    part.suffix += size[1] * group.baseIds.length;
    part.count += group.baseIds.length;
    parts.set(group.part, part);
    return size;
  });
  let prefix = 0, suffix = 0;
  for (const row of parts.values()) { prefix += row.prefix / row.count; suffix += row.suffix / row.count; }
  return { prefix: prefix / parts.size, suffix: suffix / parts.size, sizes };
}

export function closestPoolGroup(catalog: Catalog, groups: readonly BaseGroup[]): BaseGroup | undefined {
  if (groups.length <= 1) return groups[0];
  const { prefix, suffix, sizes } = poolReference(catalog, groups);
  const distance = ([p, s]: [number, number]) => ((p-prefix)/Math.max(1,prefix))**2 + ((s-suffix)/Math.max(1,suffix))**2;
  let best = 0;
  for (let i = 1; i < groups.length; i++) if (distance(sizes[i]) < distance(sizes[best])) best = i;
  return groups[best];
}

function averageCatalog(source: Model): Catalog {
  const concrete = new Catalog(source), groups = ordinaryBaseGroups(concrete);
  const experimental = source.affixes.filter(a => a.special === 1 && a.side === 0 && a.tiers.length >= 7);
  const specs = [
    { id: AVERAGE_BASE_ID, type: -10, name: '任意 · 平均词缀池', groups },
    { id: AVERAGE_EXPERIMENT_BASE_ID, type: -11, name: '任意 · 实验装备平均词缀池',
      groups: groups.filter(group => experimental.some(a => concrete.canRollOn(a.id, group.baseId))) },
  ].filter(spec => spec.groups.length).map(spec => {
    const { prefix, suffix } = poolReference(concrete, spec.groups);
    return { ...spec, counts: [Math.round(prefix), Math.round(suffix)] };
  });
  const affixes: Model['affixes'] = [];
  for (const side of [0, 1] as const) {
    const template = source.affixes.find(a => a.side === side && a.special === 0 && a.rollsOn === 0 && a.tiers.length >= 7);
    if (!template) throw new Error('平均词缀池缺少普通词缀定义');
    const maximum = Math.max(0, ...specs.map(spec => spec.counts[side]));
    for (let i = 0; i < maximum; i++) affixes.push({
      ...template, id: 60000 + 1000 * side + i, name: `参考${side ? '后缀' : '前缀'}${i + 1}`,
      canRollOn: specs.filter(spec => i < spec.counts[side]).map(spec => spec.type),
      classSpecificity: 0, levelRequirement: 0, weight: 1, overrides: [],
    });
  }
  const experimentalSpec = specs.find(spec => spec.id === AVERAGE_EXPERIMENT_BASE_ID);
  if (experimentalSpec) affixes.push({
    ...experimental[0], id: 62000, name: '参考实验前缀', canRollOn: [experimentalSpec.type],
    classSpecificity: 0, levelRequirement: 0, weight: 0, overrides: [],
  });
  return new Catalog({ ...source, affixes,
    bases: specs.map(spec => ({ id: spec.id, baseType: -1, equipmentType: spec.type, subType: 0,
      name: spec.name, typeName: spec.name, classRequirement: 0, subClassRequirement: 0, levelRequirement: 0,
      maxAffixes: 4, ordinaryEquipment: true, corrupted: false, obsolete: false, legacy: false })),
    rngModel: 'AVERAGE_COMPATIBLE_POOL_COUNTS_V1',
    qualification: 'Rounded part-balanced mean legal prefix and suffix pool sizes; anonymous identities only.',
  });
}

export function isConcreteModel(mode: unknown): mode is 'CONCRETE_EQUAL' | 'CONCRETE_WEIGHTED' {
  return mode === 'CONCRETE_EQUAL' || mode === 'CONCRETE_WEIGHTED';
}

export function readInputModel(value: unknown): InputModel {
  const mode = value && typeof value === 'object' && 'inputModel' in value ? value.inputModel : undefined;
  return isConcreteModel(mode) || mode === 'AVERAGE_EQUAL' || mode === 'FORGEABLE_WEIGHTED' || mode === 'FORGEABLE_EQUAL' || mode === 'FORGEABLE_ANY_EQUAL' ? mode : 'AUDITED';
}

/** Explicit user-input assumptions; audited snapshot remains immutable and is never relabelled as an exact item pool. */
export function catalogForInputModel(mode: InputModel = 'AUDITED', source: Model = snapshot): Catalog {
  if (mode === 'AUDITED') return new Catalog(source);
  const found = source === snapshot ? derived.get(mode) : undefined; if (found) return found;
  if (mode === 'AVERAGE_EQUAL') {
    const catalog = averageCatalog(source);
    if (source === snapshot) derived.set(mode, catalog);
    return catalog;
  }
  if (mode === 'FORGEABLE_ANY_EQUAL') {
    const equipmentTypes = new Set(source.bases.filter(base => base.ordinaryEquipment && !base.corrupted && !base.obsolete && !base.legacy).map(base => base.equipmentType));
    const model: Model = { ...source,
      bases: [{ id: ANY_BASE_ID, baseType: -1, equipmentType: -1, subType: 0, name: '任意装备（通用等权参考）',
        typeName: 'Any equipment reference', classRequirement: 31, subClassRequirement: 0, levelRequirement: 0,
        maxAffixes: 4, ordinaryEquipment: true, corrupted: false, obsolete: false, legacy: false }],
      affixes: source.affixes.map(row => {
        const allowed = row.canRollOn.filter(type => equipmentTypes.has(type));
        const positive = allowed.some(type => (row.overrides.find(entry => entry.equipmentType === type)?.weight ?? row.weight) > 0);
        return { ...row, canRollOn: allowed.length ? [-1] : [], weight: positive ? 1 : 0, overrides: [] };
      }),
      rngModel: 'ANY_EQUIPMENT_ALL_CLASSES_EQUAL_POSITIVE_UNION_V1',
      qualification: 'Unspecified equipment reference: union of ordinary equipment candidates, each positive candidate equal. Not an average over equipment or a concrete item pool.',
    };
    const catalog = new Catalog(model); if (source === snapshot) derived.set(mode, catalog); return catalog;
  }
  const equal = mode === 'FORGEABLE_EQUAL' || mode === 'CONCRETE_EQUAL';
  const model: Model = { ...source,
    bases: isConcreteModel(mode) ? source.bases : source.bases.map((base) => ({ ...base, classRequirement: 31 })),
    affixes: equal ? source.affixes.map((row) => ({ ...row,
      weight: row.weight > 0 ? 1 : 0,
      overrides: row.overrides.map((entry) => ({ ...entry, weight: entry.weight > 0 ? 1 : 0 })),
    })) : source.affixes,
    rngModel: isConcreteModel(mode) ? (equal ? 'CONCRETE_BASE_EQUAL_POSITIVE_CANDIDATES_V1' : source.rngModel) :
      (equal ? 'ITEM_TYPE_ALL_CLASSES_EQUAL_POSITIVE_CANDIDATES_V1' : 'ITEM_TYPE_ALL_CLASSES_AUDITED_WEIGHTS_V1'),
    qualification: isConcreteModel(mode) ? 'Concrete base and class eligibility at L100; named identities retain native weights.' :
      'Historical reference: all-class item-type pool; anonymous input uses equal positive candidate weights.',
  };
  const catalog = new Catalog(model); if (source === snapshot) derived.set(mode, catalog); return catalog;
}
