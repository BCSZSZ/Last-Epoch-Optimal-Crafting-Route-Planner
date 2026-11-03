import data from '../generated/model.json';
import type { Affix, Item, Side } from './types';
import { exact, Interval, ZERO } from './interval';

export type Model = typeof data;
export type AffixDefinition = Model['affixes'][number];
export type BaseDefinition = Model['bases'][number];

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export const snapshot = freeze(data);
export const MODEL_ID = snapshot.modelId;

export class Catalog {
  readonly model: Model;
  readonly #affixes: ReadonlyMap<number, AffixDefinition>;
  readonly #bases: ReadonlyMap<string, BaseDefinition>;
  readonly #pools = new Map<string, readonly { id: number; probability: number; bounds: Interval }[]>();

  constructor(model: Model = snapshot) {
    this.model = freeze(model);
    this.#affixes = new Map(model.affixes.map((row) => [row.id, row]));
    this.#bases = new Map(model.bases.map((row) => [row.id, row]));
    if (this.#affixes.size !== model.affixes.length || this.#bases.size !== model.bases.length) {
      throw new Error('模型含有重复ID');
    }
  }

  affix(id: number): AffixDefinition {
    const found = this.#affixes.get(id);
    if (!found) throw new Error(`未知词缀ID：${id}`);
    return found;
  }

  base(id: string): BaseDefinition {
    const found = this.#bases.get(id);
    if (!found) throw new Error(`未知底材ID：${id}`);
    return found;
  }

  hasAffix(id: number): boolean { return this.#affixes.has(id); }
  hasBase(id: string): boolean { return this.#bases.has(id); }

  side(id: number): Side {
    const side = this.affix(id).side;
    if (side !== 0 && side !== 1 && side !== 2) throw new Error(`未知前后缀类别：${side}`);
    return side;
  }

  classMatches(requirement: number, specificity: number): boolean {
    return requirement === 31 || specificity === 0 ||
      (requirement === 0 && (specificity & 1) !== 0) ||
      ((requirement << 1) & specificity) !== 0;
  }

  canRollOn(id: number, baseId: string): boolean {
    const affix = this.affix(id);
    const base = this.base(baseId);
    // Native subtype-group fallbacks are retained for database consumers.
    let group = 0;
    if ([29, 30].includes(base.equipmentType) &&
        ((base.subType >= 10 && base.subType <= 14) || base.subType === 17)) {
      group = base.equipmentType === 29 ? 1 : 2;
    }
    return this.classMatches(base.classRequirement, affix.classSpecificity) &&
      (affix.canRollOn.includes(base.equipmentType) ||
       (group === 1 && (affix.canRollOn.includes(31) || affix.canRollOn.includes(33))) ||
       (group === 2 && (affix.canRollOn.includes(32) || affix.canRollOn.includes(33))));
  }

  hasShard(id: number): boolean {
    const affix = this.affix(id);
    return affix.rollsOn === 0 && (affix.special === 0 || affix.special === 3) &&
      !(affix.canRollOn.length === 1 && affix.canRollOn[0] === 41);
  }

  canForgeOn(id: number, baseId: string, alreadyOnItem: boolean): boolean {
    // SwapAttributesItemContainer.AttributeIds, current native initializer has FOUR entries.
    return this.canRollOn(id, baseId) || (alreadyOnItem && this.model.legacyForgeIds.includes(id));
  }

  craftWeight(id: number, baseId: string): number {
    const definition = this.affix(id);
    const equipmentType = this.base(baseId).equipmentType;
    const weight = definition.overrides.find((row) => row.equipmentType === equipmentType)?.weight ?? definition.weight;
    return weight < 1 ? Math.min(1, Math.fround(2 * weight)) : weight;
  }

  rerollPool(item: Item, side: Side): readonly { id: number; probability: number; bounds: Interval }[] {
    // Only a candidate pool is keyed by an ID SET. Native item order is retained everywhere else.
    const key = `${item.baseId}:${side}:${item.affixes.map((row) => row.id).sort((a, b) => a - b).join(',')}`;
    const cached = this.#pools.get(key);
    if (cached) return cached;
    const excluded = new Set(item.affixes.map((row) => row.id));
    const entries = this.model.affixes.filter((row) => row.side === side && row.special === 0 &&
      !excluded.has(row.id) && this.canRollOn(row.id, item.baseId))
      .map((row) => ({ id: row.id, weight: this.craftWeight(row.id, item.baseId) }))
      .filter((row) => row.weight > 0);
    const total = entries.reduce((sum, row) => sum.add(exact(row.weight)), ZERO);
    const result = entries.map((row) => {
      const bounds = exact(row.weight).div(total);
      return { id: row.id, probability: bounds.midpoint, bounds };
    });
    if (this.#pools.size >= 4096) this.#pools.delete(this.#pools.keys().next().value!);
    this.#pools.set(key, result);
    return result;
  }
}

export function ordinary(item: Item): readonly Affix[] {
  return item.affixes.filter((row) => row.slot === 'ordinary');
}

export function itemKey(item: Item): string {
  return `${item.baseId}|${item.fpType}|${item.itemLevel}|${Number(item.corrupted)}|` +
    item.affixes.map((row) => `${row.id}:${row.tier}:${row.slot}:${row.roll ?? '*'}`).join(',');
}
