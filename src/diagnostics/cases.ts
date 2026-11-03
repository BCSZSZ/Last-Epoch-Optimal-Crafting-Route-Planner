import { exampleRequest } from '../core/examples';
import type { FpType, PlanRequest } from '../core/types';

export const benchmarkCases = [
  { id: '7732-ready', label: '双T7阶数重排' },
  { id: '7710-direct', label: '7710补词与封印' },
  { id: '7713-prepare', label: '7713浩劫准备' },
  { id: 'removal-required', label: '剥离后补词' },
  { id: '7732-missing', label: '7732稀有目标救赎' },
] as const;

export function benchmarkRequest(id: string, fpType: FpType): PlanRequest {
  if (!benchmarkCases.some((entry) => entry.id === id)) throw new Error(`未知基准案例：${id}`);
  const initial = exampleRequest(id === 'removal-required' ? '7710-direct' : id);
  return { ...initial, item: { ...initial.item, fpType, ...(id === 'removal-required' ? {
    affixes: [[4, 7], [2, 5], [7, 7], [10, 5]].map(([affix, tier]) => ({ id: affix, tier, slot: 'ordinary' as const, roll: null })),
  } : {}) }, constraints: id === 'removal-required' ? { allowedActions: ['removal', 'add', 'havoc'] } : initial.constraints };
}

export function benchmarkMatrix(mode: 'FULL' | 'NORMAL_ONLY') {
  const fpTypes: readonly FpType[] = mode === 'FULL' ? ['NORMAL', 'ICE', 'BLOOD'] : ['NORMAL'];
  return benchmarkCases.flatMap((entry) => fpTypes.map((fpType) => ({ ...entry, fpType, request: benchmarkRequest(entry.id, fpType) })));
}
