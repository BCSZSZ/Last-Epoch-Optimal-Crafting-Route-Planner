import { describe, expect, it } from 'vitest';
import { Catalog, MODEL_ID } from './catalog';
import { requiredLevel, requiredLevelAfterShard, requiredLevelWithAffix } from './levels';
import { costKernel, nominalCost, preservedFp, sum } from './probability';
import { RuleEngine, OutcomeLimitError } from './rules';
import { targetReached } from './target';
import { validateRequest } from './validation';
import type { Affix, AtomicAction, AtomicOutcome, Item, PlanRequest } from './types';

const catalog = new Catalog();
const engine = new RuleEngine(catalog);
const context = { playerLevel: 100 };

function item(rows: readonly (readonly [number, number])[], fpType: Item['fpType'] = 'NORMAL'): Item {
  return { baseId: '4:0', itemLevel: 100, corrupted: false, fpType,
    affixes: rows.map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: 73 })) };
}
const goal = { requirements: [4, 5].map((id) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' as const })) };
const mass = (rows: readonly AtomicOutcome[], predicate: (row: AtomicOutcome) => boolean) => sum(rows.filter(predicate).map((row) => row.probability));
const atomic = (start: Item, action: AtomicAction, fp = 63) => {
  const result = engine.transition(start, fp, action, context);
  expect(result.issues).toEqual([]);
  expect(result.probabilityMass).toBeCloseTo(1, 12);
  return result.outcomes;
};

describe('versioned source projection and native eligibility', () => {
  it('contains all extracted definitions, including experimental identities without shards', () => {
    expect(catalog.model.affixes).toHaveLength(1156);
    expect(catalog.model.bases).toHaveLength(923);
    const experimental = catalog.model.affixes.filter((row) => row.special === 1);
    expect(experimental).toHaveLength(12);
    expect(experimental.every((row) => !catalog.hasShard(row.id))).toBe(true);
    expect(catalog.model.materials).toBe('UNLIMITED');
    expect(Object.isFrozen(catalog.model.affixes[0])).toBe(true);
  });

  it('reconstructs the independently audited glove pool with craft weighting', () => {
    const empty = item([]);
    const prefixes = catalog.rerollPool(empty, 0);
    const suffixes = catalog.rerollPool(empty, 1);
    expect(prefixes.length + suffixes.length).toBe(40);
    expect(sum(prefixes.map((row) => row.probability))).toBeCloseTo(1, 14);
    expect(catalog.craftWeight(5, '4:0')).toBe(1);
    expect(catalog.classMatches(0, 1)).toBe(true);
    expect(catalog.classMatches(0, 8)).toBe(false);
    expect(catalog.classMatches(4, 8)).toBe(true);
  });

  it('limits old incompatible compatibility to existing four AttributeIds', () => {
    const all = catalog.model.bases.filter((row) => row.ordinaryEquipment);
    for (const id of [501, 502, 503, 504]) {
      const base = all.find((row) => !catalog.canRollOn(id, row.id));
      expect(base).toBeDefined();
      if (base) {
        expect(catalog.canForgeOn(id, base.id, true)).toBe(true);
        expect(catalog.canForgeOn(id, base.id, false)).toBe(false);
      }
    }
    const base = all.find((row) => !catalog.canRollOn(505, row.id));
    expect(base).toBeDefined();
    if (base) expect(catalog.canForgeOn(505, base.id, true)).toBe(false);
  });

  it('reads the native tier-level formula instead of the affix definition level field', () => {
    expect(requiredLevel(item([[2, 7], [26, 7], [7, 3], [10, 2]]), catalog)).toBe(63);
    expect(requiredLevelAfterShard(item([[4, 1], [7, 4]]), 4, catalog)).toBe(23);
    const high: Item = { ...item([[2, 7], [26, 7], [7, 7], [10, 7]]), affixes: [
      ...item([[2, 7], [26, 7], [7, 7], [10, 7]]).affixes,
      { id: 4, tier: 7, slot: 'sealed', roll: 0 },
    ] };
    expect(requiredLevel(high, catalog)).toBe(86);
    expect(engine.eligibility(item([[4, 1], [7, 4]]), 63, { kind: 'seal', id: 4 }, { playerLevel: 22 }).map((row) => row.code)).toContain('PLAYER_LEVEL_TOO_LOW');
  });

  it('applies the AfterShard closure predicate to experimental and sealed targets', () => {
    const experimental = catalog.model.affixes.find((row) => row.special === 1 && row.canRollOn.includes(4));
    expect(experimental).toBeDefined();
    if (!experimental) return;
    const mixed = item([[4, 5], [experimental.id, 4]]);
    expect(requiredLevel(mixed, catalog)).toBe(32);
    expect(requiredLevelAfterShard(mixed, experimental.id, catalog)).toBe(33);
    expect(requiredLevelWithAffix(mixed, experimental.id, 5, catalog)).toBe(46);
    const sealed: Item = { ...item([[4, 5]]), affixes: [
      ...item([[4, 5]]).affixes, { id: 5, tier: 4, slot: 'sealed', roll: 0 },
    ] };
    expect(requiredLevelAfterShard(sealed, 5, catalog)).toBe(33);
  });
});

describe('the joint FP / state transition', () => {
  it('uses the lucky first-result upper bound and ordered low-FP retention', () => {
    const cost = nominalCost(4, 0.285);
    expect(cost.find((row) => row.value === 3)?.probability).toBeCloseTo(0.715 / 3, 14);
    expect(cost.find((row) => row.value === 1)?.probability).toBeCloseTo(0.715 / 3 + 0.285 * (1 + 1 + 0.5) / 3, 14);
    expect(preservedFp(3, 0, 0.05)).toEqual([
      { value: 2, probability: 0.05 }, { value: 1, probability: 0.0475 }, { value: 0, probability: 0.9025 },
    ]);
    expect(preservedFp(1, 0, 0.05)).toEqual([{ value: 0, probability: 1 }]);
  });

  it('combines Hope and Ice sequentially and has no Blood critical on rune actions', () => {
    for (const [type, expected] of [['NORMAL', 0.25], ['ICE', 0.475], ['BLOOD', 0.25]] as const) {
      const rows = atomic(item([[7, 7], [10, 7], [4, 1], [5, 1]], type), { kind: 'havoc', glyph: 'hope' });
      expect(mass(rows, (row) => row.fp === 63)).toBeCloseTo(expected, 13);
      expect(rows.every((row) => !row.critical)).toBe(true);
    }
  });

  it('keeps add critical upgrades and FP refunds correlated', () => {
    const rows = atomic(item([[7, 7], [10, 7], [2, 1]]), { kind: 'add', id: 4, glyph: 'hope' });
    expect(mass(rows, (row) => row.item.affixes.some((a) => a.id === 2 && a.tier === 2))).toBeCloseTo(0.06, 13);
    expect(mass(rows, (row) => row.item.affixes.some((a) => a.id === 4 && a.tier === 2))).toBeCloseTo(0.06, 13);
    expect(mass(rows, (row) => row.fp === 63)).toBeCloseTo(0.34, 13);
    expect(rows.filter((row) => row.critical).every((row) => row.fp === 63)).toBe(true);
    expect(rows.every((row) => row.item.affixes.at(-1)?.id === 4)).toBe(true);
  });

  it('uses the audited biased extra-tier selection with three eligible affixes', () => {
    const rows = atomic(item([[2, 1], [7, 1]]), { kind: 'add', id: 4, glyph: 'none' });
    expect(mass(rows, (row) => row.item.affixes.some((a) => a.id === 4 && a.tier === 2))).toBeCloseTo(0.12 * 5 / 12, 13);
    expect(mass(rows, (row) => row.item.affixes.some((a) => a.id === 2 && a.tier === 2))).toBeCloseTo(0.12 * 7 / 24, 13);
  });

  it('refunds FP even when character level prevents the selected extra tier', () => {
    const start = item([[4, 1], [7, 4]]);
    const result = engine.transition(start, 63, { kind: 'upgrade', id: 4, glyph: 'none' }, { playerLevel: 23 });
    expect(result.issues).toEqual([]);
    expect(mass(result.outcomes, (row) => row.critical && row.fp === 63)).toBeCloseTo(0.12, 13);
    expect(result.outcomes.every((row) => row.item.affixes[0].tier === 2 && row.item.affixes[1].tier === 4)).toBe(true);
  });

  it('models Order fallback critical rerolls rather than freezing every critical roll', () => {
    const result = engine.transition(item([[4, 1]]), 63, { kind: 'upgrade', id: 4, glyph: 'order' }, context, { trackRolls: true });
    expect(result.issues).toEqual([]);
    expect(mass(result.outcomes, (row) => row.critical && row.item.affixes[0].roll !== 73)).toBeCloseTo(0.12 * 0.5 * 255 / 256, 13);
    expect(result.outcomes.filter((row) => !row.critical).every((row) => row.item.affixes[0].roll === 73)).toBe(true);
  });

  it('does not apply an action at FP0 or after corruption', () => {
    expect(engine.transition(item([[4, 1]]), 0, { kind: 'upgrade', id: 4, glyph: 'hope' }, context).outcomes).toEqual([]);
    expect(engine.transition({ ...item([[4, 1]]), corrupted: true }, 63, { kind: 'upgrade', id: 4, glyph: 'hope' }, context).outcomes).toEqual([]);
  });

  it('conserves the fee kernel over all budgets, supports and FP types', () => {
    for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
      for (const hope of [true, false]) for (let fp = 1; fp <= 63; fp++) {
        const kernel = costKernel(fp, 20, fpType, hope, catalog.model.parameters);
        expect(sum(kernel.map((row) => row.probability))).toBeCloseTo(1, 13);
        expect(kernel.every((row) => row.value >= 0 && row.value <= fp)).toBe(true);
      }
    }
  });
});

describe('seal, Havoc, Redemption, Chaos and Removal', () => {
  it('uses actual count and all-slot exalted presence for the seal threshold', () => {
    expect(engine.sealChance(item([[7, 7], [10, 7], [2, 1]]), 2)).toBeCloseTo(0.945, 14);
    expect(engine.sealChance(item([[7, 7], [10, 7], [2, 1], [4, 1]]), 2)).toBe(1);
    expect(engine.sealChance(item([[7, 7], [10, 7], [2, 2], [4, 1]]), 2)).toBeCloseTo(0.69, 14);
    const sealedExalted: Item = { ...item([[7, 1], [10, 1], [2, 1], [4, 1]]), affixes: [
      ...item([[7, 1], [10, 1], [2, 1], [4, 1]]).affixes, { id: 5, tier: 8, slot: 'primordial', roll: 0 },
    ] };
    expect(engine.sealChance(sealedExalted, 2)).toBe(1);
  });

  it('moves a successful seal to the native list head and retains tier and roll', () => {
    const rows = atomic(item([[7, 7], [10, 7], [2, 1], [4, 1]], 'ICE'), { kind: 'seal', id: 2 });
    expect(rows.every((row) => row.sealed && !row.critical && row.abort === null)).toBe(true);
    expect(rows.every((row) => row.item.affixes[0].id === 2 && row.item.affixes[0].roll === 73 && row.item.affixes[0].tier === 1)).toBe(true);
    expect(mass(rows, (row) => row.fp === 63)).toBeCloseTo(0.3, 13);
  });

  it('settles failed seal upgrades and critical refunds before marking failure', () => {
    const rows = atomic(item([[7, 7], [10, 7], [2, 2], [4, 1]]), { kind: 'seal', id: 2 });
    expect(mass(rows, (row) => row.abort === 'REQUIRED_SEAL_FAILED')).toBeCloseTo(0.31, 13);
    expect(mass(rows, (row) => row.abort === 'REQUIRED_SEAL_FAILED' && row.critical && row.fp === 63)).toBeCloseTo(0.31 * 0.12, 13);
    expect(rows.filter((row) => row.abort).every((row) => row.item.affixes.find((a) => a.id === 2)!.tier >= 3)).toBe(true);
  });

  it('counts unique tier layouts, excludes the entire current arrangement and preserves ID rolls', () => {
    for (const [tiers, expected] of [[[7, 7, 1, 1], 1 / 5], [[7, 7, 3, 2], 2 / 11]] as const) {
      const start = item([[7, tiers[0]], [10, tiers[1]], [4, tiers[2]], [5, tiers[3]]]);
      const rows = atomic(start, { kind: 'havoc', glyph: 'none' }, 1);
      expect(mass(rows, (row) => targetReached(row.item, goal))).toBeCloseTo(expected, 14);
      expect(rows.every((row) => row.item.affixes.every((a, i) => a.id === start.affixes[i].id && a.roll === 73))).toBe(true);
      expect(rows.some((row) => row.item.affixes.every((a, i) => a.tier === start.affixes[i].tier))).toBe(false);
    }
  });

  it('preserves the threeT7 boundary and rejects all-equal tiers', () => {
    const rows = atomic(item([[7, 7], [10, 7], [4, 7], [5, 1]]), { kind: 'havoc', glyph: 'none' }, 1);
    expect(rows).toHaveLength(3);
    expect(mass(rows, (row) => targetReached(row.item, goal))).toBeCloseTo(2 / 3, 14);
    expect(engine.eligibility(item([[7, 7], [10, 7], [4, 7], [5, 7]]), 1, { kind: 'havoc', glyph: 'hope' }, context).map((row) => row.code)).toContain('IDENTICAL_TIERS');
  });

  it('matches all three independent Fraction witnesses for ordered Redemption', () => {
    for (const [first, second, expected] of [[2, 26, 0.00865650977675952], [4, 26, 0.00432825488837976], [26, 4, 0]] as const) {
      const rows = atomic(item([[first, 7], [second, 7], [7, 3], [10, 2]]), { kind: 'redemption', glyph: 'none' }, 1);
      expect(mass(rows, (row) => targetReached(row.item, goal))).toBeCloseTo(expected, 14);
      expect(rows.every((row) => row.item.affixes[0].tier === 7 && row.item.affixes[1].tier === 7 && row.item.affixes.every((a) => a.roll === 73))).toBe(true);
      expect(rows.every((row) => new Set(row.item.affixes.map((a) => a.id)).size === 4)).toBe(true);
    }
  });

  it('upgrades before Chaos, excludes existing/sealed IDs and has no critical branch', () => {
    const start: Item = { ...item([[4, 1], [7, 7], [10, 7]]), affixes: [
      { id: 5, tier: 1, slot: 'sealed', roll: 9 }, ...item([[4, 1], [7, 7], [10, 7]]).affixes,
    ] };
    const rows = atomic(start, { kind: 'chaos', id: 4 });
    expect(rows.every((row) => row.item.affixes[1].tier === 2 && row.item.affixes[1].id !== 4 && row.item.affixes[1].id !== 5 && !row.critical)).toBe(true);
    expect(rows.every((row) => row.item.affixes[0].id === 5 && row.item.affixes[0].slot === 'sealed')).toBe(true);
  });

  it('includes T7 in Removal and fails every unaccepted removal after settlement', () => {
    const rows = atomic(item([[4, 7], [5, 7], [7, 1], [10, 1]]), { kind: 'removal', glyph: 'none', acceptedIds: [7] }, 1);
    expect(mass(rows, (row) => row.removedId === 4)).toBeCloseTo(0.25, 14);
    expect(mass(rows, (row) => row.abort === 'UNACCEPTED_REMOVAL')).toBeCloseTo(0.75, 14);
    expect(rows.every((row) => row.fp === 0 && row.item.affixes.length === 3)).toBe(true);
  });

  it('does not condition a risky action on favorable protection outcomes', () => {
    const result = engine.transition(item([[4, 7], [5, 7], [7, 1], [10, 1]]), 63,
      { kind: 'removal', glyph: 'hope', acceptedIds: [7, 10] }, context,
      { constraints: { protected: [{ id: 4, identity: true }] } });
    expect(result.outcomes).toEqual([]);
    expect(result.issues[0].code).toBe('PROTECTION_RISK');
  });

  it('reports an outcome limit without discarding or renormalizing probability', () => {
    expect(() => engine.transition(item([[2, 7], [26, 7], [7, 3], [10, 2]]), 63,
      { kind: 'redemption', glyph: 'hope' }, context, { maxOutcomes: 10 })).toThrow(OutcomeLimitError);
  });
});

describe('target validation', () => {
  it('does not reuse one physical affix to fill two overlapping target requirements', () => {
    const target = { requirements: [
      { ids: [4, 5], minTier: 1, slot: 'ordinary' as const },
      { ids: [4], minTier: 1, slot: 'ordinary' as const },
    ] };
    expect(targetReached(item([[4, 7]]), target)).toBe(false);
    expect(targetReached(item([[4, 7], [5, 1]]), target)).toBe(true);
    expect(targetReached(item([[4, 7]]), { requirements: [...target.requirements.slice(1), { ...target.requirements[0], optional: true }] })).toBe(true);
  });

  it('rejects creating T7 from normal upgrades and version mismatches', () => {
    const request: PlanRequest = { modelId: MODEL_ID, item: item([[4, 5], [5, 5]]), craftingContext: context,
      target: goal, constraints: {}, scoring: {}, search: { milliseconds: 5000, maxRoutes: 100, macroStages: 12, maxStates: 50000 } };
    expect(validateRequest(request, catalog).map((row) => row.code)).toContain('UNREACHABLE_EXALTED_TIERS');
    expect(validateRequest({ ...request, modelId: 'old' }, catalog).map((row) => row.code)).toContain('MODEL_MISMATCH');
  });

  it('keeps special slots separate from the ordinary target', () => {
    const sealed: Affix = { id: 4, tier: 7, slot: 'sealed', roll: 255 };
    expect(targetReached({ ...item([[5, 7]]), affixes: [sealed, ...item([[5, 7]]).affixes] }, goal)).toBe(false);
  });

  it('rejects overfull and conflicting targets without counting optional entries', () => {
    const base: PlanRequest = { modelId: MODEL_ID, item: item([[4, 7], [5, 7]]), craftingContext: context,
      target: goal, constraints: {}, scoring: {}, search: { milliseconds: 5000, maxRoutes: 100, macroStages: 12, maxStates: 50000 } };
    const conflict = { requirements: [goal.requirements[0], goal.requirements[0]] };
    expect(validateRequest({ ...base, target: conflict }, catalog).map((row) => row.code)).toContain('TARGET_ID_CONFLICT');
    const threePrefixes = { requirements: [2, 4, 5].map((id) => ({ ids: [id], minTier: 1, slot: 'ordinary' as const })) };
    expect(validateRequest({ ...base, target: threePrefixes }, catalog).map((row) => row.code)).toContain('TARGET_SIDE_CAPACITY');
    expect(validateRequest({ ...base, item: { ...base.item, corrupted: true } }, catalog).map((row) => row.code)).not.toContain('CORRUPTED_ITEM');
    const withUnknown: Item = { ...base.item, affixes: base.item.affixes.map((row) => ({ ...row, roll: null })) };
    const rollTarget = { requirements: goal.requirements.map((row) => ({ ...row, minRollByte: 128 })) };
    expect(validateRequest({ ...base, item: withUnknown, target: rollTarget }, catalog).map((row) => row.code)).toContain('UNKNOWN_INITIAL_ROLL');
  });
});
