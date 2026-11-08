import type { DraftScenario } from './draft';
import type { FiniteProfileResult } from './finite-policy';
import type { PlanReport } from './planner';
import type { FpType } from './types';

export interface ScenarioResult { readonly scenario: DraftScenario; readonly report: PlanReport }

type Probability = NonNullable<FiniteProfileResult['probability']>;
interface MeanProfile {
  readonly fpType: FpType;
  readonly probability: Probability | null;
  readonly complete: boolean;
}

export const DRAFT_PROFILES = ['NORMAL', 'ICE', 'BLOOD'] as const;

export function summarizeDraftResults<T extends {
  scenario: DraftScenario; report: { finiteProfiles?: { profiles: readonly FiniteProfileResult[] } };
}>(results: readonly T[]) {
  const groups = new Map<number, T[]>();
  for (const row of results) {
    const part = row.scenario.part;
    if (!groups.has(part)) groups.set(part, []);
    groups.get(part)!.push(row);
  }
  const parts = [...groups].map(([part, rows]) => {
    const baseCount = rows.reduce((sum, row) => sum + row.scenario.baseIds.length, 0);
    const profiles: MeanProfile[] = DRAFT_PROFILES.map(fpType => {
      let lower = 0, upper = 0, complete = true;
      for (const { scenario, report } of rows) {
        const profile = report.finiteProfiles?.profiles.find(row => row.fpType === fpType);
        if (!profile?.probability) return { fpType, probability: null, complete: false };
        const w = scenario.baseIds.length / baseCount;
        lower += w * profile.probability.lower;
        upper += w * profile.probability.upper;
        complete &&= profile.status === 'COMPLETE';
      }
      return { fpType, probability: { lower, upper }, complete };
    });
    return { part, rows, baseCount, profiles };
  });
  const profiles: MeanProfile[] = DRAFT_PROFILES.map((fpType, index) => {
    let lower = 0, upper = 0, complete = true;
    if (!parts.length) return { fpType, probability: null, complete: false };
    for (const part of parts) {
      const profile = part.profiles[index];
      if (!profile.probability) return { fpType, probability: null, complete: false };
      lower += profile.probability.lower / parts.length;
      upper += profile.probability.upper / parts.length;
      complete &&= profile.complete;
    }
    return { fpType, probability: { lower, upper }, complete };
  });
  return { parts, profiles };
}