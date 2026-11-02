"""Independent direct sampling of the two audited 7710 preparation routes.

This script does not import the reference evaluator or sample from its transition
kernels. It independently executes the audited operation order with Python's RNG.
Only the DISPLAY iid reference model is tested; it is not a client PRNG emulator.
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


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = ROOT / "research/7710-route-cases.json"
DEFAULT_RESULTS = ROOT / "research/7710-route-results.json"
MAIN_ROUTES = {"direct_fill_seal_add_havoc", "prepare_havoc_fill_seal_add_havoc"}
FP_POINTS = (10, 30, 63)
FP_TYPES = ("NORMAL", "ICE", "BLOOD")
MODEL_ID = "display_parameters_iid"
DEFAULT_SEED = 771020261103


class DirectForge:
    """Sample native action order directly, with rolls marginalized out."""

    __slots__ = ("affixes", "fp", "fp_type", "rng", "a", "b", "sides", "glyphs", "actions")

    def __init__(self, case: dict, fp: int, fp_type: str, rng: random.Random, sides: dict[int, int], glyphs: dict):
        self.affixes = [[int(a["id"]), int(a["tier"]), bool(a.get("sealed", False))] for a in case["initialAffixes"]]
        self.fp = fp
        self.fp_type = fp_type
        self.rng = rng
        self.a = int(case["targetAId"])
        self.b = int(case["targetBId"])
        self.sides = sides
        self.glyphs = glyphs
        self.actions = 0

    def roll(self, threshold: float) -> bool:
        if threshold <= 0:
            return False
        if threshold >= 1:
            return True
        return self.rng.random() < threshold

    def no_fp_cost(self, step: str) -> bool:
        # Hope first; Ice is checked only if the first check did not exempt FP.
        if self.glyphs[step] == "HOPE" and self.roll(0.25):
            return True
        return self.fp_type == "ICE" and self.roll(0.30)

    def charge(self, upper_exclusive: int, no_cost: bool) -> None:
        if no_cost:
            return
        cost = self.rng.randrange(1, upper_exclusive)
        if self.roll(0.285):
            cost = self.rng.randrange(1, cost) if cost > 1 else 1
        self.fp = max(0, self.fp - cost)

    def finish_cost(self, before: int, critical: bool) -> None:
        if critical:
            # Forge refunds even if AddExtraAffixTier had no legal improvement.
            self.fp = before
            return
        if self.fp >= before:
            return
        if self.fp < 2 and before > 2 and self.roll(0.05):
            self.fp = 2
            return
        if self.fp == 0 and before > 1 and self.roll(0.05):
            self.fp = 1

    def extra_tier(self, primary_id: int) -> None:
        candidates = []
        primary_separated = False
        primary_index = None
        for index, (affix_id, tier, sealed) in enumerate(self.affixes):
            if sealed or tier >= 5:
                continue
            if affix_id == primary_id:
                primary_index = index
                if self.roll(0.5):
                    primary_separated = True
                    continue
            candidates.append(index)
        if primary_separated and (self.roll(0.5) or not candidates):
            selected = primary_index
        elif candidates:
            selected = self.rng.choice(candidates)
        else:
            selected = None
        if selected is not None:
            # Scope is role100, base4:0, the six audited affix IDs. Their
            # requirements after this extra tier are within the native cap90.
            self.affixes[selected][1] += 1

    def shard_critical(self, primary_id: int) -> bool:
        # Physical stock is unlimited in this fixture. There is no Chaos step.
        critical = self.roll(0.12)
        if not critical and self.fp_type == "BLOOD":
            critical = self.roll(0.30)
        if critical:
            self.extra_tier(primary_id)
        return critical

    def goal(self) -> bool:
        return all(any(aid == target and tier == 7 and not sealed for aid, tier, sealed in self.affixes) for target in (self.a, self.b))

    def junk(self, only_t1: bool = False) -> list[int]:
        candidates = [
            i for i, (aid, tier, sealed) in enumerate(self.affixes)
            if not sealed and aid not in (self.a, self.b)
            and self.sides[aid] == self.sides[self.b]
            and (tier == 1 if only_t1 else 1 <= tier <= 4)
        ]
        return sorted(candidates, key=lambda i: (self.affixes[i][1], i))

    def add(self, target: int, step: str) -> str | None:
        if any(a[0] == target for a in self.affixes):
            return "DUPLICATE_ID"
        ordinary = [a for a in self.affixes if not a[2]]
        if len(ordinary) >= 4 or sum(self.sides[a[0]] == self.sides[target] for a in ordinary) >= 2:
            return "NO_LEGAL_SLOT"
        if len(ordinary) != 3:
            raise ValueError("The two main routes must add into a three-affix rare item.")
        if self.fp == 0:
            return "FP_EXHAUSTED"
        before = self.fp
        no_cost = self.no_fp_cost(step)
        # New affix: charge tier0 while the item is still rarity3, then append.
        self.charge(18, no_cost)
        self.affixes.append([target, 1, False])
        critical = self.shard_critical(target)
        self.finish_cost(before, critical)
        self.actions += 1
        return None

    def seal(self) -> str | None:
        candidates = self.junk()
        if not candidates:
            return "NO_LEGAL_SEAL_TARGET"
        if any(a[2] for a in self.affixes):
            return "SEALED_SLOT_OCCUPIED"
        if self.fp == 0:
            return "FP_EXHAUSTED"
        before = self.fp
        no_cost = self.no_fp_cost("SEAL_CURRENT_JUNK")
        index = candidates[0]
        primary_id, old_tier, _ = self.affixes[index]
        count = sum(not a[2] for a in self.affixes)
        exalted = any(a[1] >= 6 and not a[2] for a in self.affixes)
        seal_chance = min(1.0, (0.6 + 0.15 * count + 0.3 * int(exalted)) * {1: 0.7, 2: 0.46, 3: 0.23, 4: 0.1}[old_tier])
        sealed = self.roll(seal_chance)
        # Both branches charge oldStoredTier+1: identical base fee parameter.
        if sealed:
            self.affixes[index][2] = True
        else:
            self.affixes[index][1] += 1
        self.charge({1: 10, 2: 12, 3: 18, 4: 24}[old_tier], no_cost)
        critical = False if sealed else self.shard_critical(primary_id)
        self.finish_cost(before, critical)
        self.actions += 1
        # Product failure is applied only after complete native postprocessing.
        return None if sealed else "REQUIRED_SEAL_FAILED"

    def havoc_once(self, step: str) -> str | None:
        indices = [i for i, a in enumerate(self.affixes) if not a[2]]
        if len(indices) != 4 or not any(self.affixes[i][1] >= 6 for i in indices):
            return "HAVOC_INAPPLICABLE"
        original = [self.affixes[i][1] for i in indices]
        if len(set(original)) == 1:
            return "NO_CHANGED_TIER_LAYOUT"
        if self.fp == 0:
            return "FP_EXHAUSTED"
        before = self.fp
        no_cost = self.no_fp_cost(step)
        # Current CraftRuneOfHavoc charges before shuffling, even on the last FP.
        self.charge(20, no_cost)
        shuffled = original.copy()
        while shuffled == original:
            self.rng.shuffle(shuffled)
        for i, tier in zip(indices, shuffled):
            self.affixes[i][1] = tier
        self.finish_cost(before, False)
        self.actions += 1
        return None

    def execute(self, steps: list[str]) -> tuple[bool, str]:
        for step in steps:
            if self.goal():
                return True, "SUCCESS"
            if step == "ADD_A":
                failure = self.add(self.a, step)
            elif step == "ADD_B":
                failure = self.add(self.b, step)
            elif step == "SEAL_CURRENT_JUNK":
                failure = self.seal()
            elif step in ("PREPARE_HAVOC", "FINAL_HAVOC"):
                predicate = (lambda: bool(self.junk(only_t1=True))) if step == "PREPARE_HAVOC" else self.goal
                failure = None
                while not predicate():
                    failure = self.havoc_once(step)
                    if failure:
                        break
                    if self.actions > 100000:
                        raise RuntimeError("Unexpected long trajectory; do not turn this guard into failure probability.")
            else:
                raise ValueError(f"Unsupported fixture macro {step}")
            if failure:
                return False, failure
        return (True, "SUCCESS") if self.goal() else (False, "TARGET_NOT_REACHED")


def derive_seed(seed: int, case_id: str, route_id: str, fp_type: str, fp: int) -> int:
    value = f"{seed}|{case_id}|{route_id}|{fp_type}|{fp}".encode()
    return int.from_bytes(hashlib.sha256(value).digest()[:8], "big")


def probability_interval(point: dict) -> tuple[float, float]:
    value = point["successProbability"]
    if isinstance(value, (float, int)):
        return float(value), float(value)
    return float(value["lower"]), float(value["upper"])


def evaluate(samples: int, seed: int, cases_path: Path, results_path: Path | None) -> dict:
    fixture_bytes = cases_path.read_bytes()
    fixture = json.loads(fixture_bytes)
    assert fixture["materials"] == {"availability": "UNLIMITED", "costInObjective": False}
    assert fixture["supportGlyphs"] == {"ADD_A": "HOPE", "ADD_B": "HOPE", "PREPARE_HAVOC": "HOPE", "FINAL_HAVOC": "HOPE", "SEAL_CURRENT_JUNK": "DESPAIR"}
    catalog = json.loads((ROOT / "data/game/1.5.3/affixes.json").read_text(encoding="utf-8"))
    sides = {int(row["id"]): int(row["definition"]["type"]) for row in catalog["affixes"]}
    expected = {}
    reference_digest = None
    if results_path is not None:
        reference_bytes = results_path.read_bytes()
        reference_digest = hashlib.sha256(reference_bytes).hexdigest()
        dp = json.loads(reference_bytes)
        if dp["caseFileSha256"] != hashlib.sha256(fixture_bytes).hexdigest():
            raise ValueError("The DP reference was generated from a different 7710 fixture.")
        if not dp["materialsUnlimited"] or dp["materialCostInObjective"]:
            raise ValueError("The DP reference has a different material policy.")
        profile = next(p for p in dp["profiles"] if p["id"] == MODEL_ID)
        for scenario in profile["scenarios"]:
            for point in scenario["points"]:
                expected[(scenario["caseId"], scenario["routeId"], scenario["fpType"], point["initialFp"])] = point
    rows = []
    for case in fixture["cases"]:
        if case["baseId"] != "4:0" or case["playerLevel"] != 100:
            raise ValueError("This audit supports only role100 gloves4:0, not a generic crafting engine.")
        if any(a["id"] not in {2, 4, 5, 7, 10, 26} for a in case["initialAffixes"]):
            raise ValueError("Unaudited affix IDs in 7710 fixture.")
        for route in case["routes"]:
            if route["id"] not in MAIN_ROUTES:
                continue
            for fp_type in FP_TYPES:
                for fp in FP_POINTS:
                    rng_seed = derive_seed(seed, case["id"], route["id"], fp_type, fp)
                    rng = random.Random(rng_seed)
                    hits = spent = spent_squared = actions = 0
                    reasons = Counter()
                    for _ in range(samples):
                        item = DirectForge(case, fp, fp_type, rng, sides, fixture["supportGlyphs"])
                        succeeded, reason = item.execute(route["steps"])
                        hits += succeeded
                        consumption = fp - item.fp
                        assert 0 <= consumption <= fp
                        spent += consumption
                        spent_squared += consumption * consumption
                        actions += item.actions
                        reasons[reason] += 1
                    observed = hits / samples
                    variance = max(0.0, spent_squared / samples - (spent / samples) ** 2)
                    row = {
                        "caseId": case["id"], "routeId": route["id"], "fpType": fp_type,
                        "initialFp": fp, "samples": samples, "seed": rng_seed,
                        "successes": hits, "observedSuccessProbability": observed,
                        "meanActualFpSpent": spent / samples,
                        "fpSpentMeanStandardError": math.sqrt(variance / samples),
                        "meanAtomicActions": actions / samples, "terminalReasons": dict(sorted(reasons.items())),
                    }
                    if results_path is not None:
                        key = (case["id"], route["id"], fp_type, fp)
                        point = expected[key]
                        lower, upper = probability_interval(point)
                        assert 0 <= lower <= upper <= 1
                        center = (lower + upper) / 2
                        allowance = 5 * math.sqrt(center * (1 - center) / samples) + 1 / samples
                        distance = max(lower - observed, observed - upper, 0.0)
                        row.update({"dpSuccessLower": lower, "dpSuccessUpper": upper, "preRegisteredAllowance": allowance, "absoluteDistanceOutsideDpInterval": distance, "passed": distance <= allowance})
                        if "expectedActualFpSpent" in point:
                            row["dpExpectedActualFpSpent"] = point["expectedActualFpSpent"]
                    rows.append(row)
    if len(rows) != 18:
        raise ValueError(f"Expected 18 preregistered cases, got {len(rows)}.")
    return {
        "schemaVersion": 1, "model": MODEL_ID, "fixtureSha256": hashlib.sha256(fixture_bytes).hexdigest(),
        "referenceResultsSha256": reference_digest,
        "method": "Independent direct-operation Monte Carlo; no evaluator import, no sampling from evaluator kernels.",
        "assumptions": [
            "Python independent pseudo-random draws with nominal display parameters0.25/0.30/0.12/0.285/0.05, not native PRNG state emulation.",
            "Havoc draws uniformly until tier sequence changes; native finite10000 rejection cap and integer-bucket bias are excluded consistently with DISPLAY reference.",
            "Item roll values are marginalized because targets have no roll constraint. Role100/base4:0/six audited affix IDs make extra-upgrade level checks pass.",
            "All materials are physically unlimited and have no objective cost.",
        ],
        "acceptance": "Each success frequency must lie within the DP interval plus5*sqrt(p_mid*(1-p_mid)/N)+1/N, fixed before simulation. Consumption means are reported without pass/fail assertion.",
        "samplesPerPoint": samples, "pointCount": len(rows), "totalSamples": samples * len(rows), "baseSeed": seed,
        "comparedWithDp": results_path is not None,
        "passed": all(row.get("passed", True) for row in rows) if results_path is not None else None,
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=20000)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--simulate-only", action="store_true", help="Diagnostic sampling without claiming comparison passed.")
    parser.add_argument("--output", type=Path, help="Optional explicit JSON report path; otherwise emit the full report to stdout.")
    parser.add_argument("--summary", action="store_true", help="Emit one JSON summary line instead of the full report.")
    parser.add_argument("--no-timing", action="store_true", help="Exclude nondeterministic elapsed time from the report artifact.")
    args = parser.parse_args()
    if args.samples <= 0:
        parser.error("--samples must be positive")
    started = time.perf_counter()
    report = evaluate(args.samples, args.seed, args.cases, None if args.simulate_only else args.results)
    elapsed = round(time.perf_counter() - started, 3)
    if not args.no_timing:
        report["elapsedSeconds"] = elapsed
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    if args.summary or args.output:
        summary = {key: report[key] for key in ("comparedWithDp", "passed", "samplesPerPoint", "pointCount", "totalSamples", "baseSeed")}
        summary["elapsedSeconds"] = elapsed
        print(json.dumps(summary))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    if report["passed"] is False:
        raise SystemExit("Independent7710 Monte Carlo disagrees with the DP intervals.")


if __name__ == "__main__":
    main()
