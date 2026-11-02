"""Recompute small action examples from the versioned snapshot, without a game install.

These are reference calculations under independent normalized-weight draws and
uniform tier permutations. They are NOT a bit-for-bit native PRNG/grid model,
a complete atomic crafting engine, or a production route optimizer.

The independent direct-draw Monte Carlo check uses a fixed seed and a declared
4-sigma binomial tolerance plus one hit for integer rounding. The tolerance is
fixed before sampling; it must not be adjusted to make a failed run pass.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from fractions import Fraction
import hashlib
from itertools import permutations
import json
import math
from pathlib import Path
import random
import struct
import sys


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "data/game/1.5.3"
CLAIMS = ROOT / "research/affix-action-claims.json"
MONTE_CARLO_SEED = 20261103
MONTE_CARLO_SIGMA_LIMIT = 4.0
MINIMUM_SAMPLES = 100_000
DEFAULT_SAMPLES = 200_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def class_matches(requirement: int, specificity: int) -> bool:
    """Native MatchesSpecificity for valid class flags; enum bits differ by one."""
    return (
        requirement == 31
        or specificity == 0
        or (requirement == 0 and specificity & 1 != 0)
        or ((requirement << 1) & specificity) != 0
    )


def craft_weight(definition: dict, equipment_type: int) -> Fraction:
    weight = definition["weighting"]
    for override in definition["specificRerollChances"]:
        if override["equipmentType"] == equipment_type:
            weight = override["weighting"]
            break
    if weight < 1:
        weight = min(1.0, float32(2 * weight))
    return Fraction(weight)


def load_reference_pool() -> tuple[dict[int, dict], dict, dict]:
    manifest = read_json(SNAPSHOT / "manifest.json")
    for name in ("affixes.json", "items.json"):
        actual = hashlib.sha256((SNAPSHOT / name).read_bytes()).hexdigest()
        require(actual == manifest["artifacts"][name]["sha256"], f"Snapshot hash mismatch: {name}")
    claims = read_json(CLAIMS)
    require(claims["gameVersion"] == manifest["gameVersion"], "Claim/snapshot game version mismatch")
    require(claims["steamBuildId"] == manifest["steamBuildId"], "Claim/snapshot Steam build mismatch")
    items = read_json(SNAPSHOT / "items.json")
    base = next(row for row in items["bases"] if row["id"] == "4:0")
    item_type = next(row for row in items["itemTypes"] if row["id"] == 4)
    require(base["definition"]["classRequirement"] == 0, "Gloves example base must be class-neutral")
    require(item_type["definition"]["type"] == 4, "Gloves base/equipment mapping changed")
    require(item_type["definition"]["maximumAffixes"] == 4, "Gloves capacity changed")
    rows = read_json(SNAPSHOT / "affixes.json")["affixes"]
    require(len({row["id"] for row in rows}) == len(rows), "Affix IDs must remain unique")
    pool = {}
    for row in rows:
        definition = row["definition"]
        if (
            definition["specialAffixType"] == 0
            and definition["type"] in (0, 1)
            and 4 in definition["canRollOn"]
            and class_matches(0, definition["classSpecificity"])
        ):
            pool[row["id"]] = {
                "id": row["id"],
                "name": definition["affixName"],
                "side": definition["type"],
                "weight": craft_weight(definition, 4),
            }
    require(len(pool) == 40, f"Gloves reference pool changed: {len(pool)} != 40")
    frozen = claims["referenceExamples"]
    require(frozen["baseId"] == "4:0" and frozen["classRequirement"] == 0, "Reference base contract differs")
    expected_pool = {row["id"]: row for row in frozen["pool"]}
    require(set(pool) == set(expected_pool), "Rebuilt pool IDs differ from audited reference pool")
    for identity, entry in pool.items():
        expected = expected_pool[identity]
        require(entry["side"] == expected["side"], f"Affix side changed: {identity}")
        require(entry["name"] == expected["name"], f"Affix display source changed: {identity}")
        require(str(entry["weight"]) == expected["weightExact"], f"Craft weight changed: {identity}")
    return pool, claims, manifest


def exact_identity_kernel(state: tuple[int, ...], index: int, pool: dict[int, dict]) -> dict:
    side = pool[state[index]]["side"]
    candidates = [entry for entry in pool.values() if entry["side"] == side and entry["id"] not in state]
    total = sum((entry["weight"] for entry in candidates), Fraction())
    require(total > 0, "Reference case unexpectedly has no positive candidate weight")
    output = {}
    for entry in candidates:
        successor = state[:index] + (entry["id"],) + state[index + 1:]
        output[successor] = entry["weight"] / total
    require(sum(output.values()) == 1, "Atomic reference probability mass differs from one")
    return output


def exact_redemption(state: tuple[int, ...], pool: dict[int, dict]) -> dict:
    """Only slots0,1 are exalted in these declared fixtures; suffixes stay fixed."""
    distribution = {state: Fraction(1)}
    for index in (0, 1):
        successor_mass = defaultdict(Fraction)
        for intermediate, mass in distribution.items():
            for successor, probability in exact_identity_kernel(intermediate, index, pool).items():
                require(len(set(successor)) == 4, "Sequential reroll introduced a duplicate ID")
                require(successor[2:] == state[2:], "Reference reroll modified fixed suffixes")
                successor_mass[successor] += mass * probability
        distribution = dict(successor_mass)
        require(sum(distribution.values()) == 1, "Sequential reference mass differs from one")
        require(all(probability >= 0 for probability in distribution.values()), "Negative mass")
    return distribution


def sample_redemption_direct(start: tuple[int, ...], pool: dict[int, dict], rng: random.Random) -> bool:
    """Independent sampling path: does not call or sample the exact kernel."""
    state = list(start)
    for index in (0, 1):
        side = pool[state[index]]["side"]
        forbidden = set(state)
        eligible = [entry for entry in pool.values() if entry["side"] == side and entry["id"] not in forbidden]
        total = sum(float(entry["weight"]) for entry in eligible)
        position = rng.random() * total
        chosen = eligible[-1]["id"]
        for entry in eligible:
            position -= float(entry["weight"])
            if position < 0:
                chosen = entry["id"]
                break
        state[index] = chosen
    return set(state[:2]) == {4, 5}


def check_redemption(pool: dict[int, dict], claims: dict, samples: int) -> list[dict]:
    results = []
    labels = ("noTarget", "targetFirst", "targetLast")
    examples = claims["referenceExamples"]["redemption"]
    require(tuple(example["label"] for example in examples) == labels, "Unexpected fixture ordering")
    for case_index, example in enumerate(examples):
        require(example["storedTiers"] == [6, 6, 0, 0], "Expected exactly first two T7 affixes")
        require(example["targetExaltedIds"] == [4, 5], "Reference target changed")
        start = tuple(example["startingAffixIds"])
        distribution = exact_redemption(start, pool)
        successful_mass = sum((mass for state, mass in distribution.items() if set(state[:2]) == {4, 5}), Fraction())
        require(str(successful_mass) == example["fraction"], f"Exact probability mismatch: {example['label']}")
        require(len(distribution) == example["exitStates"], f"Exit state count mismatch: {example['label']}")
        require(float(successful_mass) == example["probability"], "Frozen float projection differs")
        rng = random.Random(MONTE_CARLO_SEED + case_index)
        hits = sum(sample_redemption_direct(start, pool, rng) for _ in range(samples))
        probability = float(successful_mass)
        expected_hits = samples * probability
        standard_deviation = math.sqrt(samples * probability * (1 - probability))
        tolerance_hits = MONTE_CARLO_SIGMA_LIMIT * standard_deviation + 1
        if probability == 0:
            require(hits == 0, "Mathematically impossible target produced simulated success")
        else:
            require(abs(hits - expected_hits) <= tolerance_hits, f"Monte Carlo exceeded preregistered4-sigma tolerance: {example['label']}")
        results.append({
            "case": example["label"], "exactFraction": str(successful_mass),
            "exitStates": len(distribution), "mass": "1", "monteCarloHits": hits,
            "samples": samples, "withinDeclaredTolerance": True,
        })
    return results


def check_havoc() -> list[dict]:
    rows = []
    for start, expected_arrangements, expected_rate in (
        ((7, 1, 7, 1), 6, Fraction(1, 5)),
        ((7, 1, 7, 2), 12, Fraction(2, 11)),
    ):
        arrangements = set(permutations(start))
        require(len(arrangements) == expected_arrangements, "Duplicate-tier permutation count mismatch")
        changed = arrangements - {start}
        successful = {out for out in changed if out[0] == 7 and out[1] == 7}
        success_rate = Fraction(len(successful), len(changed))
        require(success_rate == expected_rate, "Conditional changed-permutation success rate mismatch")
        # Represent a mass as a+b*epsilon, epsilon=A^-10000. This retains the
        # finite rejection cap exactly without underflow or giant integers.
        conditional = Fraction(1, len(changed))
        mass_constant = len(changed) * conditional
        mass_tail_coefficient = Fraction(1) - len(changed) * conditional
        require(mass_constant == 1 and mass_tail_coefficient == 0, "Symbolic finite-cap mass is not one")
        rows.append({
            "tiers": list(start), "distinctArrangements": len(arrangements),
            "successGivenChanged": str(success_rate),
            "sameArrangementTail": f"{len(arrangements)}^-10000",
            "successWithFiniteCap": f"({success_rate}) * (1 - {len(arrangements)}^-10000)",
            "symbolicMass": "1",
        })
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES, help="Independent draws per Redemption fixture; minimum100000.")
    args = parser.parse_args()
    require(args.samples >= MINIMUM_SAMPLES, "Monte Carlo check requires at least100000 samples per fixture")
    pool, claims, manifest = load_reference_pool()
    redemption = check_redemption(pool, claims, args.samples)
    havoc = check_havoc()
    print(json.dumps({
        "status": "PASS", "gameVersion": manifest["gameVersion"],
        "dataRevision": manifest["dataRevision"], "glovesPoolCount": len(pool),
        "model": "INDEPENDENT_NORMALIZED_WEIGHTS_AND_UNIFORM_PERMUTATIONS",
        "nativeGridBitExact": False,
        "monteCarlo": {"seed": MONTE_CARLO_SEED, "sigmaLimit": MONTE_CARLO_SIGMA_LIMIT, "integerRoundingAllowanceHits": 1},
        "redemption": redemption, "havoc": havoc,
    }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, ValueError, StopIteration) as exc:
        print(f"Action reference verification failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
