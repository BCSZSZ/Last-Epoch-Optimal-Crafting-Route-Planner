"""Reproduce audited non-critical rune FP examples; not a product solver.

Only Python's standard library is required. Inputs are the committed current-build
audit, not the parent checkout, caches, installed game, or network. Two explicit
independent-draw models distinguish displayed parameters from native draw grids.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from fractions import Fraction
from functools import lru_cache
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "research/fp-examples.json"
AUDIT = ROOT / "research/forge-fp-claims.json"
FMAX = 63
DISPLAY = "display_parameters_iid"
GRID = "native_uniform_grid_iid"
PROFILES = (DISPLAY, GRID)
SETTINGS = tuple((fp_type, hope) for fp_type in ("NORMAL", "ICE", "BLOOD") for hope in (False, True))


def threshold(value: float, profile: str) -> Fraction:
    if profile == DISPLAY:
        return Fraction(str(round(value, 6)))
    q = Fraction.from_float(value)
    if q <= 0:
        return Fraction(0)
    if q >= 1:
        return Fraction(1)
    # Native Roll compares q >= U on the high-23-bit grid. Independence and
    # uniformity here are model assumptions, not a proof about PRNG state paths.
    grid = 1 << 23
    return Fraction((q * grid).__floor__() + 1, grid)


@lru_cache(maxsize=None)
def integer_draw(lo: int, hi: int, profile: str) -> tuple[tuple[int, Fraction], ...]:
    if hi < lo:
        raise ValueError("The audited examples do not use reversed native bounds.")
    if hi == lo:
        return ((lo, Fraction(1)),)
    width = hi - lo
    if profile == DISPLAY:
        return tuple((lo + i, Fraction(1, width)) for i in range(width))
    size = 1 << 32
    # NextInt = lo + high32((hi-lo) * old_uint32_state).
    ceil_div = lambda a, b: (a + b - 1) // b
    result = tuple(
        (lo + i, Fraction(ceil_div((i + 1) * size, width) - ceil_div(i * size, width), size))
        for i in range(width)
    )
    assert sum(p for _, p in result) == 1
    return result


@lru_cache(maxsize=None)
def raw_cost(hi: int, profile: str, lucky: Fraction) -> tuple[tuple[int, Fraction], ...]:
    result: dict[int, Fraction] = defaultdict(Fraction)
    for first, mass in integer_draw(1, hi, profile):
        result[first] += mass * (1 - lucky)
        for second, conditional in integer_draw(1, first, profile):
            result[second] += mass * lucky * conditional
    assert sum(result.values()) == 1
    return tuple(sorted(result.items()))


@lru_cache(maxsize=None)
def low_fp_exit(before: int, cost: int, preserve: Fraction) -> tuple[tuple[int, Fraction], ...]:
    after = max(0, before - cost)
    if cost == 0:
        return ((before, Fraction(1)),)
    result: dict[int, Fraction] = defaultdict(Fraction)
    remaining = Fraction(1)
    if after < 2 and before > 2:
        result[2] += preserve
        remaining -= preserve
    if after == 0 and before > 1:
        result[1] += remaining * preserve
        remaining *= 1 - preserve
    result[after] += remaining
    assert sum(result.values()) == 1
    assert all(0 <= after <= before for after in result)
    return tuple(sorted(result.items()))


def cost_exit(
    before: int, hi: int, profile: str, no_cost: Fraction,
    lucky: Fraction, preserve: Fraction,
) -> tuple[tuple[int, Fraction], ...]:
    if before == 0:
        # A boundary, not permission to execute a rune at zero FP.
        return ((0, Fraction(1)),)
    result: dict[int, Fraction] = defaultdict(Fraction)
    result[before] += no_cost
    for cost, mass in raw_cost(hi, profile, lucky):
        for after, conditional in low_fp_exit(before, cost, preserve):
            result[after] += (1 - no_cost) * mass * conditional
    result = {key: value for key, value in result.items() if value}
    assert sum(result.values()) == 1
    assert all(0 <= after <= before for after in result)
    return tuple(sorted(result.items()))


def fraction_data(value: Fraction) -> dict:
    return {"fraction": str(value), "decimal": float(value)}


def reference_curve(
    hit_probability: Fraction, transitions: list[tuple[tuple[int, Fraction], ...]],
) -> list[dict]:
    """A failed-start, fixed-family Havoc reference, without route search."""
    success = [Fraction(0)]
    attempts = [Fraction(0)]
    fp_spent = [Fraction(0)]
    rows = [{"initialFp": 0, "successProbability": 0.0, "expectedAttempts": 0.0, "expectedActualFpSpent": 0.0}]
    for before in range(1, FMAX + 1):
        kernel = transitions[before]
        self_loop = next((mass for after, mass in kernel if after == before), Fraction(0))
        denom = 1 - (1 - hit_probability) * self_loop
        assert denom > 0
        lower = [(after, mass) for after, mass in kernel if after < before]
        success.append((hit_probability + (1 - hit_probability) * sum(mass * success[after] for after, mass in lower)) / denom)
        attempts.append((1 + (1 - hit_probability) * sum(mass * attempts[after] for after, mass in lower)) / denom)
        expected_cost = sum((before - after) * mass for after, mass in kernel)
        fp_spent.append((expected_cost + (1 - hit_probability) * sum(mass * fp_spent[after] for after, mass in lower)) / denom)
        assert 0 <= success[-1] <= 1
        assert 0 <= fp_spent[-1] <= before
        assert success[-1] >= success[-2]
        rows.append({"initialFp": before, "successProbability": float(success[-1]), "expectedAttempts": float(attempts[-1]), "expectedActualFpSpent": float(fp_spent[-1])})
    return rows


def compute() -> dict:
    audit = json.loads(AUDIT.read_text(encoding="utf-8"))
    by_id = {claim["id"]: claim for claim in audit["claims"]}
    assert audit["gameVersion"] == "1.5.3"
    assert by_id["FP-DOMAIN"]["productDefault"]["evaluationMax"] == FMAX
    assert by_id["FP-COST"]["coreNonAffixBounds"] == {"Havoc": [1, 20], "Redemption": [1, 20], "Removal": [1, 25]}
    raw = {
        "lucky": by_id["FP-COST"]["luckyThresholdFloat32"],
        "hope": by_id["FP-HOPE-ICE"]["hopeThresholdFloat32"],
        "ice": by_id["FP-HOPE-ICE"]["iceThresholdFloat32"],
        "lowFpPreservation": by_id["FP-LOW-PRESERVE"]["thresholdFloat32"],
    }
    # Independent hand cases, including exact primitive means and edge branches.
    assert sum(cost * p for cost, p in raw_cost(20, DISPLAY, Fraction(57, 200))) == Fraction(3433, 400)
    assert sum(cost * p for cost, p in raw_cost(25, DISPLAY, Fraction(57, 200))) == Fraction(34319, 3200)
    assert dict(low_fp_exit(3, 3, Fraction(1, 20))) == {0: Fraction(361, 400), 1: Fraction(19, 400), 2: Fraction(1, 20)}
    assert dict(low_fp_exit(2, 2, Fraction(1, 20))) == {0: Fraction(19, 20), 1: Fraction(1, 20)}
    assert dict(low_fp_exit(1, 100, Fraction(1, 20))) == {0: Fraction(1)}
    assert dict(low_fp_exit(3, 2, Fraction(1, 20))) == {1: Fraction(19, 20), 2: Fraction(1, 20)}
    assert dict(low_fp_exit(3, 1, Fraction(1, 20))) == {2: Fraction(1)}
    profiles = []
    verified = 0
    for profile in PROFILES:
        q = {name: threshold(value, profile) for name, value in raw.items()}
        samples = []
        curves = []
        for fp_type, hope in SETTINGS:
            no_cost = 1 - (1 - (q["hope"] if hope else 0)) * (1 - (q["ice"] if fp_type == "ICE" else 0))
            for label, hi in (("HAVOC_REDEMPTION", 20), ("REMOVAL", 25)):
                exits = [cost_exit(before, hi, profile, no_cost, q["lucky"], q["lowFpPreservation"]) for before in range(FMAX + 1)]
                verified += len(exits)
                for before in (0, 1, 2, 3, 10, 63):
                    kernel = exits[before]
                    samples.append({
                        "operationFamily": label, "fpType": fp_type, "glyphOfHope": hope, "initialFp": before,
                        "applicable": before > 0,
                        "noCostBeforeLowFpProcessing": fraction_data(no_cost),
                        "expectedActualFpSpent": fraction_data(sum((before - after) * mass for after, mass in kernel)),
                        "outcomes": [{"remainingFp": after, "actualFpSpent": before - after, "probability": fraction_data(mass)} for after, mass in kernel],
                        "materialUses": {"rune": 1 if before else 0, "glyphOfHope": 1 if before and hope else 0},
                    })
                if label != "HAVOC_REDEMPTION":
                    continue
                old_exits = [cost_exit(before, hi, profile, no_cost, q["lucky"], Fraction(0)) for before in range(FMAX + 1)]
                for family, p, layouts in (("77tt", Fraction(1, 5), 6), ("77tu", Fraction(2, 11), 12)):
                    rows = reference_curve(p, exits)
                    old_rows = reference_curve(p, old_exits)
                    for row, old_row in zip(rows, old_rows):
                        row["withoutLowFpPreservation"] = old_row["successProbability"]
                        row["lowFpPreservationDifference"] = row["successProbability"] - old_row["successProbability"]
                    if profile == DISPLAY and family == "77tt" and fp_type == "NORMAL":
                        assert rows[1]["successProbability"] == (0.25 if hope else 0.2)
                    curves.append({
                        "tierFamily": family, "fpType": fp_type, "glyphOfHope": hope,
                        "perAttemptReferenceHitProbability": str(p), "layoutCount": layouts,
                        "ignoredUnchangedLayoutTailPerAttempt": f"{layouts}^-10000",
                        "tailInterpretation": "Conditional-changed-layout reference; finite native rejection-cap mass and shuffle integer bucket bias are not included. This is not a bit-exact native/client curve.",
                        "rows": rows,
                    })
        profiles.append({"id": profile, "thresholdProbabilitiesUnderAssumption": {name: fraction_data(value) for name, value in q.items()}, "sampleCostPmfs": samples, "fixedFamilyHavocReferenceCurves": curves})
    return {
        "schemaVersion": 1, "gameVersion": audit["gameVersion"], "steamBuildId": audit["steamBuildId"],
        "evidence": "forge-fp-claims.json: FP-DOMAIN, FP-COST, FP-HOPE-ICE, FP-LOW-PRESERVE",
        "scope": "Research-only noncritical rune cost kernels and fixed-family repeated-Havoc references. No item route search or full crafting engine is implemented.",
        "models": {
            DISPLAY: "Independent uniform integer draws and displayed 0.285/0.25/0.30/0.05 parameters; exact rational reference model.",
            GRID: "Independent uniformly distributed 32-bit native draw inputs and 23-bit Roll grid; primitive bucket counts are exact under this assumption. Actual PRNG state correlations are not modeled.",
        },
        "fpDomain": {"min": 0, "max": FMAX, "zeroMeansInapplicableRune": True},
        "validation": {"costKernelsWithExactUnitMass": verified, "massArithmetic": "fractions.Fraction", "independentHandChecks": 9, "actualClientTests": 0},
        "profiles": profiles,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Compare with the committed JSON without writing.")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    artifact = compute()
    if args.verify_only:
        saved = json.loads(args.output.read_text(encoding="utf-8"))
        if saved != artifact:
            raise SystemExit("FP example artifact is stale; regenerate explicitly and review its evidence changes.")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"verified": True, "wroteArtifact": not args.verify_only, "exactUnitMassCases": artifact["validation"]["costKernelsWithExactUnitMass"], "scope": "research_reference_only"}))


if __name__ == "__main__":
    main()
