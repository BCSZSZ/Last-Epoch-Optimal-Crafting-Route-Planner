"""Reproduce a concrete7732 repeated-Redemption baseline, not an optimizer.

The fixture has four non-target identities, with two T7 prefixes and two fixed
T3/T2 suffixes. A/B are both legal target prefixes. The one-cast reference uses
Fraction arithmetic. Multi-cast evaluation independently samples each updated
weighted identity pool plus the complete noncritical rune FP flow.

Model: displayed threshold independent draws, current float32 craft weights
normalized exactly for the small reference. This is not native PRNG replay,
not a bit-exact cumulative float32/grid calculation, and not a client test.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
from collections import defaultdict
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import random
import sys

from check_action_examples import load_reference_pool


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "research/7732-redemption-reference.json"
SNAPSHOT = ROOT / "data/game/1.5.3"
FP_AUDIT = ROOT / "research/forge-fp-claims.json"
INITIAL_IDS = (2, 26, 7, 10)
DISPLAY_TIERS = (7, 7, 3, 2)
TARGET_IDS = frozenset((4, 5))
FP_POINTS = (1, 10, 30, 63)
FP_TYPES = ("NORMAL", "ICE")
DEFAULT_SAMPLES = 50_000
MINIMUM_SAMPLES = 10_000
SEED = 202611037732
WILSON_Z_99 = 2.5758293035489004
MODEL_ID = "display_parameters_iid_with_current_normalized_craft_weights"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1 << 20):
            result.update(chunk)
    return result.hexdigest()


def fraction_record(value: Fraction) -> dict:
    return {"fraction": str(value), "decimal": float(value)}


def exact_one_cast(start: tuple[int, ...], pool: dict[int, dict]) -> tuple[Fraction, dict]:
    """Expand each slot using the updated whole-item ID set, then test success."""
    distribution = {start: Fraction(1)}
    for index in (0, 1):
        expanded = defaultdict(Fraction)
        for current, incoming_mass in distribution.items():
            side = pool[current[index]]["side"]
            candidates = [entry for entry in pool.values() if entry["side"] == side and entry["id"] not in current]
            denominator = sum((entry["weight"] for entry in candidates), Fraction())
            require(denominator > 0, "No positive reference candidate pool")
            slot_mass = Fraction()
            for entry in candidates:
                probability = entry["weight"] / denominator
                successor = current[:index] + (entry["id"],) + current[index + 1:]
                require(len(set(successor)) == 4, "Duplicate affix introduced")
                require(successor[2:] == start[2:], "Fixed suffix changed")
                expanded[successor] += incoming_mass * probability
                slot_mass += probability
            require(slot_mass == 1, "Slot reference probability mass is not one")
        distribution = dict(expanded)
        require(sum(distribution.values()) == 1, "Sequential reference probability mass is not one")
    success = sum((mass for outcome, mass in distribution.items() if frozenset(outcome[:2]) == TARGET_IDS), Fraction())
    return success, distribution


class DirectSampler:
    """Direct weighted sampling, with a CDF cache keyed by the CURRENT full ID set.

    This cache stores candidate lists only. It contains no route values, no FP
    dynamic programming and no precomputed success/failure probability.
    """

    def __init__(self, pool: dict[int, dict], parameters: dict) -> None:
        self.prefixes = tuple((entry["id"], float(entry["weight"])) for entry in pool.values() if entry["side"] == 0)
        self.parameters = parameters
        self.candidate_cache: dict[frozenset[int], tuple[tuple[int, ...], tuple[float, ...], float]] = {}

    def sample_prefix(self, current: list[int], rng: random.Random) -> int:
        excluded = frozenset(current)
        cached = self.candidate_cache.get(excluded)
        if cached is None:
            candidates = []
            cumulative = []
            total = 0.0
            for identity, weight in self.prefixes:
                if identity not in excluded and weight > 0:
                    candidates.append(identity)
                    total += weight
                    cumulative.append(total)
            require(total > 0, "No positive sampled candidate pool")
            cached = (tuple(candidates), tuple(cumulative), total)
            self.candidate_cache[excluded] = cached
        candidates, cumulative, total = cached
        selected = bisect_right(cumulative, rng.random() * total)
        # Floating multiplication can round an extreme endpoint to total.
        return candidates[min(selected, len(candidates) - 1)]

    def trial(self, initial_fp: int, fp_type: str, rng: random.Random) -> tuple[bool, int, int]:
        require(fp_type in ("NORMAL", "ICE", "BLOOD"), "Unsupported FP type")
        current = list(INITIAL_IDS)
        remaining_fp = initial_fp
        attempts = 0
        while remaining_fp > 0:
            attempts += 1
            require(attempts <= 1_000_000, "Simulation loop guard reached; no truncated result was returned")
            before = remaining_fp
            no_cost = rng.random() < self.parameters["hope"]
            if not no_cost and fp_type == "ICE":
                no_cost = rng.random() < self.parameters["ice"]
            if no_cost:
                cost = 0
            else:
                # Current rune charge is first; the lucky reroll upper bound
                # is the FIRST result, not the full original cost range.
                cost = rng.randrange(1, 20)
                if rng.random() < self.parameters["lucky"]:
                    cost = 1 if cost == 1 else rng.randrange(1, cost)
            remaining_fp = max(0, before - cost)

            # Both T7s are processed even if A/B are temporarily present
            # between the first and the second identity replacement.
            current[0] = self.sample_prefix(current, rng)
            current[1] = self.sample_prefix(current, rng)

            # Redemption is a rune operation: no primary-shard critical or
            # Blood critical branch. Public low-FP retention follows the rune.
            if remaining_fp < before:
                if remaining_fp < 2 and before > 2 and rng.random() < self.parameters["lowFpPreservation"]:
                    remaining_fp = 2
                elif remaining_fp == 0 and before > 1 and rng.random() < self.parameters["lowFpPreservation"]:
                    remaining_fp = 1
            require(0 <= remaining_fp <= before, "FP increased above its prior value")
            if frozenset(current[:2]) == TARGET_IDS:
                # A final cast that used all remaining FP still succeeds.
                return True, initial_fp - remaining_fp, attempts
        return False, initial_fp - remaining_fp, attempts


def wilson99(hits: int, count: int) -> dict:
    proportion = hits / count
    z2 = WILSON_Z_99 * WILSON_Z_99
    denominator = 1 + z2 / count
    center = (proportion + z2 / (2 * count)) / denominator
    radius = WILSON_Z_99 * math.sqrt(proportion * (1 - proportion) / count + z2 / (4 * count * count)) / denominator
    return {"level": 0.99, "method": "two_sided_Wilson_score", "z": WILSON_Z_99,
            "low": max(0.0, center - radius), "high": min(1.0, center + radius)}


def mean_and_se(total: int, squared_total: int, count: int) -> dict:
    mean = total / count
    variance = max(0.0, (squared_total - total * total / count) / (count - 1))
    return {"mean": mean, "standardError": math.sqrt(variance / count)}


def simulate_point(sampler: DirectSampler, initial_fp: int, fp_type: str, samples: int, seed: int) -> dict:
    rng = random.Random(seed)
    successes = fp_total = attempts_total = fp_squared = attempts_squared = success_fp_total = 0
    maximum_attempts = 0
    for _ in range(samples):
        success, actual_fp, attempts = sampler.trial(initial_fp, fp_type, rng)
        require(0 <= actual_fp <= initial_fp, "Actual spent FP outside valid range")
        successes += int(success)
        fp_total += actual_fp
        fp_squared += actual_fp * actual_fp
        attempts_total += attempts
        attempts_squared += attempts * attempts
        if success:
            success_fp_total += actual_fp
        else:
            require(actual_fp == initial_fp, "An unsuccessful baseline trial did not exhaust its FP")
        maximum_attempts = max(maximum_attempts, attempts)
    return {
        "fpType": fp_type, "initialFp": initial_fp, "samples": samples, "seed": seed,
        "successes": successes, "failures": samples - successes,
        "estimatedSuccessProbability": successes / samples,
        "successProbabilityInterval": wilson99(successes, samples),
        "actualFpSpent": mean_and_se(fp_total, fp_squared, samples),
        "attempts": mean_and_se(attempts_total, attempts_squared, samples),
        "meanFpConditionalOnSuccess": success_fp_total / successes if successes else None,
        "meanFpConditionalOnFailure": initial_fp if successes < samples else None,
        "maximumObservedAttempts": maximum_attempts,
    }


def input_hashes() -> dict:
    paths = [
        Path(__file__).resolve(), ROOT / "scripts/check_action_examples.py",
        ROOT / "research/affix-action-claims.json", FP_AUDIT,
        *(SNAPSHOT / name for name in ("manifest.json", "affixes.json", "items.json", "resource-parameters.json")),
    ]
    return {path.relative_to(ROOT).as_posix(): digest(path) for path in paths}


def compute(samples: int) -> dict:
    pool, action_claims, manifest = load_reference_pool()
    audit = read_json(FP_AUDIT)
    require(audit["gameAssemblySha256"] == manifest["installedFiles"]["GameAssembly.dll"]["sha256"], "FP audit binary differs from snapshot")
    require(audit["gameVersion"] == manifest["gameVersion"] and audit["steamBuildId"] == manifest["steamBuildId"], "FP audit version differs from snapshot")
    by_id = {row["id"]: row for row in audit["claims"]}
    require(by_id["FP-COST"]["coreNonAffixBounds"]["Redemption"] == [1, 20], "Audited Redemption cost changed")
    constants_raw = {
        "hope": by_id["FP-HOPE-ICE"]["hopeThresholdFloat32"],
        "ice": by_id["FP-HOPE-ICE"]["iceThresholdFloat32"],
        "lucky": by_id["FP-COST"]["luckyThresholdFloat32"],
        "lowFpPreservation": by_id["FP-LOW-PRESERVE"]["thresholdFloat32"],
    }
    parameters = {name: round(value, 6) for name, value in constants_raw.items()}
    require(parameters == {"hope": 0.25, "ice": 0.3, "lucky": 0.285, "lowFpPreservation": 0.05}, "Displayed model constants changed")
    require(not TARGET_IDS.intersection(INITIAL_IDS), "This fixture requires BOTH targets absent from all starting slots")
    require(tuple(pool[identity]["side"] for identity in INITIAL_IDS) == (0, 0, 1, 1), "Fixture prefix/suffix layout changed")
    require(all(pool[identity]["side"] == 0 for identity in TARGET_IDS), "Both targets must be prefixes")

    exact_probability, distribution = exact_one_cast(INITIAL_IDS, pool)
    require(exact_probability > 0, "No positive one-cast feasibility witness")
    old_example = action_claims["referenceExamples"]["redemption"][0]
    require(str(exact_probability) == old_example["fraction"], "One-cast reference does not match current audited data")
    require(len(distribution) == 289, "Expected289 positive one-cast exit states")
    varying = []
    for label, start in (("bothTargetsAbsent", INITIAL_IDS), ("targetAInFirstT7", (4, 26, 7, 10)), ("targetAInLastT7", (26, 4, 7, 10))):
        probability, outcomes = exact_one_cast(start, pool)
        varying.append({"case": label, "startingAffixIds": list(start), "successProbability": fraction_record(probability), "unitMass": str(sum(outcomes.values()))})
    require(len({row["successProbability"]["fraction"] for row in varying}) == 3, "Conditional one-cast hit probabilities unexpectedly coincide")

    sampler = DirectSampler(pool, parameters)
    # Common-random-number coupling supplements the native no-rune-critical
    # argument. Blood and Normal call the identical rune transition sequence.
    coupling_normal = random.Random(SEED + 901)
    coupling_blood = random.Random(SEED + 901)
    for _ in range(1_000):
        require(sampler.trial(30, "NORMAL", coupling_normal) == sampler.trial(30, "BLOOD", coupling_blood), "Blood/Normal rune coupling differed")
    rows = []
    for type_index, fp_type in enumerate(FP_TYPES):
        for point_index, initial_fp in enumerate(FP_POINTS):
            seed = SEED + (type_index * len(FP_POINTS) + point_index) * 104_729
            rows.append(simulate_point(sampler, initial_fp, fp_type, samples, seed))
    return {
        "schemaVersion": 1, "researchDate": "2026-11-03", "kind": "FIXED_INPUT_7732_REPEATED_REDEMPTION_FEASIBILITY_REFERENCE",
        "gameVersion": manifest["gameVersion"], "steamBuildId": manifest["steamBuildId"],
        "dataRevision": manifest["dataRevision"], "gameAssemblySha256": audit["gameAssemblySha256"],
        "inputs": input_hashes(),
        "fixture": {"baseId": "4:0", "playerLevel": 100,
                    "initialAffixes": [{"id": identity, "tier": tier, "sealed": False} for identity, tier in zip(INITIAL_IDS, DISPLAY_TIERS)],
                    "targetOrdinaryT7Ids": sorted(TARGET_IDS), "bothTargetsAbsentInitially": True,
                    "materials": "UNLIMITED", "materialCostInObjective": False,
                    "glyphOfHope": True, "ordinaryGlovePoolCount": len(pool)},
        "route": {"operation": "REPEAT_REDEMPTION", "success": "After the COMPLETE rune action, A4 and B5 are both nonsealedT7 prefixes.",
                  "continue": "After a non-successful complete action, repeat using updated IDs if FP remains positive.",
                  "failure": "FP is exhausted after a complete unsuccessful action.",
                  "fixedTiers": [7, 7, 3, 2], "suffixIdsRemain": [7, 10],
                  "fixedInitialHitProbabilityGeometricShortcutUsed": False},
        "probabilityModel": {"id": MODEL_ID, "evidenceConfidence": "VERIFIED", "routeEvaluation": "MONTE_CARLO_ESTIMATED",
                             "exactOneCastArithmetic": "fractions.Fraction", "thresholdsRawFloat32": constants_raw,
                             "thresholdsUsed": parameters,
                             "rng": "Python random.Random(MT19937), fixed per-point seeds; independent-draw model, not native RNG replay.",
                             "weightedDraw": "Current candidate exclusions are recalculated after EACH identity replacement; candidate CDFs are cached only by current complete ID set.",
                             "nativeGridBitExact": False, "actualClientTests": 0},
        "oneCastFeasibilityWitness": {"probability": fraction_record(exact_probability), "exitStates": len(distribution), "mass": str(sum(distribution.values())),
                                     "source": "Current snapshot weights and native sequential-ID exclusion rule; tiers3/2 do not enter Redemption reroll pool."},
        "conditionalHitRateCounterexamples": varying,
        "bloodNormalEquivalence": {"equalKernelForThisRuneRoute": True, "source": "forge-fp-claims.json FP-CRITICAL-GATE/FP-CRITICAL-ROLL: pure rune route has no primary-shard critical entrance; only Ice changes noCost branch.",
                                   "bloodRowsAlias": "NORMAL", "independentlySampledBloodRows": False, "couplingTrialChecks": 1_000},
        "validation": {"oneCastUnitMass": True, "oneCastPositive": True, "replicateSamplesPerPoint": samples,
                       "sampledPoints": len(rows), "totalRouteTrials": samples * len(rows), "wilsonConfidenceLevel": 0.99,
                       "fpZeroBoundary": {"successProbability": 0.0, "attempts": 0, "actualFpSpent": 0},
                       "importedRouteDynamicProgramming": False},
        "rows": rows,
        "limitations": [
            "This is one concrete both-targets-absent7732 fixture, not a universal7732 probability or global route optimum.",
            "A7732 item already containing both target identities can instead use a tier-permutation macro; it is a different subtype.",
            "Displayed thresholds and normalized weight draws are explicit model assumptions; finite native cumulative boundaries and seeded RNG correlations are outside this artifact.",
            "Wilson intervals quantify binomial sampling uncertainty only, not mechanics-model uncertainty.",
            "Materials are unlimited; no currency or inventory input and no material-expense infeasibility criterion is used.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Recompute with fixed seeds and compare without writing.")
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES, help="Trials per FP/type point; default50000.")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    require(args.samples >= MINIMUM_SAMPLES, "Use at least10000 trials per point")
    result = compute(args.samples)
    if args.verify_only:
        require(read_json(args.output) == result, "7732 reference artifact is stale; explicitly regenerate and review changed inputs")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"status": "PASS", "verifiedOnly": args.verify_only, "trials": result["validation"]["totalRouteTrials"],
                      "oneCastFraction": result["oneCastFeasibilityWitness"]["probability"]["fraction"],
                      "bloodEqualsNormal": True,
                      "rows": [{"fpType": row["fpType"], "initialFp": row["initialFp"], "estimatedP": row["estimatedSuccessProbability"],
                                "wilson99": [row["successProbabilityInterval"]["low"], row["successProbabilityInterval"]["high"]]} for row in result["rows"]]},
                     ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, ValueError, StopIteration) as exc:
        print(f"7732 Redemption reference failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
