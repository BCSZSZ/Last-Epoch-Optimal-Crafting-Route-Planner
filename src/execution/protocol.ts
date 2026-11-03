import type { PlanProgress, PlanReport } from '../core/planner';
import type { PlanRequest } from '../core/types';

export interface WorkerRequest { readonly kind: 'plan'; readonly jobId: string; readonly request: PlanRequest }
export type WorkerResponse =
  | { readonly kind: 'progress'; readonly jobId: string; readonly progress: PlanProgress }
  | { readonly kind: 'result'; readonly jobId: string; readonly report: PlanReport }
  | { readonly kind: 'error'; readonly jobId: string; readonly error: { readonly name: string; readonly message: string } };
