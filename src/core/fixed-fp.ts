/** Rewards by stable macro path; nested branches keep separate identities. */
export interface MacroFpReward {
  readonly expectedEntries: number;
  readonly expectedFp: number;
  readonly totalFpContribution: number;
}
export interface FixedFpReport {
  readonly initialFp: number;
  readonly totalExpectedFp: number;
  readonly successExpectedFp: number | null;
  readonly macros: Readonly<Record<string, MacroFpReward>>;
}
