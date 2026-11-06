/** Full native IDs and an independent program interpreter; no identity quotient in sampled paths. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {RuleEngine} from '../src/core/rules';
import {catalogForInputModel} from '../src/core/input-model';
import {seededRandom} from '../src/core/random';
import {simulateRoute} from '../src/core/sampling';
import type {PlanRequest,Route} from '../src/core/types';
const evidence=JSON.parse(readFileSync('research/program-release-validation.json','utf8'));
const n=20000,checks=[];
for(const row of evidence.cases.filter((r:{id:string})=>r.id.startsWith('reference-')||r.id.startsWith('detailed-'))){
 const report=row.primary;if(!report||report.intrinsic.nonTerminatingStates||report.intrinsic.probabilityMeaning!=='FULL_ROUTE'||!report.expectedFpGivenSuccess)continue;
 const request:PlanRequest=row.input,route:Route=report.route,engine=new RuleEngine(catalogForInputModel(request.inputModel));
 const a=seededRandom('program-release-intrinsic-'+row.id),b=seededRandom('program-release48-'+row.id);
 let successes=0,spent=0,squared=0,finished=0;
 for(let k=0;k<n;k++){
   const demand=simulateRoute(engine,request,route,63,a,1024,true);if(demand.success){successes++;spent+=demand.spent;squared+=demand.spent**2;}
   if(row.completion&&simulateRoute(engine,request,route,48,b).success)finished++;
 }
 const p=report.scoreEstimate,probability=successes/n,mean=spent/successes,meanExpected=(report.expectedFpGivenSuccess.lower+report.expectedFpGivenSuccess.upper)/2;
 const pError=4*Math.sqrt(Math.max(p*(1-p),1/n)/n)+1/n;
 const meanError=4*Math.sqrt(Math.max(0,squared/successes-mean**2)/successes)+.01;
 assert(Math.abs(probability-p)<=pError,row.id+' operation probability');assert(Math.abs(mean-meanExpected)<=meanError,row.id+' successful FP');
 const p48=row.completion?(row.completion.probability.lower+row.completion.probability.upper)/2:null;
 const error48=p48===null?null:4*Math.sqrt(Math.max(p48*(1-p48),1/n)/n)+1/n;
 if(p48!==null)assert(Math.abs(finished/n-p48)<=error48!,row.id+'48FP');
 checks.push({id:row.id,n,successes,operationEstimate:probability,operationExpected:p,operationTolerance:pError,successMeanEstimate:mean,successMeanExpected:meanExpected,successMeanTolerance:meanError,
   completionEstimate:p48===null?null:finished/n,completionExpected:p48,completionTolerance:error48});
 console.log(JSON.stringify({id:row.id,status:'PASS',successes}));
}
const result={schemaVersion:1,modelId:evidence.modelId,status:'PASS',seeded:true,samplesPerCase:n,checks,
 qualification:'Independent fixed-program interpreter and full-ID Monte Carlo paths cross-check quotient enumeration. Physical atomic rules are shared; not an independent game-mechanism derivation or client test. Four standard errors plus fixed rounding allowance, fixed before sampling.'};
const bytes=JSON.stringify(result,null,2)+'\n',path='research/program-release-monte-carlo.json';
if(process.argv.includes('--verify-only'))assert.equal(readFileSync(path,'utf8'),bytes);else writeFileSync(path,bytes);
