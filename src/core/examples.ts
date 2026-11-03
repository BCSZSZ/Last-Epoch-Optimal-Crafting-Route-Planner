import { MODEL_ID } from './catalog';
import type { PlanRequest } from './types';

export const examples = [
  { id: '7710-direct', name: '7710：两个目标都缺，直接封印准备', rows: [[7, 7], [10, 7], [2, 1]], targets: [4, 5] },
  { id: '7710-prepare', name: '7710：两个目标都缺，需要浩劫搬阶', rows: [[2, 7], [26, 7], [10, 1]], targets: [7, 4] },
  { id: '7713-existing', name: '7713：已有目标A，直接封印补B', rows: [[4, 7], [7, 7], [2, 1], [10, 3]], targets: [4, 5] },
  { id: '7713-prepare', name: '7713：已有目标A，先浩劫准备', rows: [[4, 7], [26, 7], [10, 1], [7, 3]], targets: [4, 5] },
  { id: '7717-existing', name: '7717：已有目标A，三条T7边界', rows: [[4, 7], [7, 7], [2, 1], [10, 7]], targets: [4, 5] },
  { id: '7732-ready', name: '7732：A／B身份已在低阶', rows: [[7, 7], [10, 7], [4, 3], [5, 2]], targets: [4, 5] },
  { id: '7732-missing', name: '7732：四条都不是目标', rows: [[2, 7], [26, 7], [7, 3], [10, 2]], targets: [4, 5] },
] as const;

export function exampleRequest(id = '7710-direct'): PlanRequest {
  const example = examples.find((row) => row.id === id) ?? examples[0];
  return { modelId: MODEL_ID, item: { baseId: '4:0', itemLevel: 100, corrupted: false, fpType: 'NORMAL',
    affixes: example.rows.map(([affixId, tier]) => ({ id: affixId, tier, slot: 'ordinary', roll: null })) },
    craftingContext: { playerLevel: 100 }, target: { requirements: example.targets.map((affixId) => ({ ids: [affixId], minTier: 7, maxTier: 7, slot: 'ordinary' })) },
    constraints: {}, scoring: {}, search: { milliseconds: 12000, maxRoutes: 48, macroStages: 12, maxStates: 25000 } };
}
