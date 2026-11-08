import { compileDraft, emptyDraft } from '../core/draft';
import type { CraftingDraft, DraftSlotKey } from '../core/draft';
import type { PlanRequest } from '../core/types';

export interface DetailedFixture { readonly id: string; readonly draft: CraftingDraft; readonly request: PlanRequest }

export function detailedFixtures(): readonly DetailedFixture[] {
  const source = emptyDraft(), keys: readonly DraftSlotKey[] = ['prefix1', 'prefix2', 'suffix1', 'suffix2'];
  const specs = [
    {id:'known-7710', tiers:[1,0,7,7], marked:[], desired:[2,0]},
    {id:'known-7732', tiers:[7,3,7,2], marked:[], desired:[1,1]},
    {id:'known-7271', tiers:[7,2,7,1], marked:[1], desired:[2,0]},
  ];
  const results: DetailedFixture[] = specs.map(spec => {
    const slots = {...source.slots};
    keys.forEach((key,index) => {slots[key]={tier:spec.tiers[index],id:null,isTarget:spec.marked.includes(index)};});
    const base = {...source,part:1,slots,counts:[{desired:spec.desired[0]},{desired:spec.desired[1]}] as const};
    const reference = compileDraft(base).scenarios[0];
    let at=0;
    for(const key of keys) if(slots[key].tier) slots[key]={...slots[key],id:reference.request.item.affixes[at++].id};
    const targets={...source.targetSlots}, positions=[0,0];
    for(const row of reference.request.target.requirements){
      const side=spec.desired[0]===2 ? 0 : positions[0]===0 ? 0 : 1;
      const key=(side===0 ? ['prefix1','prefix2'] : ['suffix1','suffix2'])[positions[side]++] as DraftSlotKey;
      targets[key]={tier:7,id:row.ids[0]};
    }
    const draft: CraftingDraft={...base,slots,targetMode:'SLOTS',targetSlots:targets};
    const compiled=compileDraft(draft);
    if(compiled.issues.length || !compiled.scenarios.length) throw new Error('Invalid detailed fixture '+spec.id+JSON.stringify(compiled.issues));
    return {id:spec.id,draft,request:compiled.scenarios[0].request};
  });
  const base=results[0].draft;
  const wild: CraftingDraft={...base,targetSlots:{...source.targetSlots,prefix1:{tier:7,id:null},prefix2:{tier:7,id:null}}};
  results.push({id:'wildcard-prefixes',draft:wild,request:compileDraft(wild).scenarios[0].request});
  const partial: CraftingDraft={...base,targetSlots:{...source.targetSlots,prefix1:base.targetSlots.prefix1,suffix1:{tier:7,id:null}}};
  results.push({id:'partial-wildcard',draft:partial,request:compileDraft(partial).scenarios[0].request});
  const done: CraftingDraft={...base,targetSlots:{...source.targetSlots,suffix1:{tier:7,id:base.slots.suffix1.id},suffix2:{tier:7,id:base.slots.suffix2.id}}};
  results.push({id:'already-complete',draft:done,request:compileDraft(done).scenarios[0].request});
  return results;
}
