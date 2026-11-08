import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileDraft, emptyDraft, readDraft } from './draft';
import { catalogForInputModel } from './input-model';
import { solveCompactProfile } from './finite-policy';
import { replayFiniteProfile } from './finite-replay';
import { parsePlanRequest } from './request';
import type { PlanRequest } from './types';
import { plan } from './planner';
import { DEFAULT_INITIAL_FP, initialFp } from './initial-fp';

it('preserves a blank default and custom starting FP in both draft modes and saved drafts',()=>{
  const base=emptyDraft();
  for(const targetMode of ['COUNTS','SLOTS']as const)for(const fp of [undefined,0,12,48,63]){
    const draft={...base,part:4,targetMode,initialFp:fp,slots:{...base.slots,prefix1:{tier:7,id:null},prefix2:{tier:1,id:null},suffix1:{tier:7,id:null}},
      counts:[{desired:1},{desired:1}]as const,targetSlots:{...base.targetSlots,prefix1:{tier:7,id:null},suffix1:{tier:7,id:null}}};
    const saved=readDraft(JSON.parse(JSON.stringify(draft)))!,compiled=compileDraft(saved);
    expect(compiled.issues).toEqual([]);expect(compiled.scenarios[0].request.initialFp).toBe(fp);
  }
});

it('uses the chosen balance in optimization, cache reuse, FP rewards and policy export replay',async()=>{
  const source=JSON.parse(readFileSync(new URL('../../research/fixtures/finite48-three-profiles-99.json',import.meta.url),'utf8')).rows[0].request as PlanRequest;
  const catalog=catalogForInputModel(source.inputModel),base={...source,modelId:catalog.model.modelId};
  let previous=0;
  for(const fp of [0,1,12,48,63]){
    const row=(await solveCompactProfile({...base,initialFp:fp},catalog,'NORMAL',{stopped:()=>false}))!;
    expect(row.initialFp).toBe(fp);expect(row.estimate!).toBeGreaterThanOrEqual(previous-1e-10);previous=row.estimate!;
    expect(row.actualMeanFp!).toBeLessThanOrEqual(fp+1e-8);
    if(fp===48)expect(row.estimate).toBeCloseTo(.3303892999907479,10);
    if(fp===12)expect((await replayFiniteProfile({...base,initialFp:fp},catalog,row)).probability).toBeCloseTo(row.estimate!,9);
  }
  const reused=(await solveCompactProfile({...base,initialFp:12},catalog,'NORMAL',{stopped:()=>false}))!;
  expect(reused.initialFp).toBe(12);expect(reused.decisions.every(d=>d.fp.every(fp=>fp<=12))).toBe(true);
  const invalid=parsePlanRequest({...base,initialFp:64},catalog);expect(invalid.request).toBeNull();
},30000);

it('0FP cannot perform another action but an already satisfied target is still success',async()=>{
  const source=JSON.parse(readFileSync(new URL('../../research/fixtures/finite48-three-profiles-99.json',import.meta.url),'utf8')).rows[0].request as PlanRequest;
  const catalog=catalogForInputModel(source.inputModel),base={...source,modelId:catalog.model.modelId,initialFp:0};
  const no=await plan(base,{now:()=>0});expect(no.finiteProfiles!.profiles.every(p=>p.estimate===0&&p.actualMeanFp===0)).toBe(true);
  const done={...base,item:{...base.item,affixes:base.target.requirements.map(r=>({id:r.ids[0],tier:7,slot:'ordinary' as const,roll:null}))}};
  expect((await plan(done,{now:()=>0})).finiteProfiles!.profiles.every(p=>p.estimate===1&&p.actualMeanFp===0)).toBe(true);
},30000);

it('defaults omitted starting FP to the natural exalted70th percentile, preserving explicit48FP',async()=>{
  const distribution=JSON.parse(readFileSync(new URL('../../research/natural-fp-percentile-20261108.json',import.meta.url),'utf8'));
  expect(DEFAULT_INITIAL_FP).toBe(distribution.recommendedDefaultFp);expect(DEFAULT_INITIAL_FP).toBe(44);
  expect(initialFp({})).toBe(44);expect(initialFp({initialFp:48})).toBe(48);
  const source=JSON.parse(readFileSync(new URL('../../research/fixtures/finite48-three-profiles-99.json',import.meta.url),'utf8')).rows[0].request as PlanRequest;
  const catalog=catalogForInputModel(source.inputModel),input={...source,modelId:catalog.model.modelId};
  const report=await plan(input,{now:()=>0});
  expect(report.finiteProfiles!.initialFp).toBe(44);
  for(const row of report.finiteProfiles!.profiles){
    const explicit=await solveCompactProfile({...input,initialFp:44},catalog,row.fpType,{stopped:()=>false});
    expect(row.initialFp).toBe(44);expect(row.estimate).toBeCloseTo(explicit!.estimate!,10);
    expect(row.actualMeanFp!).toBeLessThanOrEqual(44);
  }
},30000);
