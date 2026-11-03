"""Complete the user's fixed 7710 preparation routes, without route optimization.

This research evaluator includes actual ADD/SEAL side effects, finite hypothetical
FP and free-cost loops. Outward-rounded intervals enclose the solution under the
declared iid primitive/uniform changed-permutation reference model. It is neither
a production solver nor a bit-exact replay of the native seeded RNG.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from fractions import Fraction
from functools import lru_cache
import hashlib
from itertools import permutations
import json
import math
from pathlib import Path
import struct

from check_action_examples import class_matches
from check_fp_examples import DISPLAY, GRID, cost_exit, threshold
from extract_game_snapshot import ROOT, encode_json

CASES = ROOT / "research/7710-route-cases.json"
OUTPUT = ROOT / "research/7710-route-results.json"
State = tuple[tuple[int, int, bool], ...]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


@dataclass(frozen=True, slots=True)
class Interval:
    lo: float
    hi: float

    @staticmethod
    def exact(value: int | Fraction) -> "Interval":
        rational = Fraction(value)
        rounded = float(rational)
        comparison = Fraction.from_float(rounded)
        lo = math.nextafter(rounded, -math.inf) if comparison > rational else rounded
        hi = math.nextafter(rounded, math.inf) if comparison < rational else rounded
        return Interval(lo, hi)

    def __add__(self, other: "Interval") -> "Interval":
        if other.hi == 0:
            return self
        if self.hi == 0:
            return other
        return Interval(max(0.0, math.nextafter(self.lo + other.lo, -math.inf)),
                        math.nextafter(self.hi + other.hi, math.inf))

    def __mul__(self, other: "Interval") -> "Interval":
        if self.hi == 0 or other.hi == 0:
            return ZERO
        return Interval(max(0.0, math.nextafter(self.lo * other.lo, -math.inf)),
                        math.nextafter(self.hi * other.hi, math.inf))

    def __truediv__(self, other: "Interval") -> "Interval":
        require(other.lo > 0, "Nonpositive interval divisor / unresolved free-cost loop")
        if self.hi == 0:
            return ZERO
        return Interval(max(0.0, math.nextafter(self.lo / other.hi, -math.inf)),
                        math.nextafter(self.hi / other.lo, math.inf))

    def complement(self) -> "Interval":
        return Interval(max(0.0, math.nextafter(1.0 - self.hi, -math.inf)),
                        min(1.0, math.nextafter(1.0 - self.lo, math.inf)))

    def report(self, maximum: float = math.inf) -> dict:
        return {"lower": max(0.0, self.lo), "upper": min(maximum, self.hi)}


ZERO, ONE = Interval.exact(0), Interval.exact(1)


@dataclass(frozen=True, slots=True)
class Metrics:
    p: Interval = ZERO
    spent: Interval = ZERO
    attempts: Interval = ZERO
    success_spent: Interval = ZERO

    def __add__(self, other: "Metrics") -> "Metrics":
        return Metrics(*(a + b for a, b in zip(self.values(), other.values())))

    def scale(self, probability: Fraction | Interval) -> "Metrics":
        weight = probability if isinstance(probability, Interval) else Interval.exact(probability)
        return Metrics(*(value * weight for value in self.values()))

    def divide(self, denominator: Interval) -> "Metrics":
        return Metrics(*(value / denominator for value in self.values()))

    def values(self) -> tuple[Interval, ...]:
        return self.p, self.spent, self.attempts, self.success_spent


FAILED, SUCCEEDED = Metrics(), Metrics(p=ONE)


def f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


class Evaluator:
    def __init__(self, case: dict, route: dict, fp_type: str, profile: str, definitions: dict):
        self.case, self.route, self.fp_type, self.profile, self.definitions = case, route, fp_type, profile, definitions
        self.a, self.b = case["targetAId"], case["targetBId"]
        self.initial_t7_count = sum(not row["sealed"] and row["tier"] == 7 for row in case["initialAffixes"])
        claims = json.loads((ROOT / "research/forge-fp-claims.json").read_text(encoding="utf-8"))
        facts = {claim["id"]: claim for claim in claims["claims"]}
        self.q_lucky = threshold(facts["FP-COST"]["luckyThresholdFloat32"], profile)
        self.q_hope = threshold(facts["FP-HOPE-ICE"]["hopeThresholdFloat32"], profile)
        self.q_ice = threshold(facts["FP-HOPE-ICE"]["iceThresholdFloat32"], profile)
        self.q_preserve = threshold(facts["FP-LOW-PRESERVE"]["thresholdFloat32"], profile)
        normal = threshold(facts["FP-CRITICAL-ROLL"]["normalThresholdFloat32"], profile)
        blood = threshold(facts["FP-CRITICAL-ROLL"]["bloodExtraThresholdFloat32"], profile)
        self.q_critical = normal + (1 - normal) * blood if fp_type == "BLOOD" else normal
        self.q_half = threshold(0.5, profile)
        self.side_b = self.side(self.b)
        self.havoc_tables: dict[tuple, list[Metrics]] = {}
        self.seen_ready_states: set[State] = set()
        self.atomic_mass_checks = 0

    def side(self, identity: int) -> int:
        return self.definitions[identity]["type"]

    def complete(self, state: State) -> bool:
        return all(any(identity == target and tier == 7 and not sealed for identity, tier, sealed in state)
                   for target in (self.a, self.b))

    def junk(self, state: State, only_t1: bool = False) -> list[int]:
        return [index for index, (identity, tier, sealed) in enumerate(state)
                if not sealed and identity not in (self.a, self.b) and self.side(identity) == self.side_b
                and (tier == 1 if only_t1 else 1 <= tier <= 4)]

    def can_add(self, state: State, identity: int) -> str | None:
        if any(entry[0] == identity for entry in state):
            return "DUPLICATE_ID"
        side = self.side(identity)
        if sum(not sealed and self.side(other) == side for other, _, sealed in state) >= 2:
            return "NO_LEGAL_PREFIX_SLOT" if side == 0 else "NO_LEGAL_SUFFIX_SLOT"
        if sum(not sealed for _, _, sealed in state) >= 4:
            return "NO_LEGAL_ORDINARY_SLOT"
        return None

    @lru_cache(maxsize=None)
    def fp_kernel(self, before: int, hi: int, hope: bool) -> tuple:
        no_cost = 1 - (1 - (self.q_hope if hope else 0)) * (1 - (self.q_ice if self.fp_type == "ICE" else 0))
        return cost_exit(before, hi, self.profile, no_cost, self.q_lucky, self.q_preserve)

    @lru_cache(maxsize=None)
    def critical_kernel(self, state: State, primary: int) -> tuple:
        eligible = [i for i, (_, tier, sealed) in enumerate(state) if not sealed and tier < 5]
        if not eligible:
            return ((state, Fraction(1)),)
        primary_index = next((i for i in eligible if state[i][0] == primary), None)
        index_weights = defaultdict(Fraction)
        if primary_index is None:
            for i in eligible:
                index_weights[i] += Fraction(1, len(eligible))
        else:
            for i in eligible:
                index_weights[i] += (1 - self.q_half) / len(eligible)
            others = [i for i in eligible if i != primary_index]
            if not others:
                index_weights[primary_index] += self.q_half
            else:
                index_weights[primary_index] += self.q_half * self.q_half
                for i in others:
                    index_weights[i] += self.q_half * (1 - self.q_half) / len(others)
        output = defaultdict(Fraction)
        for index, probability in index_weights.items():
            row = state[index]
            new = state[:index] + ((row[0], row[1] + 1, False),) + state[index + 1:]
            output[new] += probability
        require(sum(output.values()) == 1, "Critical upgrade mass differs from one")
        return tuple(output.items())

    def seal_probability(self, state: State, index: int) -> Fraction:
        tier = state[index][1]
        n = sum(not entry[2] for entry in state)
        exalted = any(entry[1] >= 6 for entry in state)
        multiplier = (0.7, 0.46, 0.23, 0.1)[tier - 1]
        if self.profile == DISPLAY:
            raw = (Fraction(3, 5) + Fraction(3, 20) * n + Fraction(3, 10) * exalted) * Fraction(str(multiplier))
            return min(Fraction(1), raw)
        raw = f32(f32(f32(f32(n * f32(0.15)) + f32(0.6)) + (f32(0.3) if exalted else 0.0)) * f32(multiplier))
        return threshold(raw, GRID)

    @lru_cache(maxsize=None)
    def action(self, step: str, state: State, before: int) -> tuple:
        """Each outcome is (nextState, nextFP, policyAbort, probability)."""
        output = defaultdict(Fraction)
        if step in ("ADD_A", "ADD_B"):
            identity = self.a if step == "ADD_A" else self.b
            if self.can_add(state, identity):
                return ()
            n = sum(not entry[2] for entry in state)
            hi = 10 if n == 0 else 14 if n == 1 else 18
            added = state + ((identity, 1, False),)
            for after, p in self.fp_kernel(before, hi, True):
                output[(added, after, False)] += (1 - self.q_critical) * p
            for upgraded, p in self.critical_kernel(added, identity):
                output[(upgraded, before, False)] += self.q_critical * p
        elif step == "SEAL_CURRENT_JUNK":
            eligible = self.junk(state)
            if not eligible or any(entry[2] for entry in state):
                return ()
            index = min(eligible, key=lambda i: (state[i][1], i))
            identity, tier, _ = state[index]
            p_seal = self.seal_probability(state, index)
            hi = {1: 10, 2: 12, 3: 18, 4: 24}[tier]
            sealed = ((identity, tier, True),) + state[:index] + state[index + 1:]
            for after, p in self.fp_kernel(before, hi, False):
                output[(sealed, after, False)] += p_seal * p
                # Failure upgrades before complete Forge settlement, then aborts.
                failed = state[:index] + ((identity, tier + 1, False),) + state[index + 1:]
                output[(failed, after, True)] += (1 - p_seal) * (1 - self.q_critical) * p
            if p_seal < 1:
                for upgraded, p in self.critical_kernel(failed, identity):
                    output[(upgraded, before, True)] += (1 - p_seal) * self.q_critical * p
        else:
            raise ValueError(f"Unknown one-shot step: {step}")
        output = {key: p for key, p in output.items() if p}
        require(sum(output.values()) == 1, f"Atomic route kernel lost mass: {step}")
        for (new_state, after, _), _p in output.items():
            require(0 <= after <= before <= 63, "FP cannot grow above action entrance")
            require(len({row[0] for row in new_state}) == len(new_state), "Duplicate affix introduced")
            require(sum(not row[2] and row[1] == 7 for row in new_state) == self.initial_t7_count,
                    "Preparation changed the number of ordinary T7 affixes")
        self.atomic_mass_checks += 1
        return tuple((*key, p) for key, p in output.items())

    @lru_cache(maxsize=None)
    def evaluate(self, stage: int, state: State, before: int) -> Metrics:
        if self.complete(state):
            return SUCCEEDED
        if stage >= len(self.route["steps"]):
            return FAILED
        step = self.route["steps"][stage]
        if step == "PREPARE_HAVOC" and self.junk(state, only_t1=True):
            return self.evaluate(stage + 1, state, before)
        if before <= 0:
            return FAILED
        if step in ("PREPARE_HAVOC", "FINAL_HAVOC"):
            return self.havoc(stage, state, before)
        result = Metrics()
        for next_state, after, aborted, p in self.action(step, state, before):
            child = FAILED if aborted else self.evaluate(stage + 1, next_state, after)
            delta = Interval.exact(before - after)
            transitioned = Metrics(child.p, delta + child.spent, ONE + child.attempts,
                                   delta * child.p + child.success_spent)
            result = result + transitioned.scale(p)
            if step == "ADD_B" and not aborted:
                self.seen_ready_states.add(next_state)
        return result

    def havoc(self, stage: int, state: State, before: int) -> Metrics:
        indices = tuple(i for i, row in enumerate(state) if not row[2])
        if len(indices) != 4:
            return FAILED
        tiers = tuple(state[i][1] for i in indices)
        if len(set(tiers)) < 2:
            return FAILED
        # Only this proven complete-graph symmetry merges non-target layouts.
        signature = (stage, tuple((row[0], row[2], row[1] if row[2] else 0) for row in state), tuple(sorted(tiers)))
        if signature not in self.havoc_tables:
            layouts = []
            for arrangement in sorted(set(permutations(tiers))):
                mutable = list(state)
                for i, tier in zip(indices, arrangement):
                    mutable[i] = (mutable[i][0], tier, False)
                layouts.append(tuple(mutable))
            is_goal = self.complete if self.route["steps"][stage] == "FINAL_HAVOC" else lambda s: bool(self.junk(s, True))
            goals = [layout for layout in layouts if is_goal(layout)]
            if not goals:
                return FAILED
            require(not is_goal(state), "Satisfied Havoc stage should have been skipped")
            hit = Fraction(len(goals), len(layouts) - 1)
            miss = 1 - hit
            table = [FAILED]
            self.havoc_tables[signature] = table
            for budget in range(1, 64):
                numerator = Metrics()
                loop = ZERO
                for after, cost_mass in self.fp_kernel(budget, 20, True):
                    goal_mean = Metrics()
                    for goal in goals:
                        goal_mean = goal_mean + self.evaluate(stage + 1, goal, after).scale(Fraction(1, len(goals)))
                    known = goal_mean.scale(hit)
                    if after < budget:
                        known = known + table[after].scale(miss)
                    else:
                        loop = loop + Interval.exact(cost_mass * miss)
                    delta = Interval.exact(budget - after)
                    numerator = numerator + Metrics(
                        known.p, delta + known.spent, ONE + known.attempts,
                        delta * known.p + known.success_spent,
                    ).scale(cost_mass)
                table.append(numerator.divide(loop.complement()))
        return self.havoc_tables[signature][before]

    def points(self) -> list[dict]:
        initial = tuple((row["id"], row["tier"], row["sealed"]) for row in self.case["initialAffixes"])
        points = []
        for before in range(64):
            result = self.evaluate(0, initial, before)
            points.append({"initialFp": before, "successProbability": result.p.report(1),
                           "expectedActualFpSpent": result.spent.report(before),
                           "expectedAttempts": result.attempts.report(),
                           "successfulFpFirstMoment": result.success_spent.report(before),
                           "expectedFpGivenSuccess": (result.success_spent / result.p).report(before) if result.p.lo > 0 else None})
            require(result.p.hi - result.p.lo < 1e-8, "Probability enclosure too wide")
            require(result.p.lo >= -1e-12 and result.p.hi <= 1 + 1e-8, "Probability outside unit range")
        return points


def load_cases() -> tuple[dict, dict]:
    payload = json.loads(CASES.read_text(encoding="utf-8"))
    definitions = {row["id"]: row["definition"] for row in json.loads((ROOT / "data/game/1.5.3/affixes.json").read_text(encoding="utf-8"))["affixes"]}
    require(payload["materials"] == {"availability": "UNLIMITED", "costInObjective": False}, "Material policy changed")
    for case in payload["cases"]:
        require(case["baseId"] == "4:0" and case["playerLevel"] == 100, "Fixture level/base scope changed")
        for identity in {row["id"] for row in case["initialAffixes"]} | {case["targetAId"], case["targetBId"]}:
            d = definitions[identity]
            require(d["specialAffixType"] == 0 and 4 in d["canRollOn"] and class_matches(0, d["classSpecificity"]),
                    f"Fixture identity incompatible with current glove base: {identity}")
    return payload, definitions


def check_structural_cases(payload: dict, definitions: dict) -> dict:
    direct, swap = payload["cases"]
    evaluator = Evaluator(direct, direct["routes"][0], "NORMAL", DISPLAY, definitions)
    s0 = tuple((row["id"], row["tier"], False) for row in direct["initialAffixes"])
    add = evaluator.action("ADD_A", s0, 63)
    require(any(any(row[0] == 2 and row[1] == 2 for row in state) for state, _, _, _ in add), "Junk critical-upgrade branch was dropped")
    added_nominal = s0 + ((direct["targetAId"], 1, False),)
    index = evaluator.junk(added_nominal)[0]
    require(evaluator.seal_probability(added_nominal, index) == 1, "Four-affix exalted T1 seal must be certain")
    require(evaluator.seal_probability(s0, evaluator.junk(s0)[0]) == Fraction(189, 200), "Three-affix T1 seal reference differs")
    j2 = tuple((identity, 2 if identity == 2 else tier, sealed) for identity, tier, sealed in added_nominal)
    require(evaluator.seal_probability(j2, evaluator.junk(j2)[0]) == Fraction(69, 100), "Crit-upgraded junk must use T2 seal probability")
    branches = evaluator.action("SEAL_CURRENT_JUNK", j2, 63)
    require(any(abort and after == 63 for _, after, abort, p in branches if p), "Failed-seal critical refund branch missing")
    p = Evaluator(swap, swap["routes"][0], "NORMAL", DISPLAY, definitions)
    s = tuple((row["id"], row["tier"], False) for row in swap["initialAffixes"]) + ((swap["targetAId"], 1, False),)
    arrangements = set(permutations([7, 7, 1, 1]))
    changed = [tuple((row[0], tier, row[2]) for row, tier in zip(s, tiers)) for tiers in arrangements if tuple(tiers) != (7, 7, 1, 1)]
    require(len(changed) == 5 and all(p.junk(state, True) for state in changed), "Nominal prep does not hit in every changed layout")
    for case in payload["negativeCases"]:
        ev = Evaluator(case, {"steps": ["ADD_A"]}, "NORMAL", DISPLAY, definitions)
        state = tuple((row["id"], row["tier"], row["sealed"]) for row in case["initialAffixes"])
        require(ev.can_add(state, case["targetAId"]) == case["expected"], f"Missed invalid-add case {case['id']}")
    return {"normalAddIncluded": True, "criticalCanChangeJunkTier": True, "nominalFullT1SealProbability": "1",
            "threeAffixT1SealReference": "189/200", "critUpgradedT2SealReference": "69/100",
            "nominalPrepChangedLayouts": 5, "nominalPrepHitGivenChanged": "1",
            "negativeAddCases": len(payload["negativeCases"]), "failedSealRefundBeforeAbort": True}


def compute() -> dict:
    payload, definitions = load_cases()
    structural = check_structural_cases(payload, definitions)
    profiles = []
    mass_checks, ready_states, maximum_width = 0, set(), 0.0
    for profile in (DISPLAY, GRID):
        scenarios = []
        for case in payload["cases"]:
            for route in case["routes"]:
                for fp_type in ("NORMAL", "ICE", "BLOOD"):
                    evaluator = Evaluator(case, route, fp_type, profile, definitions)
                    points = evaluator.points()
                    score = ZERO
                    for point in points[1:]:
                        p = point["successProbability"]
                        score = score + Interval(p["lower"], p["upper"]) * Interval.exact(Fraction(1, 63))
                        maximum_width = max(maximum_width, p["upper"] - p["lower"])
                    scenarios.append({"caseId": case["id"], "routeId": route["id"], "fpType": fp_type,
                                      "primaryUserRoute": route["primary"], "macroStages": len(route["steps"]),
                                      "scoreUniformFp1To63": score.report(1), "points": points})
                    mass_checks += evaluator.atomic_mass_checks
                    ready_states.update(evaluator.seen_ready_states)
                    evaluator.evaluate.cache_clear()
                    evaluator.action.cache_clear()
                    evaluator.fp_kernel.cache_clear()
                    evaluator.critical_kernel.cache_clear()
        profiles.append({"id": profile, "scenarios": scenarios})
    require(any(sorted(row[1] for row in state if not row[2]) != [1, 1, 7, 7] for state in ready_states),
            "All final-Havoc entries were incorrectly forced to 7711")
    return {"schemaVersion": 1, "gameVersion": payload["gameVersion"], "steamBuildId": payload["steamBuildId"],
            "caseFileSha256": hashlib.sha256(CASES.read_bytes()).hexdigest(),
            "kind": "USER_7710_COMPLETE_FIXED_ROUTE_REFERENCE", "productionOptimizerImplemented": False,
            "materialCostInObjective": False, "materialsUnlimited": True,
            "evaluationStatus": "OUTWARD_ROUNDED_ENCLOSURE_UNDER_DECLARED_REFERENCE_MODEL",
            "nativeGridBitExact": False,
            "modelQualification": "Native-threshold/cost-grid profile still uses uniform changed tier permutations and iid primitives. Value rolls are marginalized only for these no-roll targets and level100 cases.",
            "finiteShuffleCap": {"cap": 10000, "numericConvention": "condition on obtaining a changed permutation",
                                 "separateProbabilityErrorBound": "500 * 6^(-10000)",
                                 "justification": "Any paid rune reduces FP; <=63 paid steps, free rune probability<=0.4750002. At most a bounded number of one-shot preparatory steps; conservative expected-shuffle bound500, union bound per native rejection tail<=6^-10000."},
            "validation": {"structuralCases": structural, "exactAtomicMassChecks": mass_checks,
                           "distinctReadyStates": len(ready_states), "maxSuccessProbabilityIntervalWidth": maximum_width},
            "profiles": profiles}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    artifact = compute()
    content = encode_json(artifact)
    if args.verify_only:
        require(OUTPUT.read_bytes() == content, "7710 route reference artifact is stale")
    else:
        OUTPUT.write_bytes(content)
    print(json.dumps({"status": "PASS", "verifiedOnly": args.verify_only,
                      "scenarios": sum(len(profile["scenarios"]) for profile in artifact["profiles"]),
                      **artifact["validation"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
