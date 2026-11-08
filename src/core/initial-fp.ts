import type { PlanRequest } from './types';
export const DEFAULT_INITIAL_FP = 48;
export function initialFp(request: Pick<PlanRequest, 'initialFp'>): number { return request.initialFp ?? DEFAULT_INITIAL_FP; }
