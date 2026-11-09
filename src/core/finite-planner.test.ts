import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { catalogForInputModel } from './input-model';
import { clearFinitePolicyCache, finiteRecommendation, solveCompactProfile } from './finite-policy';
import { replayFiniteProfile } from './finite-replay';
import { plan, PlanningCancelledError } from './planner';
import { CompactGraph, compactDomain } from './finite-state';
import { compileTemplates } from './hierarchy';
import { RuleEngine } from './rules';
import type { FpType, PlanRequest } from './types';

// Frozen independently calculated C# baseline, before changing production code.
const baseline = JSON.parse(readFileSync(new URL('../../research/fixtures/finite48-three-profiles-99.json', import.meta.url), 'utf8')) as {
  rows: { caseId: string; request: PlanRequest; expected: Record<FpType, { probability: number; meanActualFp: number; successMeanActualFp: number }> }[];
};
function request(index = 0): PlanRequest {
  const row = baseline.rows[index].request, catalog = catalogForInputModel(row.inputModel);
  return { ...row, modelId: catalog.model.modelId, initialFp:48 };
}

describe('production finite48 three-profile policy', () => {
  it('retains all297 independent results, enclosures, FP rewards and recommendations', async () => {
    clearFinitePolicyCache(); const recommendations = [0, 0, 0]; let bloodBetter = 0, bloodEqual = 0;
    for (const [index, row] of baseline.rows.entries()) {
      const ps: number[] = [];
      for (const [mode, profile] of (['NORMAL', 'ICE', 'BLOOD'] as const).entries()) {
        const input = request(index), result = await solveCompactProfile(input, catalogForInputModel(input.inputModel), profile, { stopped: () => false, includeSteps: false });
        expect(result, row.caseId).not.toBeNull(); const p = row.expected[profile].probability;
        expect(result!.estimate!, `${row.caseId}/${profile}`).toBeCloseTo(p, 10);
        expect(result!.probability!.lower).toBeLessThanOrEqual(p); expect(result!.probability!.upper).toBeGreaterThanOrEqual(p);
        expect(result!.probability!.upper - result!.probability!.lower).toBeLessThan(1e-7);
        expect(result!.recommendation).toBe(p < .25 ? 'NOT_RECOMMENDED' : p > .60 ? 'RECOMMENDED' : 'NEUTRAL');
        expect(result!.actualMeanFp).toBeCloseTo(row.expected[profile].meanActualFp, 6);
        expect(result!.successActualMeanFp).toBeCloseTo(row.expected[profile].successMeanActualFp, 5);
        expect(result!.actualMeanFp).toBeGreaterThanOrEqual(0); expect(result!.actualMeanFp).toBeLessThanOrEqual(48);
        expect(result!.successActualMeanFp).toBeGreaterThanOrEqual(0); expect(result!.successActualMeanFp).toBeLessThanOrEqual(48);
        if (result!.recommendation === 'RECOMMENDED') recommendations[mode]++; ps.push(result!.estimate!);
      }
      if (ps[2] > ps[0] + 1e-10) bloodBetter++; else if (Math.abs(ps[2] - ps[0]) < 1e-10) bloodEqual++;
    }
    expect(recommendations).toEqual([42, 58, 44]); expect([bloodBetter, bloodEqual]).toEqual([96, 3]);
  }, 120000);

  it('explicit48FP entry returns three independently labelled results, preserving low-probability routes', async () => {
    const report = await plan(request(15), { now: () => 0 });
    expect(report.metric).toBe('FINITE_48_PROFILES_V3'); expect(report.finiteProfiles?.filteringThresholds).toBeNull();
    expect(report.finiteProfiles?.recommendationThresholds).toEqual({ notRecommendedBelow: .25, recommendedAbove: .60 });
    expect(report.finiteProfiles?.profiles.map(row => row.fpType)).toEqual(['NORMAL', 'ICE', 'BLOOD']);
    expect(report.finiteProfiles?.profiles.map(row => row.recommendation)).toEqual(['NOT_RECOMMENDED', 'NOT_RECOMMENDED', 'NOT_RECOMMENDED']);
    expect(report.finiteProfiles!.profiles.every(row => row.probability !== null && row.decisions.length > 0)).toBe(true);
  }, 30000);

  it('independently chooses the blood-specific C087 first step and replays its submitted policy', async () => {
    const input = request(86), report = await plan(input, { now: () => 0 });
    const rows = report.finiteProfiles!.profiles;
    expect(rows[0].firstAction).toContain('补'); expect(rows[2].firstAction).toContain('封印');
    const replay = await replayFiniteProfile(input, catalogForInputModel(input.inputModel), rows[2]);
    expect(replay.probability).toBeCloseTo(rows[2].estimate!, 9);
    await expect(replayFiniteProfile(input, catalogForInputModel(input.inputModel), { ...rows[2], decisions: [] })).rejects.toThrow('Missing reachable');
  }, 30000);

  it('does not drop C001 for exceeding the old65FP theoretical mean; exported choices reproduce33.039%', async () => {
    const input = request(), report = await plan(input, { now: () => 0 });
    const row = report.finiteProfiles!.profiles[0]; expect(row.firstAction).toBe('救赎＋希望');
    expect(row.estimate).toBeCloseTo(.3303892999907479, 11);
    expect((await replayFiniteProfile(input, catalogForInputModel(input.inputModel), row)).probability).toBeCloseTo(row.estimate!, 10);
  }, 30000);

  it('replays two-prefix policies with explicit target identities rather than guessing from action text', async () => {
    const input = request(96), row = await solveCompactProfile(input, catalogForInputModel(input.inputModel), 'BLOOD', { stopped: () => false });
    expect((await replayFiniteProfile(input, catalogForInputModel(input.inputModel), row!)).probability).toBeCloseTo(row!.estimate!, 9);
    expect(row!.decisions.some(decision => decision.choice?.kind === 'add')).toBe(true);
  }, 30000);

  it('uses strict 25% and 60% badge boundaries, with a neutral middle', () => {
    expect(finiteRecommendation({ lower: .249, upper: .2499 })).toBe('NOT_RECOMMENDED');
    expect(finiteRecommendation({ lower: .25, upper: .25 })).toBe('NEUTRAL');
    expect(finiteRecommendation({ lower: .5, upper: .5 })).toBe('NEUTRAL');
    expect(finiteRecommendation({ lower: .6, upper: .6 })).toBe('NEUTRAL');
    expect(finiteRecommendation({ lower: .600001, upper: .61 })).toBe('RECOMMENDED');
    expect(finiteRecommendation({ lower: .249999, upper: .250001 })).toBe('UNRESOLVED');
    expect(finiteRecommendation({ lower: .599999, upper: .600001 })).toBe('UNRESOLVED');
    expect(finiteRecommendation(null)).toBe('UNRESOLVED');
  });

  it('clears removed identities from empty slots and disables both legacy15% prefilters', () => {
    const input = request(2), catalog = catalogForInputModel(input.inputModel), domain = compactDomain(input, catalog)!;
    const graph = new CompactGraph(domain, 'NORMAL', catalog.model.parameters, 25000, () => false);
    graph.include(domain.initial);
    for (const state of graph.states) if (state) state.tiers.forEach((tier, i) => { if (!tier) expect(state.roles[i]).toBe(0); });
    const compiled = compileTemplates(input, new RuleEngine(catalog), true)!;
    expect(compiled.rejected.some(row => row.reason === 'CERTIFIED_SUCCESS_BELOW_15_PERCENT')).toBe(false);
    expect(compactDomain({ ...input, item: { ...input.item, affixes: input.item.affixes.map((row, i) => i === 0 ? { ...row, tier: 8 } : row) } }, catalog)).toBeNull();
  });

  it('preserves invalid/cancelled inputs and incomplete status instead of inventing zero probability', async () => {
    expect((await plan({})).status).toBe('INVALID_INPUT');
    const controller = new AbortController(); controller.abort();
    await expect(plan(request(), { signal: controller.signal })).rejects.toBeInstanceOf(PlanningCancelledError);
    clearFinitePolicyCache();
    const tiny = { ...request(), search: { ...request().search, milliseconds: 0 } };
    const incomplete = await plan(tiny); // Input validation may reject a zero execution budget.
    expect(['INVALID_INPUT', 'INCOMPLETE']).toContain(incomplete.status === 'INVALID_INPUT' ? incomplete.status : incomplete.searchStatus);
  });
});
