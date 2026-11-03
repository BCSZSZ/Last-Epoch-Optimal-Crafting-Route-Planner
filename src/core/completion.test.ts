import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluateCompletion } from './completion';
import { completionRecommendation } from './policy';
import { Catalog } from './catalog';
import { catalogForInputModel } from './input-model';
import { exampleRequest } from './examples';
import { RuleEngine } from './rules';
import { reportRoute } from './evaluation';
import type { AtomicAction, PlanRequest, Route } from './types';

const mid = (p: {lower:number;upper:number}) => (p.lower + p.upper) / 2;
describe('48FP completion, separately from intrinsic operation success', () => {
  it('uses strict25% and65% labels, preserving equalities and arithmetic uncertainty', () => {
    expect(completionRecommendation({lower:.2499,upper:.24999})).toBe('NOT_RECOMMENDED');
    expect(completionRecommendation({lower:.25,upper:.25})).toBe('NEUTRAL');
    expect(completionRecommendation({lower:.65,upper:.65})).toBe('NEUTRAL');
    expect(completionRecommendation({lower:.650001,upper:.650002})).toBe('RECOMMENDED');
    expect(completionRecommendation({lower:.2499,upper:.2501})).toBe('UNRESOLVED');
    expect(completionRecommendation({lower:.6499,upper:.6501})).toBe('UNRESOLVED');
    expect(completionRecommendation({lower:.68,upper:.68},{recommendedAbove:.7,notRecommendedBelow:.25})).toBe('NEUTRAL');
  });
  it('preserves the native joint state/critical/cost distribution at every tested balance', () => {
    for (const fpType of ['NORMAL','ICE','BLOOD'] as const) {
      const base = exampleRequest(), request = {...base,item:{...base.item,fpType}}, engine = new RuleEngine();
      const actions: AtomicAction[] = [{kind:'add',id:4,glyph:'hope'}, {kind:'seal',id:2},
        {kind:'removal',glyph:'hope',acceptedIds:[2]}];
      for (const action of actions) {
        const joint = engine.budgetTransition(request.item,action,request.craftingContext,48);
        expect(joint.issues).toEqual([]);
        for (const fp of [1,2,3,48]) {
          const expected = new Map<string,number>(), actual = new Map<string,number>();
          for (const row of engine.transition(request.item,fp,action,request.craftingContext).outcomes) {
            const key=JSON.stringify([row.item,row.fp,row.abort]); expected.set(key,(expected.get(key)??0)+row.probability);
          }
          for (const row of joint.outcomes) for (const fee of row.balances[fp]) {
            const key=JSON.stringify([row.item,fee.value,row.abort]); actual.set(key,(actual.get(key)??0)+mid(row.probability)*fee.bounds.midpoint);
          }
          expect(new Set(actual.keys())).toEqual(new Set(expected.keys()));
          for (const [key,p] of actual) expect(p).toBeCloseTo(expected.get(key)!,12);
        }
      }
    }
  });
  it('agrees with the independent Python Redemption48FP recurrence, with real weights and fixed branches', () => {
    const frozen=JSON.parse(readFileSync(new URL('../../research/fixtures/redemption-7272-public-input.json',import.meta.url),'utf8'));
    const request:PlanRequest={...frozen.input,inputModel:'AUDITED'}, engine=new RuleEngine(new Catalog());
    const value=evaluateCompletion(engine,request,frozen.route);
    expect(mid(value.probability!)).toBeCloseTo(.25035142584727316,9);
    expect(value.probability!.upper-value.probability!.lower).toBeLessThan(1e-7);
    expect(value.recommendation).toBe('NEUTRAL');
  },30000);
  it('agrees with all-budget independent7710 reference and allows the final exhausting craft to succeed', () => {
    const request=exampleRequest(), engine=new RuleEngine();
    const selector={side:0 as const,excludedIds:[4,5],minTier:1,maxTier:1,sealable:true};
    const route:Route={id:'7710',macros:[{kind:'once',action:{kind:'add',id:4,glyph:'hope'}},
      {kind:'repeat',action:{kind:'havoc',glyph:'hope'},until:{kind:'exists',selector}}, {kind:'seal',selector},
      {kind:'once',action:{kind:'add',id:5,glyph:'hope'}}, {kind:'repeat',action:{kind:'havoc',glyph:'hope'},until:{kind:'target'}}]};
    const reference=reportRoute(engine,request,route).curve.find(row=>row.initialFp===48)!;
    const actual=evaluateCompletion(engine,request,route);
    expect(mid(actual.probability!)).toBeCloseTo(mid(reference.successProbability),10);
    const base=exampleRequest(), small:PlanRequest={...base,item:{...base.item,affixes:[]},target:{requirements:[{ids:[4],minTier:1,slot:'ordinary'}]}};
    const add:Route={id:'last',macros:[{kind:'once',action:{kind:'add',id:4,glyph:'hope'}}]};
    expect(evaluateCompletion(engine,small,add,undefined,0).probability).toEqual({lower:0,upper:0});
    expect(mid(evaluateCompletion(engine,small,add,undefined,1).probability!)).toBeCloseTo(1,12);
  });
  it('reports cancellation or state exhaustion without fabricating a probability', () => {
    const request=exampleRequest(), engine=new RuleEngine(catalogForInputModel());
    const route:Route={id:'add',macros:[{kind:'once',action:{kind:'add',id:4,glyph:'hope'}}]};
    expect(()=>evaluateCompletion(engine,request,route,()=>true)).toThrow(/取消|超时/);
    expect(()=>evaluateCompletion(engine,{...request,search:{...request.search,maxStates:1}},route)).toThrow(/状态预算/);
  });
  it('solves terminating free Havoc loops and rejects an unreachable stopping layout', () => {
    const source = new Catalog().model, engine = new RuleEngine(new Catalog({...source,parameters:{...source.parameters,hope:1}}));
    const base = exampleRequest(), item={...base.item,affixes:[[4,7],[7,7],[5,1],[10,1]].map(([id,tier])=>({id,tier,slot:'ordinary' as const,roll:null}))};
    const request={...base,item};
    const route:Route={id:'free',macros:[{kind:'repeat',action:{kind:'havoc',glyph:'hope'},until:{kind:'target'}}]};
    expect(mid(evaluateCompletion(engine,request,route,undefined,1).probability!)).toBeCloseTo(1,10);
    const missing:PlanRequest={...request,target:{requirements:[{ids:[6],minTier:7,slot:'ordinary'}]}};
    expect(evaluateCompletion(engine,missing,route).probability).toEqual({lower:0,upper:0});
  });
  it('agrees with both previously sampled48FP validation cases', () => {
    const record=JSON.parse(readFileSync(new URL('../../research/fp65-budget48.json',import.meta.url),'utf8'));
    for (const row of record.rows) {
      const actual=evaluateCompletion(new RuleEngine(),row.request,row.route);
      expect(actual.probability!.lower).toBeGreaterThan(row.finiteCompletionInterval.lower);
      expect(actual.probability!.upper).toBeLessThan(row.finiteCompletionInterval.upper);
    }
  },30000);
});
