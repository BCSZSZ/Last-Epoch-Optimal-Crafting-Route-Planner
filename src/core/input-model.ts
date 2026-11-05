import { Catalog, snapshot } from './catalog';
import type { Model } from './catalog';
import type { InputModel } from './types';

const derived = new Map<InputModel, Catalog>();
export const ANY_BASE_ID = 'reference:any-equipment';
export function readInputModel(value: unknown): InputModel {
  const mode = value && typeof value === 'object' && 'inputModel' in value ? value.inputModel : undefined;
  return mode === 'FORGEABLE_WEIGHTED' || mode === 'FORGEABLE_EQUAL' || mode === 'FORGEABLE_ANY_EQUAL' ? mode : 'AUDITED';
}

/** Explicit user-input assumptions; audited snapshot remains immutable and is never relabelled as an exact item pool. */
export function catalogForInputModel(mode: InputModel = 'AUDITED', source: Model = snapshot): Catalog {
  if (mode === 'AUDITED') return new Catalog(source);
  const found = source === snapshot ? derived.get(mode) : undefined; if (found) return found;
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
  const model: Model = { ...source,
    bases: source.bases.map((base) => ({ ...base, classRequirement: 31 })),
    affixes: mode === 'FORGEABLE_EQUAL' ? source.affixes.map((row) => ({ ...row,
      weight: row.weight > 0 ? 1 : 0,
      overrides: row.overrides.map((entry) => ({ ...entry, weight: entry.weight > 0 ? 1 : 0 })),
    })) : source.affixes,
    rngModel: mode === 'FORGEABLE_EQUAL' ? 'ITEM_TYPE_ALL_CLASSES_EQUAL_POSITIVE_CANDIDATES_V1' : 'ITEM_TYPE_ALL_CLASSES_AUDITED_WEIGHTS_V1',
    qualification: 'Assume forgeable, player/item level100, all-class item-type pool; anonymous input uses equal positive candidate weights. Not an exact unknown item pool.',
  };
  const catalog = new Catalog(model); if (source === snapshot) derived.set(mode, catalog); return catalog;
}
