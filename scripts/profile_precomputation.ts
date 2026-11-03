/** Research profiling only. No production code mutations or replacement solver path. */
import { writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { exampleRequest } from '../src/core/examples';
import { hierarchyFixtures } from '../src/core/hierarchy-fixtures';
import { plan } from '../src/core/planner';

const rows = [];
for (const id of ['7713-prepare', '7732-missing']) {
  const report = await plan(exampleRequest(id));
  rows.push({ id, elapsedMilliseconds: report.search.elapsedMilliseconds, evaluatedTemplates: report.search.evaluatedRoutes,
    unresolved: report.unresolvedRoutes, primaryStates: report.primary?.states, generatedTemplates: report.hierarchy?.generatedTemplates,
    primaryRouteId: report.primary?.route.id, paretoReported: report.search.paretoRouteIds.length, cacheHits: report.hierarchy?.workspaceCacheHits });
}
const completeCoverage = [];
for (const entry of hierarchyFixtures()) {
  const report = await plan(entry.request, { now: () => 0 });
  completeCoverage.push({ label: entry.label, templates: report.search.evaluatedRoutes, paretoReported: report.search.paretoRouteIds.length,
    status: report.searchStatus, primaryStates: report.primary?.states });
}
const result = { schemaVersion: 1, modelId: MODEL_ID, measuredAt: new Date().toISOString(), rows, completeCoverage,
  qualification: 'Research invocation of unchanged production planner. CPU-sampled timings can differ from saved baseline and per-template budget cutoffs can change coverage. Small frontier observations are not a proof of frontier size across all symbolic states.' };
writeFileSync(new URL('../research/precomputation-runtime-profile.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(rows));
