import { describe, expect, it } from 'vitest';
import { Catalog, snapshot } from './catalog';
import { compileDraft, DRAFT_SLOTS, draftAffixPool, emptyDraft, readDraft } from './draft';
import type { CraftingDraft } from './draft';
import { catalogForInputModel } from './input-model';
import { plan } from './planner';
import { parsePlanRequest } from './request';
import { targetReached } from './target';

const catalog = catalogForInputModel('FORGEABLE_WEIGHTED');
const source7710 = (): CraftingDraft => ({ ...emptyDraft(), part: 19,
  slots: { prefix1: { tier: 1, id: null }, prefix2: { tier: 0, id: null }, suffix1: { tier: 7, id: null }, suffix2: { tier: 7, id: null }, sealed: { tier: 0, id: null } },
  counts: [{ desired: 2, owned: 0, ownedT7: 0 }, { desired: 0, owned: 0, ownedT7: 0 }] });

describe('minimal draft input and fixed slots', () => {
  it('starts empty without example gear or a hidden default target', () => {
    const draft = emptyDraft();
    expect(draft.part).toBeNull();
    expect(DRAFT_SLOTS).toHaveLength(5);
    expect(Object.values(draft.slots).every((row) => row.tier === 0 && row.id === null)).toBe(true);
    expect(compileDraft(draft).scenarios).toHaveLength(0);
    expect(compileDraft({ ...draft, part: 19 }).issues[0].message).toContain('目标');
  });

  it('retains a valid v2 draft and rejects malformed storage', () => {
    const draft = source7710();
    expect(readDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(readDraft({ ...draft, slots: {} })).toBeNull();
    expect(readDraft({ ...draft, counts: [{ desired: 3, owned: 0, ownedT7: 0 }, draft.counts[1]] })).toBeNull();
    expect(readDraft({ ...draft, version: 1 })).toBeNull();
  });

  it('compiles anonymous 7710 with correct prefix goals and explicit equal-weight assumptions', () => {
    const compiled = compileDraft(source7710());
    expect(compiled.issues).toEqual([]);
    expect(compiled.inputModel).toBe('FORGEABLE_EQUAL');
    expect(compiled.scenarios).toHaveLength(1);
    const { request, aliases } = compiled.scenarios[0];
    expect(request.item.affixes.map((row) => row.tier)).toEqual([1, 7, 7]);
    expect(request.item.affixes.every((row) => row.slot === 'ordinary')).toBe(true);
    expect(new Set(request.item.affixes.map((row) => row.id)).size).toBe(3);
    expect(request.target.requirements).toHaveLength(2);
    for (const goal of request.target.requirements) {
      expect(goal).toMatchObject({ minTier: 7, maxTier: 7, slot: 'ordinary' });
      expect(catalog.side(goal.ids[0])).toBe(0);
      expect(request.item.affixes.some((row) => goal.ids.includes(row.id))).toBe(false);
      expect(aliases[goal.ids[0]]).toContain('待补目标前缀');
    }
    expect(request.craftingContext.playerLevel).toBe(100);
    expect(request.item.itemLevel).toBe(100);
    expect(parsePlanRequest(request, catalogForInputModel(compiled.inputModel)).issues).toEqual([]);
  });

  it('runs tier-only 7710 through the production planner and recovers the independent FP reference', async () => {
    const request = compileDraft(source7710()).scenarios[0].request;
    const report = await plan({ ...request, search: { ...request.search, maxRoutes: 4 } }, { now: () => 0 });
    expect(report.status).toBe('RECOMMENDATION');
    expect(report.inputModel).toBe('FORGEABLE_EQUAL');
    expect(report.primary!.scoreEstimate).toBeCloseTo(1, 10);
    const mean = report.primary!.expectedFpGivenSuccess!;
    expect((mean.lower + mean.upper) / 2).toBeCloseTo(48.8048922892, 7);
  }, 30000);

  it('does not loosen inconsistent owned counts', () => {
    const draft = source7710();
    for (const row of [{ desired: 1, owned: 2, ownedT7: 0 }, { desired: 2, owned: 1, ownedT7: 1 }, { desired: 2, owned: 2, ownedT7: 0 }]) {
      const compiled = compileDraft({ ...draft, counts: [row, draft.counts[1]] });
      expect(compiled.issues.length).toBeGreaterThan(0);
      expect(compiled.scenarios).toHaveLength(0);
    }
  });

  it('enumerates both possible positions of a same-side owned T7, without averaging them', () => {
    const draft = source7710(), compiled = compileDraft({ ...draft, counts: [draft.counts[0], { desired: 1, owned: 1, ownedT7: 1 }] });
    // Three T7 goals cannot be created from only two T7s: validation must reject all scenarios.
    expect(compiled.scenarios).toHaveLength(0);
    const valid = compileDraft({ ...draft, counts: [{ desired: 1, owned: 0, ownedT7: 0 }, { desired: 1, owned: 1, ownedT7: 1 }] });
    expect(valid.issues).toEqual([]);
    expect(valid.scenarios).toHaveLength(2);
    expect(valid.scenarios.map((row) => row.condition)).toEqual(['已有目标位于后缀1', '已有目标位于后缀2']);
    expect(valid.scenarios.map((row) => row.request.search.milliseconds)).toEqual([6000, 6000]);
    expect(new Set(valid.scenarios.map((row) => row.request.target.requirements[1].ids[0])).size).toBe(2);
  });

  it('keeps ordinary counts independent from an occupied seal', () => {
    const draft = source7710(), compiled = compileDraft({ ...draft, slots: { ...draft.slots, sealed: { tier: 1, id: null } } });
    expect(compiled.issues).toEqual([]);
    expect(compiled.scenarios[0].request.item.affixes.filter((row) => row.slot === 'ordinary')).toHaveLength(3);
    expect(compiled.scenarios[0].request.item.affixes.filter((row) => row.slot === 'sealed')).toHaveLength(1);
    expect(compiled.scenarios[0].request.target.requirements.every((row) => row.slot === 'ordinary')).toBe(true);
  });

  it('ignores empty detailed targets and treats tier-only goals as distinct wildcard matches', async () => {
    const draft = source7710(), targetSlots = { ...emptyDraft().targetSlots, suffix1: { tier: 7, id: null }, suffix2: { tier: 7, id: null } };
    const compiled = compileDraft({ ...draft, targetMode: 'SLOTS', targetSlots });
    expect(compiled.issues).toEqual([]);
    expect(compiled.scenarios[0].request.target.requirements).toHaveLength(2);
    const request = compiled.scenarios[0].request;
    expect(targetReached(request.item, request.target)).toBe(true);
    const report = await plan(request, { now: () => 0 });
    expect(report.primary!.route.macros).toHaveLength(0);
    expect(report.primary!.expectedFpGivenSuccess).toEqual({ lower: 0, upper: 0 });
    expect(report.search.evaluatedRoutes).toBe(1);
    expect(report.searchStatus).toBe('COMPLETE');
  });

  it('uses actual weights when all occupied identities are known, while omitting base and level controls', () => {
    const draft = source7710(), anonymous = compileDraft(draft).scenarios[0].request.item.affixes;
    const knownSlots = { ...draft.slots, prefix1: { tier: 1, id: anonymous[0].id }, suffix1: { tier: 7, id: anonymous[1].id }, suffix2: { tier: 7, id: anonymous[2].id } };
    const compiled = compileDraft({ ...draft, slots: knownSlots, targetMode: 'SLOTS', targetSlots: { ...draft.targetSlots, suffix1: { tier: 7, id: anonymous[1].id } } });
    expect(compiled.inputModel).toBe('FORGEABLE_WEIGHTED');
    expect(compiled.issues).toEqual([]);
    expect(compiled.scenarios[0].request.target.requirements[0].ids).toEqual([anonymous[1].id]);
  });

  it('never assigns an anonymous source the identity of an explicitly named missing goal', () => {
    const draft = source7710(), id = draftAffixPool(catalog, 19, 0, 7).find((id) => catalog.hasShard(id))!;
    const compiled = compileDraft({ ...draft, targetMode: 'SLOTS', targetSlots: { ...draft.targetSlots, prefix1: { tier: 7, id } } });
    expect(compiled.issues).toEqual([]);
    expect(compiled.scenarios[0].request.item.affixes.some((row) => row.id === id)).toBe(false);
  });

  it('rejects wrong-side or wrong-part identities rather than silently discarding them', () => {
    const draft = source7710(), suffix = draftAffixPool(catalog, 19, 1, 7)[0];
    expect(compileDraft({ ...draft, slots: { ...draft.slots, prefix1: { tier: 1, id: suffix } } }).scenarios).toHaveLength(0);
  });
});

describe('explicit reference catalogs', () => {
  it('preserves the audited snapshot and zero-weight candidates', () => {
    const audited = new Catalog(), equal = catalogForInputModel('FORGEABLE_EQUAL');
    for (const row of snapshot.affixes) {
      expect(audited.affix(row.id).weight).toBe(row.weight);
      expect(equal.affix(row.id).weight).toBe(row.weight > 0 ? 1 : 0);
      expect(equal.affix(row.id).overrides.map((entry) => entry.weight)).toEqual(row.overrides.map((entry) => entry.weight > 0 ? 1 : 0));
    }
    expect(audited.model.rngModel).not.toBe(equal.model.rngModel);
    expect(equal.model.bases.every((row) => row.classRequirement === 31)).toBe(true);
  });
});
