/** Same-host paired Node measurements. UI-only names do not participate in either solver. */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { plan } from '../src/core/planner';
import { catalogForInputModel } from '../src/core/input-model';
import { IntrinsicWorkspace } from '../src/core/intrinsic';
import { evaluateCompletion } from '../src/core/completion';
import { RuleEngine } from '../src/core/rules';
import { searchLearningPrograms } from '../src/research/learning-solver';
import { detailedFixtures } from '../src/test-support/detailed-fixtures';

const trials=process.argv.includes('--pilot') ? 1 : 5;
const cases=detailedFixtures();
const results=[];
for(const fixture of cases){
  const rows=[];
  for(let iteration=-1;iteration<trials;iteration++){
    const start=performance.now(),report=await plan(fixture.request);
    const elapsed=performance.now()-start;
    const row={milliseconds:elapsed,searchStatus:report.searchStatus,stopReason:report.search.stopReason,
      evaluated:report.search.evaluatedRoutes,unresolved:report.unresolvedRoutes,route:report.primary?.route.id,
      success:report.primary?.score,meanFp:report.primary?.expectedFpGivenSuccess,completion:report.completion};
    if(iteration>=0)rows.push(row);
  }
  const experimental=[];
  const equal=[];
  if(fixture.id.startsWith('known-')) for(let iteration=-1;iteration<trials;iteration++){
    const start=performance.now(),report=await plan({...fixture.request,inputModel:'FORGEABLE_EQUAL'});
    if(iteration>=0)equal.push({milliseconds:performance.now()-start,evaluated:report.search.evaluatedRoutes,searchStatus:report.searchStatus,
      success:report.primary?.score,meanFp:report.primary?.expectedFpGivenSuccess,completion:report.completion});
  }
  if(fixture.id.startsWith('known-')) for(let iteration=-1;iteration<trials;iteration++){
    const engine=new RuleEngine(catalogForInputModel(fixture.request.inputModel));
    const start=performance.now(),report=searchLearningPrograms(new IntrinsicWorkspace(engine,fixture.request),2);
    const completion=report.primary ? evaluateCompletion(engine,fixture.request,report.primary.route) : null;
    if(iteration>=0)experimental.push({milliseconds:performance.now()-start,generated:report.generated,unresolved:report.unresolved,
      success:report.primary?.score,meanFp:report.primary?.expectedFpGivenSuccess,completion});
  }
  const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const result={id:fixture.id,inputModel:fixture.request.inputModel,request:fixture.request,trials:rows,equal,experimental,
    productionMedianMs:median(rows.map(row=>row.milliseconds)),equalMedianMs:equal.length?median(equal.map(row=>row.milliseconds)):null,
    experimentalMedianMs:experimental.length?median(experimental.map(row=>row.milliseconds)):null};
  results.push(result);
  console.log(JSON.stringify({id:result.id,productionMs:result.productionMedianMs,equalMs:result.equalMedianMs,experimentMs:result.experimentalMedianMs,
    evaluated:rows[0].evaluated,status:rows[0].searchStatus,stop:rows[0].stopReason,success:rows[0].success}));
}
writeFileSync('research/detailed-performance.json',JSON.stringify({schemaVersion:1,modelId:cases[0].request.modelId,
  trials,environment:{node:process.version,platform:process.platform,arch:process.arch},cases:results,
  qualification:'Sequential same-host Node timings, one warm-up per case. Default production48-candidate/12s limits; experimental minimum-vacancy grammar excludes Chaos/Redemption and is not an equivalent search scope. Physical model and production solver code are unchanged by UI localization. Not browser latency or low-end-device evidence.'},null,2)+'\n');
