import { expect, it } from 'vitest';
import { compileDraft, emptyDraft } from './draft';
import { AVERAGE_BASE_ID, AVERAGE_EXPERIMENT_BASE_ID, catalogForInputModel, poolSizes } from './input-model';
import { compactDomain } from './finite-state';

it('plans only one averaged equipment for a completely anonymous Any draft', () => {
  const draft = emptyDraft();
  const compiled = compileDraft({ ...draft, slots: { ...draft.slots,
    prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null },
    suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null },
  }, counts: [{ desired: 0 }, { desired: 2 }] });
  expect(compiled.issues).toEqual([]);
  expect(compiled.scenarios).toHaveLength(1);
  expect(compiled.inputModel).toBe('AVERAGE_EQUAL');
  const { request } = compiled.scenarios[0], catalog = catalogForInputModel(request.inputModel);
  expect(request.item.baseId).toBe(AVERAGE_BASE_ID);
  expect(poolSizes(catalog, request.item.baseId)).toEqual([22, 19]);
  expect(compactDomain(request, catalog)?.poolSizes).toEqual([22, 19]);
});
it('uses the experiment-compatible average and keeps the experimental identity outside the ordinary draw pool', () => {
  const draft = emptyDraft(), compiled = compileDraft({ ...draft, counts: [{ desired: 0 }, { desired: 2 }], slots: {
    ...draft.slots, prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null, isExperimental: true },
    suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null },
  } });
  expect(compiled.issues).toEqual([]);
  expect(compiled.scenarios).toHaveLength(1);
  const { request } = compiled.scenarios[0], catalog = catalogForInputModel(request.inputModel);
  expect(request.item.baseId).toBe(AVERAGE_EXPERIMENT_BASE_ID);
  expect(compactDomain(request, catalog)).toMatchObject({ poolSizes: [15, 19], experimentalRole: 4 });
  expect(catalog.rerollPool(request.item, 0).every(a => catalog.affix(a.id).special === 0)).toBe(true);
});

it('keeps detailed anonymous targets on the same virtual pool', () => {
  const draft = emptyDraft();
  const compiled = compileDraft({ ...draft, targetMode: 'SLOTS', slots: { ...draft.slots, suffix1: { tier: 7, id: null } },
    targetSlots: { ...draft.targetSlots, suffix1: { tier: 7, id: null } } });
  expect(compiled.issues).toEqual([]);
  expect(compiled.scenarios).toHaveLength(1);
  const { request } = compiled.scenarios[0], catalog = catalogForInputModel(request.inputModel);
  expect(request.target.requirements[0].ids).toHaveLength(19);
  expect(request.target.requirements[0].ids.every(id => catalog.canRollOn(id, request.item.baseId))).toBe(true);
});

it('chooses one legal concrete group for named Any drafts and preserves its native weights', () => {
  const draft = emptyDraft(), compiled = compileDraft({ ...draft, targetMode: 'SLOTS',
    slots: { ...draft.slots, suffix1: { tier: 7, id: 7 } },
    targetSlots: { ...draft.targetSlots, suffix1: { tier: 7, id: 825 } } });
  expect(compiled.issues).toEqual([]);
  expect(compiled.scenarios).toHaveLength(1);
  const { request } = compiled.scenarios[0], catalog = catalogForInputModel(request.inputModel);
  const audited = catalogForInputModel();
  expect(request.inputModel).toBe('CONCRETE_WEIGHTED');
  expect(audited.hasBase(request.item.baseId)).toBe(true);
  expect([7, 825].every(id => audited.canRollOn(id, request.item.baseId))).toBe(true);
  expect(catalog.rerollPool(request.item, 1)).toEqual(audited.rerollPool(request.item, 1));
});
