import type { PlanReport } from '../core/planner';
import type { FpType, PlanRequest } from '../core/types';

export interface DeviceCaseRecord {
  readonly id: string;
  readonly label: string;
  readonly fpType: FpType;
  readonly request: PlanRequest;
  readonly adapterWallMilliseconds: number;
  readonly report: PlanReport;
}

export interface DeviceBenchmarkRecord {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly mode: 'FULL' | 'NORMAL_ONLY';
  readonly status: 'RUNNING' | 'COMPLETE' | 'CANCELLED' | 'ERROR';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly totalCases: number;
  readonly deviceLabel: string;
  readonly declaredDeviceClass: 'UNSPECIFIED' | 'DESKTOP_BASELINE' | 'LOW_PERFORMANCE';
  readonly environment: {
    readonly userAgent: string;
    readonly reportedLogicalCpus: number;
    readonly reportedDeviceMemoryGiB: number | null;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly pageOrigin: string;
    readonly pagePath: string;
  };
  readonly visibility: readonly { readonly milliseconds: number; readonly state: DocumentVisibilityState }[];
  readonly entries: readonly DeviceCaseRecord[];
  readonly error: string | null;
  readonly qualification: string;
}

export function deviceSummary(record: DeviceBenchmarkRecord) {
  return { modelId: record.modelId, status: record.status, mode: record.mode,
    completedCases: record.entries.length, totalCases: record.totalCases, deviceLabel: record.deviceLabel,
    declaredDeviceClass: record.declaredDeviceClass, environment: record.environment,
    foregroundThroughout: record.visibility.every((entry) => entry.state === 'visible'),
    results: record.entries.map((entry) => ({ id: entry.id, fpType: entry.fpType,
      seconds: Number((entry.adapterWallMilliseconds / 1000).toFixed(3)),
      workerSeconds: entry.report.search.elapsedMilliseconds / 1000,
      candidates: entry.report.search.evaluatedRoutes, searchStatus: entry.report.searchStatus,
      recommendation: entry.report.primary?.route.id ?? null,
      metric: entry.report.metric ?? 'FINITE_FP_V1',
      finiteProfiles: entry.report.finiteProfiles?.profiles.map(row => ({ fpType: row.fpType, probability: row.probability, recommendation: row.recommendation, status: row.status, strategyKind: row.strategyKind, firstAction: row.firstAction })) ?? null,
      successfulMeanFp: entry.report.primary?.expectedFpGivenSuccess ?? null,
      wholeCompletion: entry.report.completion?.probability ?? null,
      completionFp: entry.report.completion?.initialFp ?? null,
      completionRecommendation: entry.report.completion?.recommendation ?? null,
      upperNode: entry.report.hierarchy?.structure.node.routeNode ?? null,
      abandoned: entry.report.abandoned?.length ?? 0,
      successScore: entry.report.primary?.scoreEstimate ?? null, evaluation: entry.report.primary?.evaluationStatus ?? null })),
    error: record.error, qualification: record.qualification };
}
