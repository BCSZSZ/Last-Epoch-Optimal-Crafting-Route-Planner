"""Evaluate already-owned-A@T7 771x pattern families using audited fixed routes.

All inputs, macro order, target identities and assumptions are explicit. This is
a conformance evaluator, not an implementation of general route discovery.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import json

from check_7710_routes import DISPLAY, GRID, ZERO, Evaluator, Interval, load_cases, require
from extract_game_snapshot import ROOT, encode_json

CASES = ROOT / "research/common-pattern-cases.json"
OUTPUT = ROOT / "research/common-pattern-results.json"


def create_cases() -> dict:
    payload = {"schemaVersion": 1, "gameVersion": "1.5.3", "steamBuildId": 26087601,
               "materials": {"availability": "UNLIMITED", "costInObjective": False},
               "pattern": "771x_WITH_ONE_TARGET_ALREADY_T7",
               "xDomain": list(range(1, 8)),
               "supportGlyphs": {"ADD_A": "HOPE", "ADD_B": "HOPE", "PREPARE_HAVOC": "HOPE", "FINAL_HAVOC": "HOPE", "SEAL_CURRENT_JUNK": "DESPAIR"},
               "scope": "Four ordinary unsealed affixes; A alreadyT7, B absent, regular sealed slot empty. x7 includes threeT7 and is a boundary case. x0 is separately tested as an incomplete three-slot recipe.",
               "cases": []}
    for x in range(1, 8):
        for family, affixes, steps in (
            ("existing_a_direct", [(4, 7), (7, 7), (2, 1), (10, x)], ["SEAL_CURRENT_JUNK", "ADD_B", "FINAL_HAVOC"]),
            ("existing_a_prepare", [(4, 7), (26, 7), (10, 1), (7, x)], ["PREPARE_HAVOC", "SEAL_CURRENT_JUNK", "ADD_B", "FINAL_HAVOC"]),
        ):
            payload["cases"].append({"id": f"{family}_x{x}", "patternFamily": family, "x": x,
                                     "baseId": "4:0", "playerLevel": 100, "targetAId": 4, "targetBId": 5,
                                     "initialAffixes": [{"id": identity, "tier": tier, "sealed": False} for identity, tier in affixes],
                                     "routes": [{"id": f"{family}_route", "primary": True, "steps": steps}]})
    payload["negativeCases"] = [{"id": "existing_a_x0_needs_extra_filler", "baseId": "4:0", "playerLevel": 100,
                                 "targetAId": 4, "targetBId": 5,
                                 "initialAffixes": [{"id": 4, "tier": 7, "sealed": False}, {"id": 7, "tier": 7, "sealed": False}, {"id": 2, "tier": 1, "sealed": False}],
                                 "routes": [{"id": "incomplete_seal_add_havoc", "primary": False,
                                             "steps": ["SEAL_CURRENT_JUNK", "ADD_B", "FINAL_HAVOC"]}],
                                 "expected": "RECIPE_CANNOT_REACH_FOUR_ORDINARY_SLOTS", "notGloballyImpossible": True}]
    return payload


def clear_caches(evaluator: Evaluator) -> None:
    evaluator.evaluate.cache_clear()
    evaluator.action.cache_clear()
    evaluator.fp_kernel.cache_clear()
    evaluator.critical_kernel.cache_clear()


def compute() -> dict:
    payload = json.loads(CASES.read_text(encoding="utf-8"))
    require(payload == create_cases(), "Common pattern contract differs from the declared family generator")
    _, definitions = load_cases()
    checks = {"alreadyOwnedTargetNotAddedAgain": True, "targetAExcludedFromSeal": True,
              "x0RecipeInapplicableNotGloballyImpossible": True, "x7ThreeT7Handled": True}
    mass_checks, max_width = 0, 0.0
    profiles = []
    for profile in (DISPLAY, GRID):
        scenarios = []
        for case in payload["cases"] + payload["negativeCases"]:
            a = case["targetAId"]
            require(any(row["id"] == a and row["tier"] == 7 for row in case["initialAffixes"]), "A is not initiallyT7")
            for route in case["routes"]:
                require("ADD_A" not in route["steps"], "An already-present target must not be added again")
                for fp_type in ("NORMAL", "ICE", "BLOOD"):
                    evaluator = Evaluator(case, route, fp_type, profile, definitions)
                    initial = tuple((row["id"], row["tier"], row["sealed"]) for row in case["initialAffixes"])
                    require(all(initial[index][0] != a for index in evaluator.junk(initial)), "Selector may seal targetA")
                    points = evaluator.points()
                    score = ZERO
                    for point in points[1:]:
                        p = point["successProbability"]
                        score = score + Interval(p["lower"], p["upper"]) * Interval.exact(Fraction(1, 63))
                        max_width = max(max_width, p["upper"] - p["lower"])
                    if case.get("expected"):
                        require(all(point["successProbability"]["upper"] == 0 for point in points), "x0 missing filler was silently ignored")
                    else:
                        require(points[63]["successProbability"]["lower"] > 0, "Common route unexpectedly unreachable")
                    scenarios.append({"caseId": case["id"], "routeId": route["id"], "x": case.get("x", 0),
                                      "fpType": fp_type, "negativeRecipe": "expected" in case,
                                      "scoreUniformFp1To63": score.report(1), "points": points})
                    mass_checks += evaluator.atomic_mass_checks
                    clear_caches(evaluator)
        profiles.append({"id": profile, "scenarios": scenarios})
    return {"schemaVersion": 1, "gameVersion": payload["gameVersion"], "steamBuildId": payload["steamBuildId"],
            "kind": "COMMON_771X_EXISTING_TARGET_FIXED_ROUTE_REFERENCE",
            "caseFileSha256": hashlib.sha256(CASES.read_bytes()).hexdigest(),
            "materialsUnlimited": True, "materialCostInObjective": False,
            "productionOptimizerImplemented": False, "nativeGridBitExact": False,
            "evaluationStatus": "OUTWARD_ROUNDED_ENCLOSURE_UNDER_DECLARED_REFERENCE_MODEL",
            "modelQualification": "All native thresholds/costs follow the selected iid reference profile; Havoc uses uniform changed tier layouts. Rolls are marginalized only for these no-roll targets and role100 fixtures.",
            "finiteShuffleCap": {"cap": 10000, "separateReferenceProbabilityErrorBound": "500 * 4^(-10000)",
                                 "qualification": "Only the rejected-unchanged-layout tail under uniform permutation assumptions; not all differences from the native seeded PRNG."},
            "validation": {"structuralCases": checks, "validPatternInputs": len(payload["cases"]),
                           "negativeRecipeInputs": len(payload["negativeCases"]), "exactAtomicMassChecks": mass_checks,
                           "maxSuccessProbabilityIntervalWidth": max_width},
            "profiles": profiles}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--write-cases", action="store_true", help="Explicitly generate the declared family fixtures.")
    args = parser.parse_args()
    if args.write_cases:
        require(not args.verify_only, "Cannot write cases in verify-only mode")
        CASES.write_bytes(encode_json(create_cases()))
    artifact = compute()
    content = encode_json(artifact)
    if args.verify_only:
        require(OUTPUT.read_bytes() == content, "Common pattern result artifact is stale")
    else:
        OUTPUT.write_bytes(content)
    print(json.dumps({"status": "PASS", "verifiedOnly": args.verify_only,
                      "scenarios": sum(len(profile["scenarios"]) for profile in artifact["profiles"]),
                      **artifact["validation"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
