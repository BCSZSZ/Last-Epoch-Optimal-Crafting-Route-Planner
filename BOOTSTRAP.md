# Last Epoch Optimal Crafting Route Planner
## Master Development Specification v1.0

### Role

You are the lead technical architect, probability researcher, optimization engineer, and full-stack developer.

Your task is to design and eventually implement an accurate, evidence-based crafting route optimizer for Last Epoch.

Use Simplified Chinese for all research reports, PRDs, progress summaries, and user-facing UI. Use English for code identifiers and technical schemas.

Correctness is more important than development speed.

## 1. Product Definition

This product is an **automatic crafting route planner**, not an interactive crafting simulator.

The user provides:

- Starting equipment state.
- Target equipment state.
- Optional crafting restrictions.

The system must automatically output one recommended fixed crafting route.

Each repeated probabilistic operation must be aggregated into a single macro action.

Example:

"Use Rune of Havoc repeatedly until the specified target tier configuration is reached."

The macro action reports its expected number of uses, expected FP cost, probability distribution, and stopping conditions.

### Mandatory Product Constraints

1. Never require users to enter their remaining Forging Potential.
2. Never require users to enter results after individual crafting actions.
3. Never require step-by-step manual replanning.
4. Automatically compute the whole route from initial state to target state.
5. Output one primary recommended route.
6. Show expected FP cost and completion probability.
7. Support Normal, Ice, and Blood Forging Potential.
8. All probabilities must be grounded in a versioned game-mechanics model.
9. The optimizer must not invent game rules or numerical probabilities.

## 2. Equipment State Model

Represent all properties relevant to forging:

- Item base and subtype.
- Item category.
- Class restrictions and item level.
- Prefixes and suffixes.
- Affix IDs, tiers and values.
- Sealed affixes.
- Primordial T8 affix state.
- Forging Potential type.
- Additional crafting constraints.

The actual remaining FP value is intentionally excluded from the required user input.

Use stable affix identifiers. Do not use localized names as database primary keys.

## 3. Target Definition

Support:

- Exact affix requirements.
- Minimum tier requirements.
- Fixed or flexible affix positions.
- Optional affixes.
- Alternative acceptable affixes.
- Required sealed affixes.
- Protected affixes.
- Optional roll-value constraints.

Invalid or impossible targets must be reported explicitly.

Do not silently relax constraints.

## 4. Required Game Mechanics

Research and model:

- Basic affix addition and upgrading.
- Crafting critical success.
- Glyph of Hope.
- Glyph of Despair.
- Rune of Havoc.
- Rune of Redemption.
- Normal Forging Potential.
- Ice Forging Potential.
- Blood Forging Potential.

Design extensible interfaces for:

- Glyph of Chaos.
- Rune of Removal.
- Rune of Refinement.
- Rune of Shaping.
- Rune of Evolution and T8.
- Other relevant crafting mechanics.

For each operation specify:

- Applicability.
- State prerequisites.
- Legal target objects.
- Probability distributions.
- State changes.
- FP consumption distribution.
- Possible failure states.
- Material costs.
- Game version.
- Evidence source and confidence level.

Do not treat community assumptions as official formulas.

## 5. Macro Actions

Build a macro-action engine above the atomic crafting engine.

Required macro actions include:

- Havoc until target tier arrangement.
- Redemption until target exalted affix configuration.
- Upgrade until target tier.
- Seal target affix, subject to failure and stopping rules.
- Add or replace a required affix.
- Relevant combinations when mathematically justified.

A macro action is defined by:

- Entry state.
- Legal atomic operation or internal strategy.
- Stop predicate.
- Abort predicate.
- Exit-state probability distribution.
- Expected number of attempts.
- Expected FP consumption.
- FP consumption distribution.
- Material consumption.

For state-preserving independent retries, geometric distributions may be used.

For state-changing retries, use explicit stochastic-state models, absorbing Markov chains, or equivalent exact computations.

Detect nonterminating loops.

Never claim that a state-changing operation has expected attempts equal to 1/p unless the necessary assumptions hold.

## 6. Single-Item Optimization Objective

Optimize crafting strategies for **one given item**.

Do not optimize repeated purchases of replacement base items.

For each route R and hypothetical initial FP budget F, compute:

P_R(F) = probability that the single item reaches its target before it becomes uncraftable or the route aborts.

Calculate:

- Expected actual FP spent including failed routes.
- Expected FP spent conditional on success.
- Median and high-quantile FP consumption.
- Success probabilities across a predefined FP evaluation domain.
- Macro-action attempt counts.
- Material consumption.

The primary route-selection score is:

J(R) = Σ_F w(F) × P_R(F)

where w(F) is an explicit, configurable product-level weighting distribution over hypothetical initial FP budgets.

This distribution is not claimed to represent actual in-game drops unless supported by evidence.

Use the following lexicographic tie-breakers:

1. Lower expected FP conditional on success.
2. Lower expected FP wasted on unsuccessful routes.
3. Lower FP upper quantiles.
4. Lower material cost.
5. Fewer macro-action stages.

Also retain Pareto-optimal alternatives internally, even when displaying a single main recommendation.

The final UI must explain the selected optimization convention.

## 7. Fixed Route Requirement

Prefer deterministic ordered sequences of macro actions.

No user interaction is required after calculation.

Allow automatic stopping rules and strictly necessary contingencies when a stochastic operation can permanently change the crafting state.

If a single universal route cannot correctly represent all outcomes, explicitly disclose the limitation.

Do not silently assume failed attempts return the item to its original state.

Do not optimize an adaptive policy and falsely present it as a fixed route.

## 8. Route Search

Investigate and implement an appropriate combination of:

- State-space search.
- Dynamic programming.
- Memoization.
- State canonicalization.
- Safe dominance pruning.
- Pareto-frontier maintenance.
- Branch-and-bound.
- Admissible cost bounds.
- Probability-distribution propagation.
- Macro-action expansion and compression.

Use exact methods where tractable.

When approximate methods are required, report approximation status, relevant bounds, and validation results.

Do not declare a route globally optimal without proof or exhaustive coverage under the modeled assumptions.

## 9. Probability and Data Research

Research:

- Complete affix database and weights.
- Item category eligibility.
- Redemption selection distributions.
- Havoc tier permutation distributions.
- Despair sealing probabilities.
- Critical success behavior.
- Forging Potential cost distributions.
- Glyph of Hope interactions.
- Ice FP preservation mechanics.
- Blood FP critical success mechanics.

Use official documentation, patch notes, reliable game-data sources, and community testing.

Classify each probability as:

- VERIFIED
- PARTIALLY_VERIFIED
- ESTIMATED
- UNKNOWN

Keep sources and version metadata.

Unsupported exact probabilities must be parameterized or explicitly marked unavailable.

## 10. Technology

Preferred stack:

- React + TypeScript + Vite.
- Pure TypeScript game-rule engine.
- Independent optimization module.
- Versioned static JSON or equivalent structured game database.
- Web Workers for heavy calculations.
- Vitest for unit and property-based tests.

Do not introduce a server without a concrete need.

Keep the rule engine independent of the user interface.

## 11. Verification and Acceptance

Test against:

- Official rules.
- Published reference calculators.
- Hand-calculated small cases.
- Exhaustive search on toy models.
- Independent Monte Carlo simulation.

Acceptance requirements:

- Atomic transition probabilities sum to one.
- Macro actions correctly handle repeat attempts.
- Impossible targets are rejected.
- State-changing failures are correctly modeled.
- Sealing and slot restrictions remain valid.
- FP consumption distributions propagate correctly.
- Ice/Blood effects do not use fabricated formulas.
- Search pruning does not discard proven superior candidates.
- Recommended routes are reproducible.
- Every result identifies the game-data version.

## 12. Development Phases

Phase 0: Verify mechanics and construct source matrix.

Phase 1: Define state schema, target schema, and atomic transition engine.

Phase 2: Implement and test macro-action probability models.

Phase 3: Implement fixed-route optimization and dominance pruning.

Phase 4: Model complete Normal/Ice/Blood FP distributions and optimize over hypothetical budgets.

Phase 5: Cross-validate using exhaustive toy cases and Monte Carlo simulations.

Phase 6: Implement the web interface.

Phase 7: Performance tuning, regression testing, and deployment.

## 13. Deliverables

Produce:

- docs/PRD.md
- docs/mechanics.md
- docs/affix-database.md
- docs/probability-model.md
- docs/state-model.md
- docs/macro-actions.md
- docs/optimization-objective.md
- docs/route-search.md
- docs/validation-plan.md
- docs/implementation-plan.md
- docs/open-questions.md

## 14. Initial Task

Start with Phase 0 and the mathematical architecture.

Research the current live Last Epoch patch version and verify the mechanics before producing implementation assumptions.

Create the research and architecture documents.

Identify any mechanics for which exact probabilities remain unknown.

Do not generate a superficial prototype that substitutes guesses for the real optimization engine.

After completing the research documents, stop and present the findings and remaining uncertainty for approval.

Do not proceed to product implementation until the rules model and optimization objective are approved.