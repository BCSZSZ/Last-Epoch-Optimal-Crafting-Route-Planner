import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { MODEL_ID } from '../src/core/catalog';
import { benchmarkCases, benchmarkRequest } from '../src/diagnostics/cases';
import { plan } from '../src/core/planner';
import type { FpType } from '../src/core/types';

const cases = benchmarkCases.map((entry) => entry.id);
const fpTypes: FpType[] = ['NORMAL', 'ICE', 'BLOOD'];
const selected = process.argv.indexOf('--case');
const slow = process.argv.includes('--jitless');
const root = new URL('../', import.meta.url);

if (selected >= 0) {
  const id = process.argv[selected + 1];
  const fpType = process.argv[process.argv.indexOf('--fp') + 1] as FpType;
  const request = benchmarkRequest(id, fpType);
  const start = performance.now();
  const report = await plan(request);
  const elapsed = performance.now() - start;
  console.log(JSON.stringify({ id, fpType, milliseconds: elapsed, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    status: report.status, score: report.primary?.scoreEstimate, scoreBounds: report.primary?.score,
    evaluation: report.primary?.evaluationStatus, routeId: report.primary?.route.id,
    macros: report.primary?.route.macros, search: report.search, states: report.primary?.states,
    samples: report.primary?.sampling?.totalTrials ?? 0, modelId: report.modelId }));
} else {
  const records = [];
  for (const id of cases) for (const fpType of fpTypes) {
    const args = [...(slow ? ['--jitless'] : []), '--import', 'tsx', fileURLToPath(import.meta.url), '--case', id, '--fp', fpType];
    const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }));
    records.push(result);
    console.log(JSON.stringify({ completed: records.length, total: cases.length * fpTypes.length, id, fpType,
      milliseconds: Math.round(result.milliseconds), score: result.score, status: result.status }));
  }
  const output = { schemaVersion: 1, measuredOn: new Date().toISOString(), modelId: MODEL_ID,
    scope: 'COMPLETE_PLANNER_WITH_DEFAULT_TIME_AND_ROUTE_LIMITS_ALL_FP_0_TO_63',
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, memoryGiB: totalmem() / 2 ** 30, jitless: slow },
    measurement: 'Cold child per case and FP type; elapsed excludes module load and process launch. Peak RSS includes Node and imported model. Jitless disables V8 JIT as a constrained-runtime proxy, not a measurement of a physical low-end device. Wall-clock cutoffs may change candidate coverage.',
    requestScope: { milliseconds: 12000, maxRoutes: 48, macroStages: 12, maxStates: 25000 }, records };
  const outputPath = new URL(`research/full-planner-node${slow ? '-jitless' : ''}.json`, root);
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`Saved ${fileURLToPath(outputPath)}`);
}
