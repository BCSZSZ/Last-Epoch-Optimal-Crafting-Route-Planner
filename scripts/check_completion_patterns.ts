/** Replay all selected396-case witnesses without repeating expensive uncompleted searches. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { evaluateCompletion } from '../src/core/completion';
import { compileTemplates } from '../src/core/hierarchy';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';
import type { PlanRequest } from '../src/core/types';
import {recordCatalog} from './runtime_model_archive';

const data=JSON.parse(readFileSync('research/7710-7721-completion.json','utf8'));
const original=recordCatalog(data.modelId,process.argv.includes('--historical'));assert.equal(data.cases.length,396);
for(const [path,sha] of Object.entries(data.sourceSha256)){
 const source=path==='src/generated/model.json'&&data.modelId!==MODEL_ID?'research/runtime-model-archive/'+data.modelId+'.json':path;
 assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),sha);
}
let replayed=0;
for(const row of data.cases) {
  const request:PlanRequest=row.request;
  const engine=new RuleEngine(catalogForInputModel(request.inputModel,original.model));
  const compiled=compileTemplates(request,engine); assert(compiled);
  if(!row.routeId) { assert.equal(row.completion,null); continue; }
  const route=compiled.templates.find(candidate=>candidate.id===row.routeId); assert(route);
  const intrinsic=evaluateIntrinsic(new IntrinsicWorkspace(engine,request),route);
  assert.equal(intrinsic.intrinsic.decision,'RETAINED');
  assert.deepEqual(intrinsic.score,row.operationSuccess);
  assert.deepEqual(intrinsic.expectedFpGivenSuccess,row.successMeanFp);
  assert.deepEqual(evaluateCompletion(engine,request,route),row.completion);
  replayed++;
}
console.log(JSON.stringify({status:'PASS',modelId:data.modelId,positionCases:396,replayedWitnesses:replayed,
  qualification:'Checks legal template identities and complete intrinsic/48FP metrics for all saved selected witnesses; absence of a selected route is not an impossibility proof.'}));
