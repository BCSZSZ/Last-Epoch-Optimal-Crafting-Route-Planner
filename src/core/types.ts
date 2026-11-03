/** Data-only contracts. No React, browser, Worker, network, or storage dependencies. */
export type FpType = 'NORMAL' | 'ICE' | 'BLOOD';
export type Slot = 'ordinary' | 'sealed' | 'primordial' | 'corrupted';
export type Side = 0 | 1 | 2;
export type Glyph = 'hope' | 'order' | 'none';

export interface Affix {
  readonly id: number;
  /** Display tier: T1=1, T7=7. Native stored tier is tier-1. */
  readonly tier: number;
  readonly slot: Slot;
  /** null means a fresh independent uniform byte marginalized out of a no-roll target. */
  readonly roll: number | null;
}

export interface Item {
  readonly baseId: string;
  readonly itemLevel: number;
  readonly fpType: FpType;
  readonly corrupted: boolean;
  /** Native order, including sealed entries. Never sort by ID or visible slot. */
  readonly affixes: readonly Affix[];
}

export interface CraftingContext { readonly playerLevel: number }

export interface Requirement {
  readonly ids: readonly number[];
  readonly minTier: number;
  readonly maxTier?: number;
  readonly slot: Slot | 'any';
  readonly minRollByte?: number;
  readonly optional?: boolean;
}

export interface Target { readonly requirements: readonly Requirement[] }
export interface Protection {
  readonly id: number;
  readonly identity?: boolean;
  readonly minTier?: number;
  readonly roll?: boolean;
}

export type ActionKind = 'add' | 'upgrade' | 'seal' | 'chaos' | 'havoc' | 'redemption' | 'removal';
export interface Constraints {
  readonly allowedActions?: readonly ActionKind[];
  readonly protected?: readonly Protection[];
  readonly maxAttempts?: number;
}

export type AtomicAction =
  | { readonly kind: 'add' | 'upgrade'; readonly id: number; readonly glyph: Glyph }
  | { readonly kind: 'seal' | 'chaos'; readonly id: number }
  | { readonly kind: 'havoc' | 'redemption'; readonly glyph: 'hope' | 'none' }
  | { readonly kind: 'removal'; readonly glyph: 'hope' | 'none'; readonly acceptedIds: readonly number[] };

export interface Issue { readonly code: string; readonly message: string; readonly path?: string }
export type AbortReason = 'REQUIRED_SEAL_FAILED' | 'UNACCEPTED_REMOVAL' | 'PROTECTION_VIOLATED';
export interface AtomicOutcome {
  readonly probability: number;
  readonly probabilityBounds: { readonly lower: number; readonly upper: number };
  readonly item: Item;
  readonly fp: number;
  readonly critical: boolean;
  readonly sealed: boolean;
  readonly removedId?: number;
  readonly abort: AbortReason | null;
}

export interface AtomicDistribution {
  readonly outcomes: readonly AtomicOutcome[];
  readonly issues: readonly Issue[];
  readonly probabilityMass: number;
  readonly evaluation: 'OUTWARD_ROUNDED_UNDER_DECLARED_MODEL';
}

export type SampledOutcome = Omit<AtomicOutcome, 'probability' | 'probabilityBounds'>;
export interface AtomicSample {
  readonly outcome: SampledOutcome | null;
  readonly issues: readonly Issue[];
}

export interface Selector {
  readonly side?: 0 | 1;
  readonly ids?: readonly number[];
  readonly excludedIds?: readonly number[];
  readonly minTier?: number;
  readonly maxTier?: number;
  /** In a macro, require complete current seal eligibility before selecting this entry. */
  readonly sealable?: boolean;
  readonly eligibleAction?: 'chaos' | 'removal';
}

export type Predicate =
  | { readonly kind: 'target' }
  | { readonly kind: 'any'; readonly predicates: readonly Predicate[] }
  | { readonly kind: 'all'; readonly predicates: readonly Predicate[] }
  | { readonly kind: 'requirements'; readonly requirements: readonly Requirement[] }
  | { readonly kind: 'identity'; readonly requirement: Requirement }
  | { readonly kind: 'exists'; readonly selector: Selector }
  | { readonly kind: 'count'; readonly selector: Selector; readonly minimum: number };

export type Macro =
  | { readonly kind: 'conditional'; readonly when: Predicate; readonly then: readonly Macro[]; readonly otherwise?: readonly Macro[] }
  | { readonly kind: 'fill'; readonly ids: readonly number[]; readonly glyph: Glyph }
  | { readonly kind: 'once'; readonly action: AtomicAction }
  | { readonly kind: 'seal'; readonly selector: Selector }
  | { readonly kind: 'removal'; readonly accepted: Selector; readonly glyph: 'hope' | 'none' }
  | { readonly kind: 'repeat'; readonly action: AtomicAction; readonly until: Predicate }
  | { readonly kind: 'upgrade'; readonly id: number; readonly tier: number; readonly glyph: Glyph }
  | { readonly kind: 'chaos'; readonly selector: Selector; readonly until: Requirement;
      readonly onExhausted?: 'ABORT' | 'CONTINUE'; readonly prepareWithHavoc?: boolean };

export interface Route { readonly id: string; readonly macros: readonly Macro[]; readonly description?: string }

export interface Scoring {
  readonly weights?: readonly number[];
  readonly maximumFp?: number;
}

export interface SearchBudget {
  readonly milliseconds: number;
  readonly maxRoutes: number;
  readonly macroStages: number;
  readonly maxStates: number;
}

export interface PlanRequest {
  readonly modelId: string;
  readonly item: Item;
  readonly craftingContext: CraftingContext;
  readonly target: Target;
  readonly constraints: Constraints;
  readonly scoring: Scoring;
  readonly search: SearchBudget;
}
