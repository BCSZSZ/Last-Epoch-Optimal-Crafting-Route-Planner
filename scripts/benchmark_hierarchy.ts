import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { MODEL_ID } from '../src/core/catalog';
import { plan } from '../src/core/planner';
import { benchmarkCases, benchmarkRequest } from '../src/diagnostics/cases';

const records = [];
for (const entry of benchmarkCases) for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
  const request = benchmarkRequest(entry.id, fpType), start = performance.now(), report = await plan(request);
  const record = { id: entry.id, fpType, milliseconds: performance.now() - start, request,
    status: report.status, searchStatus: report.searchStatus, operationSuccess: report.primary?.score ?? null,
    successfulMeanFp: report.primary?.expectedFpGivenSuccess ?? null, routeId: report.primary?.route.id ?? null,
    routeDescription: report.primary?.route.description ?? null, hierarchy: report.hierarchy, search: report.search,
    primaryStates: report.primary?.states ?? null, abandoned: report.abandoned?.length ?? 0, unresolved: report.unresolvedRoutes };
  records.push(record);
  console.log(JSON.stringify({ id: entry.id, fpType, milliseconds: Math.round(record.milliseconds), status: record.status,
    probability: report.primary?.scoreEstimate, fp: record.successfulMeanFp }));
}
const output = { schemaVersion: 2, modelId: MODEL_ID, metric: 'INTRINSIC_V2', measuredAt: new Date().toISOString(),
  environment: { node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem() / 2 ** 30 }, records,
  qualification: 'Node sequential production planner; all allowed actions, real versioned pools, default 12s/48-route request. Time includes template compilation and intrinsic search, excludes module startup. Per-template budgets can leave candidates unresolved; no global-optimality claim. New metrics differ from the archived finite-FP release, so elapsed ratios are not an equal-work speedup benchmark. Not browser, peak-memory, or low-end-device evidence.' };
writeFileSync(new URL('../research/hierarchy-runtime-benchmark.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
