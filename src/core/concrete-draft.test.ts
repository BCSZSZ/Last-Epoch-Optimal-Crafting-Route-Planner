import { expect, it } from 'vitest';
import { Catalog } from './catalog';
import { compileDraft, draftSlotPool, emptyDraft } from './draft';
import { catalogForInputModel } from './input-model';
import { RuleEngine } from './rules';
import { solveCompactProfile } from './finite-policy';
import { summarizeDraftResults } from './draft-summary';

it('compiles the 7372 experiment against only compatible concrete parts', () => {
  const draft = emptyDraft();
  const compiled = compileDraft({ ...draft, counts: [{ desired: 0 }, { desired: 2 }], slots: {
    ...draft.slots, prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null, isExperimental: true },
    suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null },
  } });
  const catalog = new Catalog();
  expect(compiled.issues).toEqual([]);
  expect(compiled.scenarios.every(s => catalog.hasBase(s.request.item.baseId))).toBe(true);
  expect([...new Set(compiled.scenarios.map(s => catalog.base(s.request.item.baseId).baseType))]).toEqual([2, 3, 4]);
});

it('keeps an amulet-only anchor fixed in both random identity actions', () => {
  const draft = emptyDraft();
  const input = { ...draft, targetMode: 'SLOTS' as const, slots: {
    ...draft.slots, prefix1: { tier: 1, id: 0 }, suffix1: { tier: 7, id: 7 },
  }, targetSlots: { ...draft.targetSlots, suffix1: { tier: 7, id: 10 } } };
  expect(draftSlotPool(input, 'suffix1', true)).not.toContain(40);
  expect(draftSlotPool(input, 'suffix1', true)).toContain(10);
  const compiled = compileDraft(input);
  expect(compiled.issues).toEqual([]);
  expect(compiled.scenarios.length).toBeGreaterThan(0);
  for (const { request } of compiled.scenarios) {
    const catalog = catalogForInputModel(request.inputModel), engine = new RuleEngine(catalog);
    expect(catalog.base(request.item.baseId).baseType).toBe(20);
    for (const tier of [7, 4]) {
      const item = { ...request.item, affixes: request.item.affixes.map(a => a.id === 7 ? { ...a, tier } : a) };
      const transition = engine.budgetTransition(item, tier === 7 ? { kind: 'redemption', glyph: 'hope' } : { kind: 'chaos', id: 7 }, request.craftingContext, 44);
      expect(transition.issues).toEqual([]);
      expect(transition.outcomes.every(o => o.item.affixes.every(a => a.id !== 40 && catalog.canRollOn(a.id, item.baseId)))).toBe(true);
    }
    expect(engine.eligibility({ ...request.item, affixes: request.item.affixes.slice(0, 1) }, 44, { kind: 'add', id: 40, glyph: 'hope' }, request.craftingContext).map(x => x.code)).toContain('INCOMPATIBLE_AFFIX');
  }
});

it('rejects mutually exclusive class affixes even when the part is known', () => {
  const draft = emptyDraft(), slots = { ...draft.slots, prefix1: { tier: 7, id: 21 }, prefix2: { tier: 7, id: 53 } };
  for (const part of [0, null]) {
    const compiled = compileDraft({ ...draft, part, targetMode: 'SLOTS', slots, targetSlots: slots });
    expect(compiled.scenarios).toHaveLength(0);
    expect(compiled.issues[0].message).toContain('同一装备');
  }
});

it('preserves real crafting weights for a named target with a blank unrelated starting identity', () => {
  const draft = emptyDraft();
  const compiled = compileDraft({ ...draft, part: 21, targetMode: 'SLOTS',
    slots: { ...draft.slots, prefix1: { tier: 1, id: null }, suffix1: { tier: 7, id: 7 } },
    targetSlots: { ...draft.targetSlots, suffix1: { tier: 7, id: 825 } } });
  expect(compiled.issues).toEqual([]);
  for (const { request } of compiled.scenarios) {
    const catalog = catalogForInputModel(request.inputModel);
    expect(catalog.rerollPool(request.item, 1).find(r => r.id === 825)?.probability).toBeCloseTo(.013422821906282936, 12);
  }
});
it('solves the three 7372 normal policies and averages by part', async () => {
  const draft = emptyDraft();
  const compiled = compileDraft({ ...draft, initialFp: 44, counts: [{ desired: 0 }, { desired: 2 }], slots: {
    ...draft.slots, prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null, isExperimental: true },
    suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null },
  } });
  const probabilities = [.17742502830173376, .20307710958891503, .1703693622145293];
  const results = [];
  for (const [index, scenario] of compiled.scenarios.entries()) {
    const catalog = catalogForInputModel(scenario.request.inputModel);
    const normal = await solveCompactProfile(scenario.request, catalog, 'NORMAL', { stopped: () => false });
    expect(normal?.estimate).toBeCloseTo(probabilities[index], 10);
    expect(normal?.status).toBe('COMPLETE');
    expect(normal?.stepPlan?.steps.length).toBeGreaterThan(0);
    if (!normal) throw new Error('Expected a complete compact policy');
    const report = { finiteProfiles: { profiles: [normal] } };
    results.push({ scenario, report });
  }
  expect(results).toHaveLength(3);
  const summary = summarizeDraftResults(results);
  expect(summary.profiles[0].probability?.lower).toBeCloseTo(.1836238333683927, 9);
  expect(summary.profiles[0].complete).toBe(true);
  expect(summary.profiles[1].probability).toBeNull();
}, 90000);
