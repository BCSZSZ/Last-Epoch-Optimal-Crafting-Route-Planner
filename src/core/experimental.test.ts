import {expect,it} from 'vitest';
import {Catalog} from './catalog';
import {compileDraft,emptyDraft,readDraft,ownedGoalCounts,withDraftSlots} from './draft';
import {catalogForInputModel} from './input-model';
import {evaluateIntrinsic,IntrinsicWorkspace} from './intrinsic';
import {evaluateCompletion} from './completion';
import {productionPrograms,compareLearningReports} from './program-search';
import {plan} from './planner';
import {RuleEngine} from './rules';
import {experimentalFixtures} from '../test-support/experimental-fixtures';
import {trainingCases} from '../research/learning-cases';

it('keeps experimental identity and target membership independent, including anonymous and restored inputs',()=>{
  const fixture=experimentalFixtures()[0],draft={...fixture.draft,slots:{...fixture.draft.slots,prefix2:{...fixture.draft.slots.prefix2,isTarget:true}}};
  const restored=readDraft(JSON.parse(JSON.stringify(draft)))!;
  expect(restored.slots.prefix2).toMatchObject({isExperimental:true,isTarget:true});
  const compiled=compileDraft(restored);expect(compiled.issues).toEqual([]);
  const request=compiled.scenarios[0].request,catalog=catalogForInputModel(request.inputModel),experimental=request.item.affixes[1];
  expect(catalog.affix(experimental.id).special).toBe(1);
  expect(request.target.requirements.some(r=>r.ids.includes(experimental.id))).toBe(true);
  expect(ownedGoalCounts(restored,0)).toEqual({desired:2,owned:1,ownedT7:1});
  const cleared=withDraftSlots(restored,{...restored.slots,prefix2:{...restored.slots.prefix2,tier:0,id:null}});
  expect(cleared.slots.prefix2).toMatchObject({isTarget:false,isExperimental:false});
});

it('rejects experimental markers on other slots, incompatible equipment, conflicting IDs and absent experimental goals',()=>{
  const fixture=experimentalFixtures()[0];
  expect(readDraft({...fixture.draft,slots:{...fixture.draft.slots,prefix1:{...fixture.draft.slots.prefix1,isExperimental:true}}})).toBeNull();
  expect(compileDraft({...fixture.draft,part:1}).scenarios).toHaveLength(0);
  expect(compileDraft({...fixture.draft,slots:{...fixture.draft.slots,prefix2:{tier:7,id:4,isExperimental:true}}}).scenarios).toHaveLength(0);
  const source=emptyDraft();
  const bad=compileDraft({...source,part:4,slots:{...source.slots,prefix1:{tier:7,id:4},suffix1:{tier:7,id:7}},targetMode:'SLOTS',targetSlots:{...source.targetSlots,prefix2:{tier:7,id:673}}});
  expect(bad.issues.some(i=>i.code==='UNREACHABLE_EXPERIMENTAL_TARGET')).toBe(true);
});

it('redemption converts experimental exalted identity and every other exalted slot, while ordinary seal/removal exclude it',()=>{
  const request=experimentalFixtures(4)[2].request,engine=new RuleEngine(catalogForInputModel(request.inputModel));
  const id=request.item.affixes[1].id;
  expect(engine.eligibility(request.item,63,{kind:'seal',id},request.craftingContext).some(r=>r.code==='NO_AFFIX_SHARD')).toBe(true);
  const removal=engine.demandTransition(request.item,{kind:'removal',glyph:'hope',acceptedIds:request.item.affixes.map(r=>r.id)},request.craftingContext);
  expect(removal.outcomes.every(r=>r.item.affixes.some(a=>a.id===id))).toBe(true);
  const redemption=engine.demandTransition(request.item,{kind:'redemption',glyph:'hope'},request.craftingContext);
  expect(redemption.issues).toEqual([]);
  expect(redemption.outcomes.every(r=>r.item.affixes[0].id!==request.item.affixes[0].id&&r.item.affixes[1].id!==id&&r.item.affixes[1].tier===7&&engine.catalog.affix(r.item.affixes[1].id).special===0)).toBe(true);
  expect(redemption.outcomes.reduce((s,r)=>s+(r.probability.lower+r.probability.upper)/2,0)).toBeCloseTo(1,11);
});

it('production entry meets all three expert and stronger known baselines without the former48-candidate cap',async()=>{
  for(const fixture of trainingCases()){
    const engine=new RuleEngine(catalogForInputModel(fixture.request.inputModel)),workspace=new IntrinsicWorkspace(engine,fixture.request);
    const reference=evaluateIntrinsic(workspace,fixture.bestKnown),request={...fixture.request,search:{...fixture.request.search,milliseconds:12000,maxRoutes:4096,macroStages:12}};
    const actual=await plan(request);expect(actual.primary,JSON.stringify(actual.issues)).not.toBeNull();
    expect(actual.search.grammar).toContain('EXAMPLE_GUIDED');expect(actual.searchStatus).toBe('COMPLETE');
    expect(actual.primary!.score.lower).toBeGreaterThanOrEqual(reference.score.lower-1e-9);
    if(Math.abs(actual.primary!.scoreEstimate-reference.scoreEstimate)<1e-9)expect(actual.primary!.expectedFpGivenSuccess!.upper).toBeLessThanOrEqual(reference.expectedFpGivenSuccess!.upper+1e-7);
    expect(actual.completion?.status).toBe('COMPLETE');
  }
},15000);

it('post-redemption identity quotient agrees with complete weighted-ID expansion for successful and failed exits',()=>{
  const request=experimentalFixtures(4)[1].request,base=catalogForInputModel('FORGEABLE_WEIGHTED');
  const keep=new Set([...request.item.affixes.map(r=>r.id),...request.target.requirements.flatMap(r=>r.ids),4,5,26,30,70,8,10,17]);
  const catalog=new Catalog({...base.model,affixes:base.model.affixes.filter(r=>keep.has(r.id))}),engine=new RuleEngine(catalog);
  const projected=new IntrinsicWorkspace(engine,request),raw=new IntrinsicWorkspace(engine,request,false);
  let selected=null;
  for(const route of productionPrograms(request,engine)!){
    const report=evaluateIntrinsic(projected,route);
    if(report.intrinsic.decision==='RETAINED'&&(!selected||compareLearningReports(report,selected)<0))selected=report;
  }
  expect(selected).not.toBeNull();
  const reference=evaluateIntrinsic(raw,selected!.route,undefined,true);
  expect(selected!.scoreEstimate).toBeCloseTo(reference.scoreEstimate,10);
  expect(selected!.expectedFpGivenSuccess!.lower).toBeCloseTo(reference.expectedFpGivenSuccess!.lower,6);
  expect(selected!.states).toBeLessThan(reference.states);
  const a=evaluateCompletion(engine,request,selected!.route),b=evaluateCompletion(engine,request,selected!.route,undefined,48,false);
  expect(a.probability!.lower).toBeCloseTo(b.probability!.lower,6);
  expect(a.probability!.upper-a.probability!.lower).toBeLessThan(1e-5);
},15000);

it('retains an experimental target and prepares a low-tier unwanted experiment before conversion',async()=>{
  const fixture=experimentalFixtures()[0],both={...fixture.draft,slots:{...fixture.draft.slots,prefix2:{...fixture.draft.slots.prefix2,isTarget:true}}};
  const compiled=compileDraft(both),report=await plan(compiled.scenarios[0].request);
  expect(report.primary).not.toBeNull();expect(report.primary!.scoreEstimate).toBe(1);
  const flat=(values:readonly import('./types').Macro[]):readonly import('./types').Macro[]=>values.flatMap(m=>m.kind==='conditional'?[...flat(m.then),...flat(m.otherwise??[])]:[m]);
  expect(flat(report.primary!.route.macros).some(m=>(m.kind==='once'||m.kind==='repeat')&&m.action.kind==='redemption')).toBe(false);
  const low={...fixture.draft,slots:{...fixture.draft.slots,prefix1:{tier:7,id:null},prefix2:{tier:1,id:null,isExperimental:true}}};
  const request=compileDraft(low).scenarios[0].request,engine=new RuleEngine(catalogForInputModel(request.inputModel));
  const programs=productionPrograms(request,engine)!;expect(programs.length).toBeGreaterThan(0);
  expect(programs.every(p=>{const prepare=p.macros.findIndex(m=>m.kind==='repeat'&&m.action.kind==='havoc'),convert=p.macros.findIndex(m=>m.kind==='once'&&m.action.kind==='redemption');return prepare>=0&&convert>prepare;})).toBe(true);
});

it('does not enter a preparation loop when a post-redemption branch already has the required vacancy',async()=>{
  const fixture=experimentalFixtures(4,true)[2],result=await plan(fixture.request);
  expect(result.primary).not.toBeNull();expect(result.primary!.intrinsic!.nonTerminatingStates).toBe(0);
},15000);
