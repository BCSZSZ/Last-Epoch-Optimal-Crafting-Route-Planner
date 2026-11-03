"""Independent Monte Carlo for existing-A 771x fixed preparation patterns.

Uses the independent direct-operation sampler, never the DP evaluator or its
transition kernels. The report is deterministic; elapsed time is stdout-only.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import random
import time

from check_7710_monte_carlo import DirectForge, derive_seed, probability_interval


ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "research/common-pattern-cases.json"
RESULTS = ROOT / "research/common-pattern-results.json"
OUTPUT = ROOT / "research/common-pattern-monte-carlo.json"
SHARED_SAMPLER = ROOT / "scripts/check_7710_monte_carlo.py"
PROFILE = "display_parameters_iid"
SEED = 771120261103
SELECTED_X = (1, 3, 7)
FP_TYPES = ("NORMAL", "ICE", "BLOOD")
FP_POINTS = (10, 30, 63)
EXPECTED_FAMILIES = {"existing_a_direct", "existing_a_prepare"}


def read_pinned(path: Path) -> tuple[dict, str]:
    raw = path.read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def compute(samples: int, seed: int, cases_path: Path, results_path: Path | None) -> dict:
    fixture, fixture_sha = read_pinned(cases_path)
    if fixture["materials"] != {"availability": "UNLIMITED", "costInObjective": False}:
        raise ValueError("These patterns require unlimited physical material stock and zero material objective cost.")
    expected = {}
    results_sha = None
    if results_path is not None:
        reference, results_sha = read_pinned(results_path)
        if reference["caseFileSha256"] != fixture_sha:
            raise ValueError("Common-pattern DP results do not match the current fixture.")
        if not reference["materialsUnlimited"] or reference["materialCostInObjective"]:
            raise ValueError("DP material policy differs from the sampling policy.")
        profile = next(profile for profile in reference["profiles"] if profile["id"] == PROFILE)
        for scenario in profile["scenarios"]:
            for point in scenario["points"]:
                expected[(scenario["caseId"], scenario["routeId"], scenario["fpType"], point["initialFp"])] = point
    catalog, catalog_sha = read_pinned(ROOT / "data/game/1.5.3/affixes.json")
    sides = {int(row["id"]): int(row["definition"]["type"]) for row in catalog["affixes"]}
    selected_cases = [case for case in fixture["cases"] if case["x"] in SELECTED_X]
    if {(case["patternFamily"], case["x"]) for case in selected_cases} != {
        (family, x) for family in EXPECTED_FAMILIES for x in SELECTED_X
    }:
        raise ValueError("The six preregistered existing-A cases are missing or changed.")
    rows = []
    for case in selected_cases:
        if case["baseId"] != "4:0" or case["playerLevel"] != 100:
            raise ValueError("Sampler scope is gloves4:0 / player100.")
        start = case["initialAffixes"]
        if len(start) != 4 or any(affix["sealed"] for affix in start):
            raise ValueError("Positive existing-A cases start with four ordinary unsealed affixes.")
        if not any(affix["id"] == case["targetAId"] and affix["tier"] == 7 for affix in start):
            raise ValueError("A must already be unsealedT7 at the start.")
        if any(affix["id"] == case["targetBId"] for affix in start):
            raise ValueError("B must be missing at the start.")
        t7_before = sum(affix["tier"] == 7 for affix in start)
        if t7_before != (3 if case["x"] == 7 else 2):
            raise ValueError("The x7 boundary must retain its thirdT7.")
        for route in case["routes"]:
            expected_steps = ["SEAL_CURRENT_JUNK", "ADD_B", "FINAL_HAVOC"]
            if case["patternFamily"] == "existing_a_prepare":
                expected_steps.insert(0, "PREPARE_HAVOC")
            if route["steps"] != expected_steps:
                raise ValueError("The preregistered fixed preparation route changed.")
            for fp_type in FP_TYPES:
                for fp in FP_POINTS:
                    point_seed = derive_seed(seed, case["id"], route["id"], fp_type, fp)
                    rng = random.Random(point_seed)
                    hits = spent = spent_squared = actions = 0
                    reasons = Counter()
                    for _ in range(samples):
                        item = DirectForge(case, fp, fp_type, rng, sides, fixture["supportGlyphs"])
                        success, reason = item.execute(route["steps"])
                        if any(identity == case["targetAId"] and sealed for identity, _tier, sealed in item.affixes):
                            raise AssertionError("The preparation macro must never seal A, even if Havoc lowered its tier.")
                        if sum(tier == 7 and not sealed for _identity, tier, sealed in item.affixes) != t7_before:
                            raise AssertionError("A sampled preparation lost an ordinaryT7.")
                        hits += success
                        consumption = fp - item.fp
                        if not 0 <= consumption <= fp:
                            raise AssertionError("Actual FP spend left its legal range.")
                        spent += consumption
                        spent_squared += consumption * consumption
                        actions += item.actions
                        reasons[reason] += 1
                    observed = hits / samples
                    variance = max(0.0, spent_squared / samples - (spent / samples) ** 2)
                    row = {
                        "caseId": case["id"], "patternFamily": case["patternFamily"], "x": case["x"],
                        "routeId": route["id"], "fpType": fp_type, "initialFp": fp,
                        "initialOrdinaryT7Count": t7_before, "samples": samples, "seed": point_seed,
                        "successes": hits, "observedSuccessProbability": observed,
                        "meanActualFpSpent": spent / samples,
                        "fpSpentMeanStandardError": math.sqrt(variance / samples),
                        "meanAtomicActions": actions / samples, "terminalReasons": dict(sorted(reasons.items())),
                    }
                    if results_path is not None:
                        point = expected[(case["id"], route["id"], fp_type, fp)]
                        lower, upper = probability_interval(point)
                        if not 0 <= lower <= upper <= 1:
                            raise ValueError("Invalid DP probability interval.")
                        center = (lower + upper) / 2
                        allowance = 5 * math.sqrt(center * (1 - center) / samples) + 1 / samples
                        distance = max(lower - observed, observed - upper, 0.0)
                        row.update({
                            "dpSuccessLower": lower, "dpSuccessUpper": upper,
                            "preRegisteredAllowance": allowance,
                            "absoluteDistanceOutsideDpInterval": distance,
                            "passed": distance <= allowance,
                        })
                        if "expectedActualFpSpent" in point:
                            row["dpExpectedActualFpSpent"] = point["expectedActualFpSpent"]
                    rows.append(row)
    if len(rows) != 54:
        raise ValueError(f"Expected54 preregistered points, got{len(rows)}.")
    return {
        "schemaVersion": 1, "model": PROFILE, "gameVersion": fixture["gameVersion"],
        "fixtureSha256": fixture_sha, "referenceResultsSha256": results_sha,
        "independentSamplerSha256": hashlib.sha256(SHARED_SAMPLER.read_bytes()).hexdigest(),
        "affixCatalogSha256": catalog_sha, "baseSeed": seed,
        "method": "Independent direct-operation sampling reused from check_7710_monte_carlo; never imports check_7710_routes or its kernels.",
        "selection": {"x": list(SELECTED_X), "families": sorted(EXPECTED_FAMILIES), "fpTypes": list(FP_TYPES), "initialFp": list(FP_POINTS)},
        "scope": "Four ordinary starting affixes with A alreadyT7 and B missing; x7 starts with threeT7. The x0 three-slot recipe is a separate structural negative case, not silently treated as a full four-slot route.",
        "assumptions": [
            "Display-parameter independent draws, not a native PRNG replay or client test.",
            "Havoc is uniform conditional on changing the tier sequence; finite native rejection-cap mass is not sampled.",
            "Role100 and gloves4:0 use the audited six ordinary affix identities; roll values are marginalized because no roll target exists.",
            "PREPARE_HAVOC and SEAL selectors exclude both target identities; A cannot be sealed even after its tier changes.",
            "Unlimited physical materials, no material objective cost; seal failure completes native settlement before route abort.",
        ],
        "acceptance": "Per point: DP success interval plus5*sqrt(p_mid*(1-p_mid)/N)+1/N, preregistered. FP consumption means are diagnostic only.",
        "samplesPerPoint": samples, "pointCount": len(rows), "totalSamples": samples * len(rows),
        "comparedWithDp": results_path is not None,
        "passed": all(row.get("passed", True) for row in rows) if results_path is not None else None,
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=20000)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--cases", type=Path, default=CASES)
    parser.add_argument("--results", type=Path, default=RESULTS)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--verify-only", action="store_true", help="Recompute and compare the committed report without writing.")
    parser.add_argument("--simulate-only", action="store_true", help="Diagnostic sampling without claiming DP agreement.")
    parser.add_argument("--summary", action="store_true", help="Compatibility flag: stdout always emits one compact JSON summary.")
    parser.add_argument("--no-timing", action="store_true", help="Compatibility flag: report artifacts always exclude timing.")
    args = parser.parse_args()
    if args.samples <= 0:
        parser.error("--samples must be positive")
    if args.verify_only and args.simulate_only:
        parser.error("--verify-only requires comparison against the DP reference")
    started = time.perf_counter()
    report = compute(args.samples, args.seed, args.cases, None if args.simulate_only else args.results)
    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.verify_only:
        if args.output.read_text(encoding="utf-8") != encoded:
            raise SystemExit("Common-pattern Monte Carlo artifact is stale; regenerate explicitly.")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8", newline="\n")
    elapsed = round(time.perf_counter() - started, 3)
    summary = {key: report[key] for key in ("comparedWithDp", "passed", "samplesPerPoint", "pointCount", "totalSamples", "baseSeed")}
    summary.update({"verifiedOnly": args.verify_only, "elapsedSeconds": elapsed})
    print(json.dumps(summary))
    if report["passed"] is False:
        raise SystemExit("Independent existing-A 771x Monte Carlo disagrees with the DP intervals.")


if __name__ == "__main__":
    main()
