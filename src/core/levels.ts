import type { Item } from './types';
import type { Catalog } from './catalog';

/** Native stored-tier lookup, with the complete cap90 tail audited separately. */
function contribution(displayTier: number): number {
  return [1, 3, 6, 10, 14, 15, 16, 16][Math.min(7, displayTier - 1)];
}

function fromTiers(item: Item, tiers: readonly number[], catalog: Catalog): number {
  const total = tiers.reduce((value, tier) => value + contribution(tier), 0);
  const highest = tiers.length ? contribution(Math.max(...tiers)) : 0;
  return Math.max(catalog.base(item.baseId).levelRequirement, Math.min(90, Math.max(1, total + 2 * highest - 10)));
}

export function requiredLevel(item: Item, catalog: Catalog): number {
  return fromTiers(item, item.affixes.filter((row) => row.slot === 'ordinary' &&
    catalog.affix(row.id).special === 0).map((row) => row.tier), catalog);
}

export function requiredLevelWithAffix(item: Item, id: number, displayTier: number, catalog: Catalog): number {
  // Native inserts the hypothetical target unconditionally, then excludes its old ID.
  const tiers = [displayTier, ...item.affixes.filter((row) => row.id !== id && row.slot === 'ordinary' &&
    catalog.affix(row.id).special === 0).map((row) => row.tier)];
  return fromTiers(item, tiers, catalog);
}

export function requiredLevelAfterShard(item: Item, id: number, catalog: Catalog): number {
  const existing = item.affixes.find((row) => row.id === id && row.slot === 'ordinary' && catalog.affix(row.id).special === 0);
  return requiredLevelWithAffix(item, id, existing ? existing.tier + 1 : 1, catalog);
}
