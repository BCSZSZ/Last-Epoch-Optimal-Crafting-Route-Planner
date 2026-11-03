import type { Affix, Item, Requirement, Selector, Target } from './types';
import type { Catalog } from './catalog';

export function matches(affix: Affix, requirement: Requirement): boolean {
  return requirement.ids.includes(affix.id) && affix.tier >= requirement.minTier &&
    affix.tier <= (requirement.maxTier ?? 8) &&
    (requirement.slot === 'any' || affix.slot === requirement.slot) &&
    (requirement.minRollByte === undefined || (affix.roll !== null && affix.roll >= requirement.minRollByte));
}

export function targetReached(item: Item, target: Target): boolean {
  const required = target.requirements.filter((row) => !row.optional);
  const candidates = required.map((requirement) => item.affixes.flatMap((affix, index) => matches(affix, requirement) ? [index] : []));
  // Each physical affix can satisfy at most one required entry, including overlapping alternatives.
  candidates.sort((a, b) => a.length - b.length);
  const assign = (index: number, used: number): boolean => {
    if (index === candidates.length) return true;
    return candidates[index].some((slot) => !(used & (1 << slot)) && assign(index + 1, used | (1 << slot)));
  };
  return assign(0, 0);
}

export function select(item: Item, selector: Selector, catalog: Catalog, eligible: (affix: Affix) => boolean = () => true): number | undefined {
  const index = item.affixes.findIndex((affix) => affix.slot === 'ordinary' &&
    (selector.ids === undefined || selector.ids.includes(affix.id)) &&
    !selector.excludedIds?.includes(affix.id) &&
    (selector.side === undefined || catalog.side(affix.id) === selector.side) &&
    affix.tier >= (selector.minTier ?? 1) && affix.tier <= (selector.maxTier ?? 8) && eligible(affix));
  return index < 0 ? undefined : index;
}

export function selectedIds(item: Item, selector: Selector, catalog: Catalog, eligible: (affix: Affix) => boolean = () => true): readonly number[] {
  return item.affixes.filter((affix) => affix.slot === 'ordinary' &&
    (selector.ids === undefined || selector.ids.includes(affix.id)) && !selector.excludedIds?.includes(affix.id) &&
    (selector.side === undefined || catalog.side(affix.id) === selector.side) &&
    affix.tier >= (selector.minTier ?? 1) && affix.tier <= (selector.maxTier ?? 8) && eligible(affix)).map((row) => row.id);
}
