import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {plan} from '../src/core/planner';
import {evaluateIntrinsic,IntrinsicWorkspace} from '../src/core/intrinsic';
import {evaluateCompletion} from '../src/core/completion';
import {catalogForInputModel} from '../src/core/input-model';
import {RuleEngine} from '../src/core/rules';
import {experimentalFixtures} from '../src/test-support/experimental-fixtures';
import {detailedFixtures} from '../src/test-support/detailed-fixtures';
import {trainingCases} from '../src/research/learning-cases';

const verify=process.argv.includes('--verify-only'),proofOnly=process.argv.includes('--evidence-only'),trials=verify||proofOnly?1:5;
const cases=[...experimentalFixtures().map(f=>({...f,id:'reference-'+f.id})),...experimentalFixtures(4,true).map(f=>({...f,id:'detailed-'+f.id})),...detailedFixtures()];
const results=[],performanceRows:{id:string;times:number[]}[]=[];
for(const fixture of cases){
  const times:number[]=[];let report:Awaited<ReturnType<typeof plan>>|undefined;
  for(let n=verify||proofOnly?0:-1;n<trials;n++){
    const start=performance.now();const next=await plan(fixture.request);if(n>=0)times.push(performance.now()-start);
    if(report){assert.equal(next.primary?.route.id,report.primary?.route.id);assert.deepEqual(next.primary,report.primary);assert.deepEqual(next.completion,report.completion);}
    report=next;
  }
  assert(report);
  if(!['wildcard-prefixes','partial-wildcard'].includes(fixture.id))assert.equal(report.searchStatus,'COMPLETE',fixture.id);
  assert.equal(report.unresolvedRoutes,0,fixture.id);
  if(report.primary){
    assert.equal(report.primary.intrinsic!.nonTerminatingStates,0,fixture.id+' nonterminating preparation');
    const engine=new RuleEngine(catalogForInputModel(fixture.request.inputModel));
    assert.deepEqual(evaluateIntrinsic(new IntrinsicWorkspace(engine,fixture.request),report.primary.route),report.primary);
    assert.deepEqual(evaluateCompletion(engine,fixture.request,report.primary.route),report.completion);
    assert.equal(report.completion?.status,'COMPLETE');
    assert(report.completion!.probability!.upper-report.completion!.probability!.lower<1e-5);
  }else assert.equal(report.abandonedCount,report.search.evaluatedRoutes);
  const result={id:fixture.id,input:fixture.request,primary:report.primary,completion:report.completion,searchStatus:report.searchStatus,grammar:report.search.grammar,
    generated:Number(report.search.candidateUpperBound),evaluated:report.search.evaluatedRoutes,abandoned:report.abandonedCount,abandonmentSummary:report.abandonmentSummary,
    displayedAbandoned:report.primary?null:report.abandoned?.[0]??null};
  results.push(result);
  if(!verify)console.log(JSON.stringify({id:fixture.id,medianMs:[...times].sort((a,b)=>a-b)[Math.floor(times.length/2)],success:report.primary?.scoreEstimate,fp:report.primary?.expectedFpGivenSuccess,p48:report.completion?.probability,status:report.searchStatus}));
  performanceRows.push({id:fixture.id,times});
}
function meet(actual:NonNullable<Awaited<ReturnType<typeof plan>>['primary']>,reference:typeof actual){
  assert(actual.score.lower>=reference.score.upper-1e-9);
  if(Math.abs(actual.scoreEstimate-reference.scoreEstimate)<1e-9)assert(actual.expectedFpGivenSuccess!.upper<=reference.expectedFpGivenSuccess!.lower+1e-7);
}
const teachers=[];
for(const fixture of trainingCases()){
  const input={...fixture.request,search:{milliseconds:12000,maxRoutes:4096,macroStages:12,maxStates:25000}},engine=new RuleEngine(catalogForInputModel(input.inputModel));
  const report=await plan(input);assert(report.primary);assert.equal(report.searchStatus,'COMPLETE');
  const workspace=new IntrinsicWorkspace(engine,input);meet(report.primary,evaluateIntrinsic(workspace,fixture.teacher));meet(report.primary,evaluateIntrinsic(workspace,fixture.bestKnown));
  teachers.push({id:fixture.id,primary:report.primary,completion:report.completion,teachersMet:true,strongestKnownMet:true});
}
const sources=Object.fromEntries(['src/core/program-search.ts','src/core/program-compact.ts','src/core/program-projection.ts','src/core/draft.ts','src/core/planner.ts','src/core/intrinsic.ts','src/core/completion.ts','src/core/rules.ts'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
const evidence={schemaVersion:1,status:'PASS',modelId:cases[0].request.modelId,solverRevision:'EXAMPLE_GUIDED_ROUND2_WITH_EXPERIMENTAL_CONVERSION_V1',cases:results,teachers,sources,
  qualification:'Eight user experimental-prefix2 patterns in unspecified-equipment equal reference and eight full-ID glove cases using actual craft weights, plus six detailed UI patterns. Complete means the declared finite program grammar only. No global optimality or low-end-device claim.'};
const bytes=JSON.stringify(evidence,null,2)+'\n',path='research/program-release-validation.json';
if(verify)assert.equal(readFileSync(path,'utf8'),bytes);else{
  writeFileSync(path,bytes);if(!proofOnly)writeFileSync('research/program-release-performance.json',JSON.stringify({schemaVersion:1,modelId:evidence.modelId,trials,warmups:1,environment:{node:process.version,platform:process.platform,arch:process.arch},cases:performanceRows,
    qualification:'Same desktop sequential Node timings, five trials after one warmup; includes planning and48FP evaluation. Not browser latency or low-end-device evidence.'},null,2)+'\n');
}
console.log(JSON.stringify({status:'PASS',cases:results.length,teachersMet:teachers.length,trials}));
