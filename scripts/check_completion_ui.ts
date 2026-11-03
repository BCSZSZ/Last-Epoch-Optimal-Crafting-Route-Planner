/** Actual static-browser Worker exports vs Node, including separate48FP results. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { evaluateCompletion } from '../src/core/completion';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';

const files=['completion48-7710.json','completion48-not-recommended.json','completion48-7721.json','completion48-neutral.json'];
const decisions=new Set<string>(),checks=[];
for(const file of files) {
  const bytes=readFileSync(`research/ui-validation/${file}`),record=JSON.parse(bytes.toString('utf8'));
  assert.equal(record.input.modelId,MODEL_ID); assert.equal(record.report.modelId,MODEL_ID);
  const engine=new RuleEngine(catalogForInputModel(record.input.inputModel));
  const primary=record.report.primary; assert(primary);
  assert.deepEqual(evaluateIntrinsic(new IntrinsicWorkspace(engine,record.input),primary.route),primary);
  const completion=evaluateCompletion(engine,record.input,primary.route,undefined,record.report.completion.initialFp);
  assert.deepEqual(completion,record.report.completion); decisions.add(completion.recommendation);
  checks.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),routeId:primary.route.id,operationSuccess:primary.score,
    successMeanFp:primary.expectedFpGivenSuccess,completion,fullPrimaryAndCompletionBitIdentical:true});
}
assert(decisions.has('RECOMMENDED')&&decisions.has('NOT_RECOMMENDED')&&decisions.has('NEUTRAL'));
const result={schemaVersion:1,modelId:MODEL_ID,status:'PASS',checks,
  qualification:'Four actual local static Pages-subpath browser UI/Worker downloads, replayed in Node with full intrinsic and48FP completion equality. Includes recommended, not-recommended and neutral cases. Shares physical rules; independent mechanics evidence is separate. Not a low-end device or global-optimality claim.'};
const encoded=JSON.stringify(result,null,2)+'\n',path='research/ui-validation/completion48-parity.json';
if(process.argv.includes('--verify-only')) assert.equal(readFileSync(path,'utf8'),encoded); else writeFileSync(path,encoded);
console.log(JSON.stringify({status:'PASS',modelId:MODEL_ID,cases:checks.length,fullPrimaryAndCompletionBitIdentical:true}));
