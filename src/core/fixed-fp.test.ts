import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { evaluateCompletion } from './completion';
import { RouteEvaluator, summarizeDistribution } from './evaluation';
import { catalogForInputModel } from './input-model';
import { RuleEngine } from './rules';
import { routeSteps } from '../ui/route-view';
import { exampleRequest } from './examples';
import type { FpType, PlanRequest, Route } from './types';

const fixture=JSON.parse(readFileSync(new URL('../../research/fixtures/manual-dagger7471-20261108.json',import.meta.url),'utf8')) as {
  input:PlanRequest;profiles:{fpType:FpType;expectedProbability:number;route:Route}[];
};

it('calculates every displayed step for fully specified dagger7471 in all three conditions',()=>{
  for(const profile of fixture.profiles){
    const catalog=catalogForInputModel(fixture.input.inputModel),input={...fixture.input,modelId:catalog.model.modelId,item:{...fixture.input.item,fpType:profile.fpType}},engine=new RuleEngine(catalog);
    const report=evaluateCompletion(engine,input,profile.route,undefined,48,true,true), stats=report.fpStats!;
    expect((report.probability!.lower+report.probability!.upper)/2).toBeCloseTo(profile.expectedProbability,9);
    const display=routeSteps(profile.route.macros,input,catalog,{},true);
    expect(display).toHaveLength(6);
    for(const step of display){
      expect(step.sourcePaths!.length).toBeGreaterThan(0);
      expect(step.sourcePaths!.some(p=>stats.macros[p]?.expectedFp>0)).toBe(true);
    }
    expect(stats.totalExpectedFp).toBeLessThanOrEqual(48);
    expect(stats.successExpectedFp).toBeLessThanOrEqual(48);
    expect(Object.values(stats.macros).reduce((sum,s)=>sum+s.expectedFp*s.expectedEntries,0)).toBeCloseTo(stats.totalExpectedFp,9);
    const removal=stats.macros[display[0].sourcePaths![0]],add=stats.macros[display[1].sourcePaths![0]];
    expect(removal.expectedEntries).toBeCloseTo(1,12);expect(add.expectedEntries).toBeCloseTo(.25,12);
  }
});

it('agrees with the independent backward absorption evaluator for cost and successful cost',()=>{
  const profile=fixture.profiles[0],catalog=catalogForInputModel(fixture.input.inputModel),input={...fixture.input,scoring:{maximumFp:12}};
  const engine=new RuleEngine(catalog),forward=evaluateCompletion(engine,input,profile.route,undefined,12,true,true).fpStats!;
  const backward=new RouteEvaluator(engine,input,profile.route).evaluate(12);
  const summary=summarizeDistribution(Array.from({length:64},(_,cost)=>cost<=12?backward.success[12-cost]:backward.success[63]),
    Array.from({length:64},(_,cost)=>cost<=12?backward.failure[12-cost]:backward.failure[63]));
  expect(forward.totalExpectedFp).toBeCloseTo(summary.expectedFp.midpoint,8);
  expect(forward.successExpectedFp).toBeCloseTo(summary.expectedFpGivenSuccess!.midpoint,7);
  for(let stage=0;stage<profile.route.macros.length;stage++)expect(forward.macros[String(stage)]?.totalFpContribution??0).toBeCloseTo(backward.spent[stage].midpoint,8);
},30000);

it('weights charged and critical branches for a single craft, including the last FP',()=>{
  const base=exampleRequest(),catalog=catalogForInputModel(),engine=new RuleEngine(catalog),route:Route={id:'add',macros:[{kind:'once',action:{kind:'add',id:4,glyph:'hope'}}]};
  for(const fpType of ['NORMAL','ICE','BLOOD']as const)for(const fp of [1,12,63]){
    const input:PlanRequest={...base,initialFp:fp,item:{...base.item,fpType,affixes:[]},target:{requirements:[{ids:[4],slot:'ordinary',minTier:1}]}};
    const expected=engine.transition(input.item,fp,{kind:'add',id:4,glyph:'hope'},input.craftingContext).outcomes.reduce((sum,o)=>sum+o.probability*(fp-o.fp),0);
    const actual=evaluateCompletion(engine,input,route,undefined,fp,true,true);
    expect(actual.fpStats!.totalExpectedFp).toBeCloseTo(expected,10);expect(actual.probability!.lower).toBeCloseTo(1,10);
  }
});

it('supports actual-weight FP rewards for every equipment type, without an item-specific path',()=>{
  const catalog=catalogForInputModel('FORGEABLE_WEIGHTED'),engine=new RuleEngine(catalog),seen=new Set<number>();
  for(const base of catalog.model.bases){
    if(!base.ordinaryEquipment||base.corrupted||base.obsolete||base.legacy||seen.has(base.baseType))continue;seen.add(base.baseType);
    const affix=catalog.model.affixes.find(a=>a.special===0&&a.side<2&&catalog.hasShard(a.id)&&catalog.canRollOn(a.id,base.id)&&catalog.craftWeight(a.id,base.id)>0)!;
    expect(affix).toBeDefined();
    for(const fpType of ['NORMAL','ICE','BLOOD']as const){
      const input:PlanRequest={...exampleRequest(),inputModel:'FORGEABLE_WEIGHTED',initialFp:17,item:{baseId:base.id,itemLevel:100,corrupted:false,fpType,affixes:[]},target:{requirements:[{ids:[affix.id],slot:'ordinary',minTier:1}]}};
      const action={kind:'add' as const,id:affix.id,glyph:'hope' as const},route:Route={id:'all-parts-add',macros:[{kind:'once',action}]};
      const expected=engine.transition(input.item,17,action,input.craftingContext).outcomes.reduce((sum,o)=>sum+o.probability*(17-o.fp),0);
      expect(evaluateCompletion(engine,input,route,undefined,17,true,true).fpStats!.totalExpectedFp).toBeCloseTo(expected,10);
    }
  }
  expect(seen.size).toBe(23);
});
