import { describe, expect, it } from 'vitest';
import { Catalog, snapshot } from './catalog';
import { compileDraft, DRAFT_SLOTS, draftAffixPool, emptyDraft, ownedGoalCounts, readDraft, withDraftSlots } from './draft';
import type { CraftingDraft } from './draft';
import { ANY_BASE_ID, catalogForInputModel } from './input-model';
import { plan } from './planner';
import { parsePlanRequest } from './request';
import { targetReached } from './target';

const catalog = catalogForInputModel('FORGEABLE_WEIGHTED');
const source7710 = (): CraftingDraft => ({ ...emptyDraft(), part: 19,
  slots: { prefix1: { tier: 1, id: null, isTarget: false }, prefix2: { tier: 0, id: null, isTarget: false }, suffix1: { tier: 7, id: null, isTarget: false }, suffix2: { tier: 7, id: null, isTarget: false }, sealed: { tier: 0, id: null, isTarget: false } },
  counts: [{ desired: 2 }, { desired: 0 }] });

describe('minimal draft input and fixed slots', () => {
  it('starts empty without example gear or a hidden default target', () => {
    const draft = emptyDraft();
    expect(draft.part).toBeNull();
    expect(DRAFT_SLOTS).toHaveLength(5);
    expect(Object.values(draft.slots).every((row) => row.tier === 0 && row.id === null)).toBe(true);
    expect(compileDraft(draft).scenarios).toHaveLength(0);
    expect(compileDraft({ ...draft, part: 19 }).issues[0].message).toContain('目标');
  });

  it('retains a valid v3 draft and rejects malformed storage', () => {
    const draft = source7710();
    expect(readDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(readDraft({ ...draft, slots: {} })).toBeNull();
    expect(readDraft({ ...draft, counts: [{ desired: 3 }, draft.counts[1]] })).toBeNull();
    expect(readDraft({ ...draft, version: 1 })).toBeNull();
    expect(readDraft({ ...draft, version: '3' })).toBeNull();
    expect(readDraft({ ...draft, slots: { ...draft.slots, prefix2: { ...draft.slots.prefix2, isTarget: true } } })).toBeNull();
    expect(readDraft({ ...draft, slots: { ...draft.slots, sealed: { tier: 1, id: null, isTarget: true } } })).toBeNull();
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

  it('rejects a goal count smaller than the explicitly marked targets', () => {
    const draft = source7710(), compiled = compileDraft({ ...draft, counts: [{ desired: 0 }, { desired: 1 }],
      slots: { ...draft.slots, prefix1: { ...draft.slots.prefix1, isTarget: true } } });
    expect(compiled.issues.length).toBeGreaterThan(0);
    expect(compiled.scenarios).toHaveLength(0);
  });

  it('uses the exact marked T7 slot and no longer enumerates other same-tier positions', () => {
    const draft = source7710(), marked = withDraftSlots({ ...draft, counts: [{ desired: 1 }, { desired: 1 }] },
      { ...draft.slots, suffix2: { ...draft.slots.suffix2, isTarget: true } }, 1);
    const valid = compileDraft(marked);
    expect(valid.issues).toEqual([]);
    expect(valid.scenarios).toHaveLength(1);
    expect(valid.scenarios[0].request.target.requirements[1].ids).toEqual([valid.scenarios[0].request.item.affixes[2].id]);
    expect(valid.scenarios[0].request.search.milliseconds).toBe(12000);
    expect(ownedGoalCounts(marked, 1)).toEqual({ desired: 1, owned: 1, ownedT7: 1 });
  });

  it('updates readonly counts after a tier change and clears membership when the slot is emptied', () => {
    const draft = source7710();
    const marked = withDraftSlots(draft, { ...draft.slots, suffix2: { ...draft.slots.suffix2, isTarget: true } }, 1);
    expect(marked.counts[1].desired).toBe(1);
    const low = withDraftSlots(marked, { ...marked.slots, suffix2: { ...marked.slots.suffix2, tier: 2 } });
    expect(ownedGoalCounts(low, 1)).toEqual({ desired: 1, owned: 1, ownedT7: 0 });
    const empty = withDraftSlots(low, { ...low.slots, suffix2: { ...low.slots.suffix2, tier: 0 } });
    expect(empty.slots.suffix2.isTarget).toBe(false);
    expect(ownedGoalCounts(empty, 1)).toEqual({ desired: 1, owned: 0, ownedT7: 0 });
  });

  it('migrates uniquely located v2 ownership without losing identities or the selected part', () => {
    const draft = source7710(), migrated = readDraft({ ...draft, version: 2,
      counts: [{ desired: 2, owned: 1, ownedT7: 0 }, { desired: 0, owned: 0, ownedT7: 0 }] })!;
    expect(migrated.part).toBe(draft.part);
    expect(migrated.slots.prefix1.isTarget).toBe(true);
    expect(migrated.legacyOwnership).toBeUndefined();
    expect(compileDraft(migrated).issues).toEqual([]);
  });

  it('preserves ambiguous v2 counts and asks for the actual slot instead of silently choosing one', () => {
    const draft = source7710(), migrated = readDraft({ ...draft, version: 2,
      counts: [{ desired: 1, owned: 0, ownedT7: 0 }, { desired: 1, owned: 1, ownedT7: 1 }] })!;
    expect(migrated.legacyOwnership).toEqual([{ side: 1, owned: 1, ownedT7: 1 }]);
    expect(compileDraft(migrated).issues[0].message).toContain('左侧');
    const confirmed = withDraftSlots(migrated, { ...migrated.slots, suffix2: { ...migrated.slots.suffix2, isTarget: true } }, 1);
    expect(confirmed.legacyOwnership).toBeUndefined();
    expect(compileDraft(confirmed).scenarios).toHaveLength(1);
  });

  it('runs unspecified equipment without selecting a hidden real part', async () => {
    const draft = { ...source7710(), part: null }, compiled = compileDraft(draft);
    expect(compiled.issues).toEqual([]);
    expect(compiled.inputModel).toBe('FORGEABLE_ANY_EQUAL');
    expect(compiled.scenarios[0].request.item.baseId).toBe(ANY_BASE_ID);
    const request = compiled.scenarios[0].request;
    const report = await plan({ ...request, search: { ...request.search, maxRoutes: 4 } }, { now: () => 0 });
    expect(report.primary!.scoreEstimate).toBeCloseTo(1, 10);
    expect(report.completion!.probability!.lower).toBeGreaterThan(.65);
  }, 30000);

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
  it('makes the Any pool an explicit equal union and preserves zero-weight exclusions and the audited database', () => {
    const any = catalogForInputModel('FORGEABLE_ANY_EQUAL'), audited = new Catalog();
    const types = new Set(snapshot.bases.filter(base => base.ordinaryEquipment && !base.corrupted && !base.obsolete && !base.legacy).map(base => base.equipmentType));
    expect(any.model.bases).toHaveLength(1);
    expect(any.base(ANY_BASE_ID).baseType).toBe(-1);
    expect(audited.hasBase(ANY_BASE_ID)).toBe(false);
    for (const row of snapshot.affixes) {
      const allowed = row.canRollOn.filter(type => types.has(type));
      expect(any.canRollOn(row.id, ANY_BASE_ID)).toBe(allowed.length > 0);
      const positive = allowed.some(type => (row.overrides.find(entry => entry.equipmentType === type)?.weight ?? row.weight) > 0);
      expect(any.craftWeight(row.id, ANY_BASE_ID)).toBe(positive ? 1 : 0);
      expect(audited.affix(row.id)).toEqual(row);
    }
  });

  it('rejects mutually incompatible named affixes even when no equipment part was specified', () => {
    const eligible = snapshot.affixes.filter(row => row.side === 0 && row.special === 0 && row.canRollOn.length === 1 && row.canRollOn[0] < 24);
    const a = eligible[0], b = eligible.find(row => row.canRollOn[0] !== a.canRollOn[0])!;
    expect(b).toBeDefined();
    const draft = source7710(), compiled = compileDraft({ ...draft, part: null,
      slots: { ...draft.slots, prefix1: { tier: 1, id: a.id }, prefix2: { tier: 1, id: b.id } } });
    expect(compiled.scenarios).toHaveLength(0);
    expect(compiled.issues[0].message).toContain('同一装备');
  });

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
