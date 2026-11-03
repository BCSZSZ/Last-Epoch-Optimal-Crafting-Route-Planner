/** All visible slot/tier and owned-target positions for the user's two patterns. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { catalogForInputModel } from '../src/core/input-model';
import { plan } from '../src/core/planner';
import { tierPermutations } from '../src/core/probability';
import type { Affix, FpType, PlanRequest } from '../src/core/types';

const catalog = catalogForInputModel('FORGEABLE_EQUAL'), baseId = '4:0';
const slots = ['前缀1','前缀2','后缀1','后缀2'];
const eligible = ([0,1] as const).map(side => catalog.model.affixes.filter(row => row.side === side && row.special === 0 &&
  row.tiers.length >= 7 && catalog.canRollOn(row.id,baseId) && catalog.hasShard(row.id) && catalog.craftWeight(row.id,baseId)>0).map(row=>row.id));
const cases = [];
for (const pattern of ['7710','7721'] as const) for (const tiers of tierPermutations(pattern === '7710' ? [7,7,1,0] : [7,7,2,1])) {
  const affixes: Affix[] = [], used = new Set<number>(), bySlot = new Map<number,number>();
  for (let i=0;i<4;i++) if (tiers[i]) {
    const id=eligible[i<2?0:1].find(id=>!used.has(id))!; used.add(id); bySlot.set(i,id);
    affixes.push({id,tier:tiers[i],slot:'ordinary',roll:null});
  }
  const goalSettings = pattern === '7710' ? [[0,0],[0,1],[1,1]].map(sides=>({existingSlot:null as number|null,sides})) :
    [0,1,2,3].flatMap(existingSlot=>[0,1].map(newSide=>({existingSlot,sides:[existingSlot<2?0:1,newSide]})));
  for (const setting of goalSettings) {
    const taken = new Set(used), targets: number[]=[];
    for (let j=0;j<2;j++) {
      const id=j===0 && setting.existingSlot!==null ? bySlot.get(setting.existingSlot)! : eligible[setting.sides[j]].find(id=>!taken.has(id))!;
      targets.push(id); taken.add(id);
    }
    const sideCounts=[setting.sides.filter(side=>side===0).length,setting.sides.filter(side=>side===1).length];
    for (const fpType of ['NORMAL','ICE','BLOOD'] satisfies FpType[]) {
      const request:PlanRequest={modelId:MODEL_ID,inputModel:'FORGEABLE_EQUAL',item:{baseId,itemLevel:100,fpType,corrupted:false,affixes},
        craftingContext:{playerLevel:100},target:{requirements:targets.map(id=>({ids:[id],minTier:7,maxTier:7,slot:'ordinary'}))},
        constraints:{},scoring:{},search:{milliseconds:12000,maxRoutes:48,macroStages:12,maxStates:512}};
      const result=await plan(request,{now:()=>0});
      assert.notEqual(result.status,'INVALID_INPUT');
      if(result.primary) {
        assert(result.primary.expectedFpGivenSuccess!.upper<=65);
        assert.equal(result.completion?.status,'COMPLETE');
        assert.equal(result.completion?.routeId,result.primary.route.id);
      }
      const row={pattern,slotTiers:tiers,fpType,targetSides:sideCounts,
        existingGoalSlot:setting.existingSlot===null?null:slots[setting.existingSlot],
        existingGoalTier:setting.existingSlot===null?null:tiers[setting.existingSlot],
        request,status:result.status,searchStatus:result.searchStatus,optimality:result.optimality,
        routeId:result.primary?.route.id??null,routeDescription:result.primary?.route.description??null,
        operationSuccess:result.primary?.score??null,successMeanFp:result.primary?.expectedFpGivenSuccess??null,
        completion:result.completion??null,evaluatedRoutes:result.search.evaluatedRoutes,unresolvedRoutes:result.unresolvedRoutes};
      cases.push(row);
      if(cases.length%12===0 || cases.length<=3) console.log(JSON.stringify({done:cases.length,...row,request:undefined}));
    }
  }
}
assert.equal(cases.filter(row=>row.pattern==='7710').length,108);
assert.equal(cases.filter(row=>row.pattern==='7721').length,288);
const summaries=[];
for(const pattern of ['7710','7721']) for(const fpType of ['NORMAL','ICE','BLOOD']) for(const tier of pattern==='7710'?[null]:[7,2,1]) {
  const rows=cases.filter(row=>row.pattern===pattern&&row.fpType===fpType&&row.existingGoalTier===tier);
  const values=rows.flatMap(row=>row.completion?.probability?[(row.completion.probability.lower+row.completion.probability.upper)/2]:[]);
  summaries.push({pattern,fpType,existingGoalTier:tier,cases:rows.length,
    recommended:rows.filter(row=>row.completion?.recommendation==='RECOMMENDED').length,
    notRecommended:rows.filter(row=>row.completion?.recommendation==='NOT_RECOMMENDED').length,
    neutral:rows.filter(row=>row.completion?.recommendation==='NEUTRAL').length,
    unresolved:rows.filter(row=>row.completion?.recommendation==='UNRESOLVED').length,
    abandoned:rows.filter(row=>!row.routeId).length,minCompletion:values.length?Math.min(...values):null,maxCompletion:values.length?Math.max(...values):null});
}
const result={schemaVersion:1,modelId:MODEL_ID,date:'2026-11-04',status:'PASS',baseId,
  qualification:'All12 visible tier permutations per pattern, three target-side counts for7710 and four owned-target slots by two new-target sides for7721, each across three FP types:396cases. Standard affixes, empty sealed slot, two finalT7 targets. Equal-positive glove reference pool because identities were not supplied. All native slot orders retained. Same production48-template grammar and intrinsic ranking, with a deterministic512-state per-template research budget (UI default25000); clocks frozen. Unfinished candidates remain unresolved; a found recommendation is a valid witness, while lack of one does not prove no strategy can qualify. Not a performance or global-optimality claim. Whole completion uses certified finite-balance recurrence, not sampling or mean conversion.',
  summaries,cases,sourceSha256:Object.fromEntries(['src/generated/model.json','scripts/research_7710_7721_completion.ts'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]))};
const encoded=JSON.stringify(result,null,2)+'\n',path='research/7710-7721-completion.json';
if(process.argv.includes('--verify-only')) assert.equal(readFileSync(path,'utf8'),encoded); else writeFileSync(path,encoded);
console.log(JSON.stringify({status:'PASS',modelId:MODEL_ID,cases:cases.length,summaries}));
