import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {compileDraft} from '../src/core/draft';
import {evaluateIntrinsic,IntrinsicWorkspace} from '../src/core/intrinsic';
import {evaluateCompletion} from '../src/core/completion';
import {catalogForInputModel} from '../src/core/input-model';
import {RuleEngine} from '../src/core/rules';
import {affixName} from '../src/ui/labels';
import {experimentalFixtures} from '../src/test-support/experimental-fixtures';
import {detailedFixtures} from '../src/test-support/detailed-fixtures';
import {recordCatalog} from './runtime_model_archive';
const context=process.argv.includes('--public')?'public':'local',root='research/ui-validation/';
const source=readFileSync(root+`programs-${context}-observations.json`),observations=JSON.parse(source.toString('utf8'));
const original=recordCatalog(observations.modelId,process.argv.includes('--historical'));assert.equal(observations.reports.length,14);
const fixtures=[...experimentalFixtures().map(f=>({...f,id:'reference-'+f.id})),...experimentalFixtures(4,true).map(f=>({...f,id:'detailed-'+f.id})),...detailedFixtures()];
const base=experimentalFixtures()[0].draft,co={...base,slots:{...base.slots,prefix2:{...base.slots.prefix2,isTarget:true}}};
const snap=(id:string)=>{const r=observations.snapshots.find((r:{id:string})=>r.id===id);assert(r,id);return r;};
const checked=(snapshot:ReturnType<typeof snap>,label:string)=>snapshot.checks.find((r:{label:string})=>r.label===label)?.checked;
if(context==='local'){
 for(const id of ['both-checks','both-checks-restored'])for(const label of ['起始前缀2实验词缀','起始前缀2已是目标词缀'])assert.equal(checked(snap(id),label),true);
 for(const label of ['起始前缀2实验词缀','起始前缀2已是目标词缀'])assert.equal(checked(snap('empty-clears-both'),label),false);
 for(const id of ['edit-cancels-program','cancel-settled'])assert.equal(snap(id).resultText,null);
}
const checks=[];
for(const row of observations.reports){
 assert.match(row.file,new RegExp('^programs-'+context+'-[\\w-]+\\.json$'));
 const bytes=readFileSync(root+row.file),record=JSON.parse(bytes.toString('utf8'));
 const fixture=fixtures.find(f=>f.id===row.id),expected=row.id==='experimental-owned-target'?compileDraft(co).scenarios[0].request:fixture?.request;assert(expected,row.id);
 assert.deepEqual(record.input,{...expected,modelId:observations.modelId});assert.equal(record.report.modelId,observations.modelId);assert.equal(record.report.searchStatus,'COMPLETE');
 const engine=new RuleEngine(catalogForInputModel(record.input.inputModel,original.model)),report=record.report;
 const shown=report.primary??[...report.abandoned].sort((a,b)=>b.scoreEstimate-a.scoreEstimate||(a.expectedFpGivenSuccess?.lower??Infinity)-(b.expectedFpGivenSuccess?.lower??Infinity))[0];assert(shown);
 assert.deepEqual(evaluateIntrinsic(new IntrinsicWorkspace(engine,record.input),shown.route),shown);
 if(report.primary)assert.deepEqual(evaluateCompletion(engine,record.input,shown.route),report.completion);
 const observed=snap(row.id+'-result'),lines=observed.resultText.split('\n').map((s:string)=>s.trim()).filter(Boolean);
 const percent=(p:{lower:number;upper:number})=>((p.lower+p.upper)*50).toFixed(2)+'%';
 const successLabel=shown.intrinsic.probabilityMeaning==='FULL_ROUTE'?'成功率':'成功率上界';
 assert.equal(lines[lines.indexOf(successLabel)+1],successLabel==='成功率'?percent(shown.score):'≤'+(shown.score.upper*100).toFixed(2)+'%');
 const fp=shown.intrinsic.successfulFpLowerBound,fpLabel=fp!==null?'成功路径平均 FP 下界':shown.intrinsic.fpMeaning==='PREFIX_GIVEN_PREFIX_SURVIVAL'?'截至此步的过关平均 FP':'成功路径平均 FP';
 assert.equal(lines[lines.indexOf(fpLabel)+1],fp!==null?'≥'+fp.toFixed(2):shown.expectedFpGivenSuccess?((shown.expectedFpGivenSuccess.lower+shown.expectedFpGivenSuccess.upper)/2).toFixed(2):'—');
 if(report.primary){
  assert.equal(lines[lines.indexOf('整件完成率（48 FP）')+1],percent(report.completion.probability));
  assert.equal(lines[1],{RECOMMENDED:'推荐',NOT_RECOMMENDED:'不推荐',NEUTRAL:'当前方案'}[report.completion.recommendation as 'NEUTRAL']);
 }else assert.equal(lines[1],'已放弃');
 assert.equal(observed.scrollWidth,observed.clientWidth);
 if(row.id.includes('owned'))assert.equal(checked(observed,'起始前缀2实验词缀'),true);
 if(fixture?.draft.targetMode==='SLOTS')for(const box of observed.comboboxes){
   const id=box.title?.match(/#(\d+)$/)?.[1];if(id)assert.equal(box.value.replace('⌄','').trim(),affixName(engine.catalog,Number(id)));
 }
 checks.push({id:row.id,sha256:createHash('sha256').update(bytes).digest('hex'),success:shown.score,fp:shown.expectedFpGivenSuccess,
   primary:!!report.primary,completion:report.completion,elapsedMs:report.search.elapsedMilliseconds,evaluated:report.search.evaluatedRoutes,fullReportReplay:true,labelsAndNativeIdsMatch:true});
}
const proof={schemaVersion:1,status:'PASS',context,modelId:observations.modelId,observationSha256:createHash('sha256').update(source).digest('hex'),checks,
 qualification:'Actual rendered UI and Worker exports, eight user reference cases, two full-ID weighted cases, three teacher cases and experimental-target coexistence. Node replay checks the full shown intrinsic report and48FP completion. Complete covers the declared finite grammar, not global optimality or a low-end device.'};
const bytes=JSON.stringify(proof,null,2)+'\n',path=root+`programs-${context}-parity.json`;
if(process.argv.includes('--verify-only'))assert.equal(readFileSync(path,'utf8'),bytes);else writeFileSync(path,bytes);
console.log(JSON.stringify({status:'PASS',context,cases:checks.length}));
