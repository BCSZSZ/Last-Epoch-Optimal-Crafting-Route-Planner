import { compileDraft, emptyDraft } from '../core/draft';
import type { CraftingDraft, DraftSlotKey } from '../core/draft';
export function experimentalFixtures(part:number|null=null,detailed=false){
  const keys:DraftSlotKey[]=['prefix1','prefix2','suffix1','suffix2'];
  return ['1771','7712','7710','1770'].flatMap(pattern=>[false,true].map(owned=>{
    const source=emptyDraft(),slots={...source.slots};
    keys.forEach((key,i)=>{slots[key]={tier:Number(pattern[i]),id:null,isTarget:i===0&&owned,...(i===1?{isExperimental:true}:{})};});
    let draft:CraftingDraft={...source,part,slots,counts:[{desired:2},{desired:0}]};
    if(detailed){
      const anonymous=compileDraft(draft).scenarios[0].request;let index=0;
      for(const key of keys)if(slots[key].tier)slots[key]={...slots[key],id:anonymous.item.affixes[index++].id};
      draft={...draft,slots,targetMode:'SLOTS',targetSlots:{...source.targetSlots,prefix1:{tier:7,id:anonymous.target.requirements[0].ids[0]},prefix2:{tier:7,id:anonymous.target.requirements[1].ids[0]}}};
    }
    const compiled=compileDraft(draft);if(compiled.issues.length||compiled.scenarios.length!==1)throw new Error(JSON.stringify(compiled.issues));
    return {id:pattern+'-owned'+Number(owned),draft,request:compiled.scenarios[0].request};
  }));
}
