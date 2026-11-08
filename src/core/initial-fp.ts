import type { PlanRequest } from './types';
// Natural level100 exalted items with at least3 ordinary affixes: Q70=44.
export const DEFAULT_INITIAL_FP = 44;
export function initialFp(request: Pick<PlanRequest, 'initialFp'>): number { return request.initialFp ?? DEFAULT_INITIAL_FP; }
