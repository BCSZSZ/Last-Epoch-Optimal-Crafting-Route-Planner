import { readFileSync, writeFileSync } from 'node:fs';
import { catalogForInputModel } from '../src/core/input-model';
import { parsePlanRequest } from '../src/core/request';
import { replayFiniteProfile } from '../src/core/finite-replay';
import { FINITE_POLICY_VERSION } from '../src/core/finite-policy';
import type { PlanReport } from '../src/core/planner';
import { routeSteps } from '../src/ui/route-view';
import type { RouteStep } from '../src/ui/route-view';

const inputPath = process.argv[2]; if (!inputPath) throw new Error('Usage: tsx scripts/check_finite_export.ts <export.json> [--output result.json]');
const record = JSON.parse(readFileSync(inputPath, 'utf8')) as { schemaVersion: number; input: unknown; report: PlanReport };
const catalog = catalogForInputModel(record.report.inputModel), parsed = parsePlanRequest(record.input, catalog);
if (!parsed.request || record.schemaVersion !== 2 || record.report.modelId !== catalog.model.modelId || record.report.finiteProfiles?.version !== FINITE_POLICY_VERSION ||
  record.report.finiteProfiles.profiles.map(row => row.fpType).join(',') !== 'NORMAL,ICE,BLOOD') throw new Error('Export input/model/version mismatch');
const checks = [];
for (const profile of record.report.finiteProfiles.profiles) {
  checks.push(await replayFiniteProfile(parsed.request, catalog, profile));
  if(profile.fixedFp&&profile.fixedRoute){
    const paths=new Set<string>();
    const collect=(steps:readonly RouteStep[])=>steps.forEach(step=>{step.sourcePaths?.forEach(p=>paths.add(p));step.branches?.forEach(b=>collect(b.steps));});
    collect(routeSteps(profile.fixedRoute.macros,parsed.request,catalog,{},true));
    let total=0;
    for(const [path,stat]of Object.entries(profile.fixedFp.macros)){
      if(stat.totalFpContribution>1e-10&&!paths.has(path))throw new Error('A charged macro is missing from displayed steps: '+path);
      if(Math.abs(stat.expectedFp*stat.expectedEntries-stat.totalFpContribution)>1e-7)throw new Error('Macro reward fields are inconsistent');
      total+=stat.totalFpContribution;
    }
    if(Math.abs(total-profile.fixedFp.totalExpectedFp)>1e-7||profile.actualMeanFp===null||Math.abs(total-profile.actualMeanFp)>1e-7)throw new Error('Whole-route FP is inconsistent');
  }
}
const result = { status: 'PASS_THREE_EXPORTED_PROFILES', modelId: catalog.model.modelId, checks };
const out = process.argv.indexOf('--output'); if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
