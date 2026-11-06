/** Actual detailed-form UI downloads, native-ID Chinese labels and Node/Worker parity. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { evaluateCompletion } from '../src/core/completion';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';
import { detailedFixtures } from '../src/test-support/detailed-fixtures';
import { affixName } from '../src/ui/labels';
import type { DraftSlots, DraftSlotKey } from '../src/core/draft';

const context=process.argv.includes('--public')?'public':'local',root='research/ui-validation/';
const bytes=readFileSync(root+`detailed-${context}-observations.json`),observations=JSON.parse(bytes.toString('utf8'));
assert.equal(observations.modelId,MODEL_ID);
const snap=(id:string)=>{const value=observations.snapshots.find((row:{id:string})=>row.id===id);assert(value,id);return value;};
if(context==='local'){
  assert.deepEqual(snap('english-search').options.map((row:{id:string})=>row.id),snap('chinese-search').options.map((row:{id:string})=>row.id));
  for(const row of snap('chinese-search').options)assert.match(row.name,/\p{Script=Han}/u);
  for(const key of ['mode','part','tiers','comboboxes'])assert.deepEqual(snap('known-7710-ready')[key],snap('known-7710-refreshed')[key]);
  assert(snap('invalid-three-t7').alerts.some((text:string)=>text.includes('起始普通栏没有足够')));
  assert.equal(snap('edit-cancels-detail-job').resultText,null);
  assert.equal(snap('after-cancel-settled').resultText,null);
}
const expected=context==='local'?6:3;
assert.equal(observations.reports.length,expected);
const checks=[];
for(const row of observations.reports){
  assert.match(row.file,new RegExp(`^detailed-${context}-[\\w-]+\\.json$`));
  const raw=readFileSync(root+row.file),record=JSON.parse(raw.toString('utf8'));
  const fixture=detailedFixtures().find(item=>item.id===row.id);assert(fixture,row.id);
  assert.deepEqual(record.input,fixture.request);
  assert.equal(record.report.modelId,MODEL_ID);assert.equal(record.input.inputModel,'FORGEABLE_WEIGHTED');
  const engine=new RuleEngine(catalogForInputModel(record.input.inputModel));
  const primary=record.report.primary,completion=record.report.completion;assert(primary);
  assert.deepEqual(evaluateIntrinsic(new IntrinsicWorkspace(engine,record.input),primary.route),primary);
  assert.deepEqual(evaluateCompletion(engine,record.input,primary.route),completion);
  const snapshot=snap(row.id+'-result');assert.equal(snapshot.mode,'详细目标');assert.equal(snapshot.scrollWidth,snapshot.clientWidth);
  const lines=snapshot.resultText.split('\n').map((text:string)=>text.trim()).filter(Boolean);
  const percent=(value:{lower:number;upper:number})=>`${((value.lower+value.upper)*50).toFixed(2)}%`;
  assert.equal(lines[lines.indexOf('成功率')+1],percent(primary.score));
  assert.equal(lines[lines.indexOf('整件完成率（48 FP）')+1],percent(completion.probability));
  assert.equal(lines[lines.indexOf('成功路径平均 FP')+1],((primary.expectedFpGivenSuccess.lower+primary.expectedFpGivenSuccess.upper)/2).toFixed(2));
  const badge={RECOMMENDED:'推荐',NOT_RECOMMENDED:'不推荐',NEUTRAL:'当前方案',UNRESOLVED:'完成率待确定'}[completion.recommendation as 'RECOMMENDED'];
  assert.equal(lines[1],badge);
  const names={prefix1:'前缀1',prefix2:'前缀2',suffix1:'后缀1',suffix2:'后缀2',sealed:'封印'};
  const groups:readonly {prefix:string;values:DraftSlots}[]=[{prefix:'起始',values:fixture.draft.slots},{prefix:'目标',values:fixture.draft.targetSlots}];
  for(const [key,name]of Object.entries(names))for(const group of groups){
    const slot=group.values[key as DraftSlotKey];if(!slot.tier||slot.id===null)continue;
    const selected=snapshot.comboboxes.find((item:{label:string})=>item.label===group.prefix+name+'词条');assert(selected);
    assert.equal(selected.value.replace('⌄','').trim(),affixName(engine.catalog,slot.id));
    assert(selected.title.endsWith('#'+slot.id));
  }
  if(row.id==='known-7732')assert(snapshot.resultText.includes('仅接受前缀2／后缀2（T2或T3）'));
  if(row.id==='partial-wildcard'){
    assert(!snapshot.resultText.includes('封印'));
    assert(snapshot.resultText.includes('浩劫直至目标达成'));
    assert(record.input.target.requirements.some((item:{ids:number[]})=>item.ids.length>1));
  }
  checks.push({id:row.id,sha256:createHash('sha256').update(raw).digest('hex'),success:primary.score,meanFp:primary.expectedFpGivenSuccess,
    completion,allSpecifiedUiNamesMatchIds:true,fullPrimaryAndCompletionBitIdentical:true});
}
if(context==='local'){
  const baseline=JSON.parse(readFileSync(root+'detailed-baseline-known-7271.json','utf8'));
  const current=JSON.parse(readFileSync(root+'detailed-local-known-7271.json','utf8'));
  assert.deepEqual(baseline.input,current.input);assert.deepEqual(baseline.report.primary,current.report.primary);
  assert.deepEqual(baseline.report.completion,current.report.completion);
}
const result={schemaVersion:1,status:'PASS',modelId:MODEL_ID,context,sourceSha256:createHash('sha256').update(bytes).digest('hex'),checks,
  beforeAfterBaselineMatches:context==='local',
  qualification:'Actual detailed UI/Worker exports and observed labels compared with request IDs and Node evaluation. Local QA covers Chinese/English lookup, refresh, invalid input, wildcard semantics, cancellation and final route display refinements. Public QA uses released static assets. Not a complete strategy or low-end-device proof.'};
const output=JSON.stringify(result,null,2)+'\n',path=root+`detailed-${context}-parity.json`;
if(process.argv.includes('--verify-only'))assert.equal(readFileSync(path,'utf8'),output);else writeFileSync(path,output);
console.log(JSON.stringify({status:'PASS',context,cases:checks.length,fullPrimaryAndCompletionBitIdentical:true}));
