/** Exact identity quotient AFTER the final reroll, for no-roll, level100 vacancy programs. */
import type { Catalog } from './catalog';
import type { Item, Macro, PlanRequest, Predicate, Route, Selector } from './types';

export function programProjection(request:PlanRequest,route:Route,catalog:Catalog):{afterStage:number;key:string;project:(item:Item)=>Item}|null{
  if(!request.item.affixes.some(row=>row.slot==='ordinary'&&catalog.affix(row.id).special===1))return null;
  const afterStage=route.macros.findIndex(m=>m.kind==='once'&&m.action.kind==='redemption');
  if(afterStage<0 || request.item.itemLevel!==100 || request.craftingContext.playerLevel!==100 || request.constraints.protected?.length ||
    request.target.requirements.some(r=>r.ids.length!==1||r.minRollByte!==undefined))return null;
  const pinned=new Set(request.target.requirements.flatMap(r=>r.ids));
  const selector=(s:Selector)=>{s.ids?.forEach(id=>pinned.add(id));s.excludedIds?.forEach(id=>pinned.add(id));return !s.eligibleAction||s.eligibleAction==='removal';};
  const predicate=(p:Predicate):boolean=>{
    if(p.kind==='all'||p.kind==='any')return p.predicates.every(predicate);
    if(p.kind==='exists'||p.kind==='count')return selector(p.selector);
    if(p.kind==='identity'){p.requirement.ids.forEach(id=>pinned.add(id));return p.requirement.minRollByte===undefined;}
    return p.kind==='target';
  };
  const allowed=(values:readonly Macro[]):boolean=>values.every(m=>{
    if(m.kind==='conditional')return predicate(m.when)&&allowed(m.then)&&allowed(m.otherwise??[]);
    if(m.kind==='fill')return m.ids.every(id=>catalog.affix(id).special===0&&catalog.hasShard(id));
    if(m.kind==='once'){if(m.action.kind!=='add')return false;pinned.add(m.action.id);return true;}
    if(m.kind==='repeat')return m.action.kind==='havoc'&&predicate(m.until);
    return m.kind==='seal'?selector(m.selector):m.kind==='removal'&&selector(m.accepted);
  });
  if(!allowed(route.macros.slice(afterStage+1)))return null;
  const eligible=(id:number)=>catalog.affix(id).special===0&&catalog.affix(id).tiers.length>=7&&catalog.hasShard(id)&&catalog.canRollOn(id,request.item.baseId);
  const pools=([0,1]as const).map(side=>catalog.model.affixes.filter(r=>r.side===side&&!pinned.has(r.id)&&eligible(r.id)).map(r=>r.id).sort((a,b)=>a-b));
  return {afterStage,key:[...pinned].sort((a,b)=>a-b).join(','),project:(item)=>{
    const used=new Set(item.affixes.filter(r=>pinned.has(r.id)||!eligible(r.id)).map(r=>r.id));
    const affixes=item.affixes.map(row=>{
      if(pinned.has(row.id)||!eligible(row.id))return row;
      const id=pools[catalog.side(row.id)].find(id=>!used.has(id));
      if(id===undefined)throw new Error('Insufficient identity quotient representatives');
      used.add(id);return id===row.id?row:{...row,id};
    });
    return {...item,affixes};
  }};
}
