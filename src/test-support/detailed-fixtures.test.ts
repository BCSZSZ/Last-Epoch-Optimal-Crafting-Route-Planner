import { expect, it } from 'vitest';
import { compileDraft, emptyDraft } from '../core/draft';
import { catalogForInputModel } from '../core/input-model';
import { planLegacy as plan } from '../core/planner';
import { targetReached } from '../core/target';
import { detailedFixtures } from './detailed-fixtures';

it('binds every specified detailed identity to its exact ID and actual crafting weights', () => {
  for (const fixture of detailedFixtures().filter(row => row.id.startsWith('known-'))) {
    expect(fixture.request.inputModel).toBe('FORGEABLE_WEIGHTED');
    const catalog = catalogForInputModel(fixture.request.inputModel);
    for (const key of ['prefix1','prefix2','suffix1','suffix2'] as const) {
      const row=fixture.draft.slots[key];
      if(row.tier) expect(fixture.request.item.affixes.some(entry=>entry.id===row.id&&entry.tier===row.tier)).toBe(true);
    }
    for (const key of ['prefix1','prefix2','suffix1','suffix2'] as const) {
      const row=fixture.draft.targetSlots[key];
      if(row.tier) expect(fixture.request.target.requirements.some(entry=>entry.ids.length===1&&entry.ids[0]===row.id&&entry.minTier===row.tier)).toBe(true);
    }
    expect(catalog.model.affixes.some(row=>row.weight!==0&&row.weight!==1)).toBe(true);
  }
});

it('keeps a blank identity as a wildcard while empty detailed slots are ignored', () => {
  const fixture=detailedFixtures().find(row=>row.id==='wildcard-prefixes')!;
  expect(fixture.request.target.requirements).toHaveLength(2);
  expect(fixture.request.target.requirements.every(row=>row.ids.length>1&&row.minTier===7&&row.maxTier===7)).toBe(true);
  const partial=detailedFixtures().find(row=>row.id==='partial-wildcard')!;
  expect(partial.request.target.requirements.filter(row=>row.ids.length===1)).toHaveLength(1);
  expect(partial.request.target.requirements.filter(row=>row.ids.length>1)).toHaveLength(1);
  expect(targetReached(fixture.request.item,fixture.request.target)).toBe(false);
});

it('reports an already satisfied detailed target without crafting or searching', async () => {
  const fixture=detailedFixtures().find(row=>row.id==='already-complete')!;
  const report=await plan(fixture.request);
  expect(report.primary!.scoreEstimate).toBe(1);
  expect(report.primary!.expectedFpGivenSuccess).toEqual({lower:0,upper:0});
  expect(report.primary!.route.macros).toEqual([]);
});

it('uses minimum tiers and checks a specified sealed identity separately from ordinary goals', async () => {
  const fixture=detailedFixtures()[0],draft=fixture.draft;
  const minimum=compileDraft({...draft,targetSlots:{...emptyDraft().targetSlots,suffix1:{tier:3,id:draft.slots.suffix1.id}}});
  expect(minimum.issues).toEqual([]);
  expect(minimum.scenarios[0].request.target.requirements[0].maxTier).toBeUndefined();
  expect(targetReached(minimum.scenarios[0].request.item,minimum.scenarios[0].request.target)).toBe(true);
  const sealed=compileDraft({...draft,slots:{...draft.slots,sealed:{tier:1,id:draft.targetSlots.prefix2.id}},
    targetSlots:{...emptyDraft().targetSlots,suffix1:{tier:7,id:draft.slots.suffix1.id},suffix2:{tier:7,id:draft.slots.suffix2.id},
      sealed:{tier:1,id:draft.targetSlots.prefix2.id}}});
  expect(sealed.issues).toEqual([]);
  expect(sealed.scenarios[0].request.target.requirements).toHaveLength(3);
  const report=await plan(sealed.scenarios[0].request);
  expect(report.primary!.expectedFpGivenSuccess).toEqual({lower:0,upper:0});
});

it('rejects invalid detail inputs without changing IDs or relaxing targets', () => {
  const fixture=detailedFixtures()[0],draft=fixture.draft;
  const excessive=compileDraft({...draft,targetSlots:{...draft.targetSlots,suffix1:{tier:7,id:draft.slots.suffix1.id}}});
  expect(excessive.scenarios).toEqual([]);
  expect(excessive.issues.some(row=>row.code==='UNREACHABLE_EXALTED_TIERS')).toBe(true);
  const wrongSide=compileDraft({...draft,targetSlots:{...draft.targetSlots,prefix1:{tier:7,id:draft.slots.suffix1.id}}});
  expect(wrongSide.scenarios).toEqual([]);
  const duplicate=compileDraft({...draft,targetSlots:{...draft.targetSlots,prefix2:draft.targetSlots.prefix1}});
  expect(duplicate.scenarios).toEqual([]);
  const empty=compileDraft({...draft,targetSlots:emptyDraft().targetSlots});
  expect(empty.scenarios).toEqual([]);
});
