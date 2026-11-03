import { Catalog } from './catalog';
import { exampleRequest } from './examples';
import { UPPER_NODES } from './hierarchy';
import type { Affix, PlanRequest } from './types';

/** One valid real-catalog item for EVERY raw label, including the six terminal labels. */
export function hierarchyFixtures(catalog = new Catalog(), targetIds: readonly [number, number] = [4, 5]): readonly { label: string; request: PlanRequest }[] {
  return UPPER_NODES.map((node) => {
    const base = exampleRequest();
    const [a, b] = targetIds;
    let rows: number[][];
    switch (node.group) {
      case '220': rows = [[a, 7], [b, 7]]; break;
      case '211': rows = [[a, 7], [b, 1]]; break;
      case '202': rows = [[a, 1], [b, 2]]; break;
      case '210': rows = [[a, 7]]; break;
      case '201': rows = [[a, 1]]; break;
      case '200': rows = []; break;
    }
    const garbage = (reserveTargets: boolean): number => catalog.model.affixes.find((row) => row.special === 0 && row.side < 2 && !targetIds.includes(row.id) &&
      !rows.some(([id]) => id === row.id) && catalog.hasShard(row.id) && catalog.canRollOn(row.id, base.item.baseId) &&
      rows.filter(([id]) => catalog.side(id) === row.side).length + (reserveTargets ? targetIds.filter((id) => catalog.side(id) === row.side && !rows.some(([existing]) => existing === id)).length : 0) < 2)!.id;
    while (rows.filter(([, tier]) => tier === 7).length < 2) rows.push([garbage(true), 7]);
    rows.sort((a, b) => b[1] - a[1]);
    while (rows.length < node.ordinaryCount) {
      const id = garbage(false);
      rows.push([id, rows.length === 2 ? 1 : 2]);
    }
    const affixes: Affix[] = rows.map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: null }));
    if (node.sealedCount) {
      const id = catalog.model.affixes.find((row) => row.special === 0 && row.side < 2 && !targetIds.includes(row.id) &&
        !affixes.some((affix) => affix.id === row.id) && catalog.hasShard(row.id) && catalog.canRollOn(row.id, base.item.baseId))!.id;
      affixes.push({ id, tier: 1, slot: 'sealed', roll: null });
    }
    return { label: node.key, request: { ...base, item: { ...base.item, affixes },
      target: { requirements: targetIds.map((id) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) },
      constraints: { allowedActions: ['add', 'havoc', 'seal', 'removal'] },
      search: { ...base.search, maxRoutes: 2000, milliseconds: 60000, maxStates: 10000 } } };
  });
}
