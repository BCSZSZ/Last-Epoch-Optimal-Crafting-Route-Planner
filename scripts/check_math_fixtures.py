"""Independently check synthetic Phase 0 mathematics with exact fractions.

This is a reference checker for toy examples, not a Last Epoch rule engine.
It uses no game parameters, installed files, third-party packages or network.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURES = ROOT / "research" / "math-fixtures.json"


class FixtureCheckError(ValueError):
    """A fixture or a mathematical invariant failed verification."""


class Checks:
    def __init__(self) -> None:
        self.count = 0

    def require(self, condition: bool, message: str) -> None:
        self.count += 1
        if not condition:
            raise FixtureCheckError(message)

    def equal(self, actual: object, expected: object, label: str) -> None:
        self.require(actual == expected, f"{label}: computed {actual!s}, expected {expected!s}")


def rational(value: object) -> Fraction:
    if isinstance(value, bool):
        raise FixtureCheckError("Boolean supplied where a rational number was required")
    if not isinstance(value, (int, str)):
        raise FixtureCheckError(f"Exact fixture numbers must be integers or fraction strings: {value!r}")
    return Fraction(value)


def compare_expected(actual: dict, expected: dict, name: str, checks: Checks) -> None:
    checks.equal(set(actual), set(expected), f"{name}: expected-field coverage")
    for key, value in expected.items():
        wanted = value if isinstance(value, bool) or value == "Infinity" else rational(value)
        checks.equal(actual[key], wanted, f"{name}.{key}")


def validate_rows(rows: list[dict], checks: Checks, name: str) -> list[str]:
    """Validate a finite graph and return its transient-state order."""
    states = list(dict.fromkeys(row["from"] for row in rows))
    totals = defaultdict(Fraction)
    for row in rows:
        p = rational(row["p"])
        checks.require(0 <= p <= 1, f"{name}: invalid transition probability")
        totals[row["from"]] += p
    for state in states:
        checks.equal(totals[state], Fraction(1), f"{name}: outgoing mass at {state}")
    return states


def solve_linear(matrix: list[list[Fraction]], rhs: list[Fraction]) -> list[Fraction]:
    """Small exact Gauss-Jordan solver, deliberately independent of production code."""
    count = len(matrix)
    a = [list(row) + [rhs[index]] for index, row in enumerate(matrix)]
    for column in range(count):
        pivot = next((row for row in range(column, count) if a[row][column]), None)
        if pivot is None:
            raise FixtureCheckError("Singular absorbing system: inspect closed recurrent classes")
        a[column], a[pivot] = a[pivot], a[column]
        divisor = a[column][column]
        a[column] = [entry / divisor for entry in a[column]]
        for row in range(count):
            if row != column and a[row][column]:
                factor = a[row][column]
                a[row] = [left - factor * right for left, right in zip(a[row], a[column])]
    return [a[index][-1] for index in range(count)]


def graph_values(rows: list[dict], states: list[str], reward=None, success=None) -> dict[str, Fraction]:
    """Solve absorption, a reward mean, or a success-weighted reward moment.

    No reward means solve success probabilities. A reward callback computes
    an edge reward; providing success also weights that reward by the chance
    of eventual success from the edge destination.
    """
    positions = {state: index for index, state in enumerate(states)}
    size = len(states)
    matrix = [[Fraction(int(row == column)) for column in range(size)] for row in range(size)]
    rhs = [Fraction(0) for _ in states]
    for edge in rows:
        i = positions[edge["from"]]
        destination = edge["to"]
        p = rational(edge["p"])
        if destination in positions:
            matrix[i][positions[destination]] -= p
        if reward is None:
            if destination == "SUCCESS":
                rhs[i] += p
        else:
            continuation_success = (
                success[destination] if destination in positions else Fraction(destination == "SUCCESS")
            ) if success is not None else Fraction(1)
            rhs[i] += p * reward(edge) * continuation_success
    return dict(zip(states, solve_linear(matrix, rhs)))


def one_step(case: dict, checks: Checks) -> dict:
    name = case["id"]
    rows = [{**row, "from": "ENTRY", "to": row["terminal"]} for row in case["transitions"]]
    states = validate_rows(rows, checks, name)
    success = graph_values(rows, states)
    fp_reward = lambda edge: rational(edge["actualFPSpent"])
    spent = graph_values(rows, states, reward=fp_reward)["ENTRY"]
    successful_moment = graph_values(rows, states, reward=fp_reward, success=success)["ENTRY"]
    result = {
        "successProbability": success["ENTRY"],
        "actualFPSpentMean": spent,
        "successfulFPFirstMoment": successful_moment,
        "actualFPSpentGivenSuccessMean": successful_moment / success["ENTRY"],
        "failedFPWaste": spent - successful_moment,
        "attemptsMean": graph_values(rows, states, reward=lambda edge: rational(edge["attempts"]))["ENTRY"],
    }
    for edge in rows:
        checks.require(0 <= edge["actualFPSpent"] <= case["initialFP"], f"{name}: FP conservation")
        if "requestedCost" in edge:
            checks.equal(edge["actualFPSpent"], min(case["initialFP"], edge["requestedCost"]), f"{name}: last-charge truncation")
            checks.equal(case["initialFP"] - edge["actualFPSpent"], edge["finalFP"], f"{name}: terminal FP ledger")
        if "policyPassed" in edge:
            computed_terminal = "SUCCESS" if edge["policyPassed"] else "POLICY_ABORT"
            checks.equal(edge["to"], computed_terminal, f"{name}: declared one-shot policy")
            checks.equal(edge["laterActions"], 0, f"{name}: absorbing terminal has no later action")
    if "laterActionsMean" in case["expected"]:
        result["laterActionsMean"] = graph_values(rows, states, reward=lambda edge: rational(edge["laterActions"]))["ENTRY"]
    return result


def success_by_attempt(rows: list[dict], start: str, attempts: int) -> Fraction:
    """Exact forward propagation, independent of the linear reward solver."""
    outgoing = defaultdict(list)
    for edge in rows:
        outgoing[edge["from"]].append(edge)
    current = {start: Fraction(1)}
    succeeded = Fraction(0)
    for _ in range(attempts):
        following = defaultdict(Fraction)
        for state, mass in current.items():
            for edge in outgoing[state]:
                contribution = mass * rational(edge["p"])
                if edge["to"] == "SUCCESS":
                    succeeded += contribution
                elif edge["to"] in outgoing:
                    following[edge["to"]] += contribution
        current = dict(following)
    return succeeded


def state_changing_scc(case: dict, checks: Checks) -> dict:
    name = case["id"]
    rows = case["transitions"]
    states = validate_rows(rows, checks, name)
    for edge in rows:
        checks.equal(edge["attempts"], 1, f"{name}: one atomic action per transition")
    success = graph_values(rows, states)
    attempts = graph_values(rows, states, reward=lambda edge: rational(edge["attempts"]))
    spent = graph_values(rows, states, reward=lambda edge: rational(edge["actualFPSpent"]))
    start = case["initialState"]
    result = {
        "successProbability": success[start],
        "actualFPSpentMean": spent[start],
        "attemptsMeanFromA": attempts["A"],
        "attemptsMeanFromB": attempts["B"],
        "attemptCountCDFAt4FromA": success_by_attempt(rows, start, 4),
    }
    for percentile in (50, 90, 95):
        key = f"attemptsGivenSuccessP{percentile}FromA"
        candidate = case["expected"][key]
        probability = Fraction(percentile, 100)
        at_candidate = success_by_attempt(rows, start, candidate) / success[start]
        before_candidate = success_by_attempt(rows, start, candidate - 1) / success[start]
        checks.require(before_candidate < probability <= at_candidate, f"{name}: inverse-CDF bracket for {key}")
        result[key] = Fraction(candidate)
    return result


def reachable(rows: list[dict], start: str) -> set[str]:
    adjacency = defaultdict(set)
    for edge in rows:
        if rational(edge["p"]) > 0:
            adjacency[edge["from"]].add(edge["to"])
    seen = {start}
    frontier = [start]
    while frontier:
        for destination in adjacency[frontier.pop()]:
            if destination not in seen:
                seen.add(destination)
                frontier.append(destination)
    return seen


def closed_scc(case: dict, checks: Checks) -> dict:
    name = case["id"]
    rows = case["transitions"]
    states = validate_rows(rows, checks, name)
    visited = reachable(rows, case["initialState"])
    checks.equal(visited, set(states), f"{name}: all reachable states remain inside finite class")
    for state in states:
        checks.equal(reachable(rows, state), set(states), f"{name}: strong connectivity from {state}")
    checks.require(all(edge["actualFPSpent"] == 0 for edge in rows), f"{name}: zero FP reward on every recurrent edge")
    checks.require(all(edge["attempts"] > 0 for edge in rows), f"{name}: strictly positive attempt reward")
    checks.require(any(edge.get("consumed", {}).get("toy-material", 0) > 0 and rational(edge["p"]) > 0 for edge in rows), f"{name}: positive recurrent material reward")
    closed = all(edge["to"] in visited for edge in rows)
    checks.require(closed, f"{name}: class must be closed")
    return {
        "successProbability": Fraction("SUCCESS" in visited),
        "nonterminationProbability": Fraction(closed),
        "actualFPSpentMean": Fraction(0),
        "attemptsMean": "Infinity",
        "toyMaterialConsumedMean": "Infinity",
        "eligibleForPrimaryRecommendation": not closed,
    }


def quantile(masses: dict[Fraction, Fraction], p: Fraction) -> Fraction:
    accumulated = Fraction(0)
    for cost, mass in sorted(masses.items()):
        accumulated += mass
        if accumulated >= p:
            return cost
    raise FixtureCheckError("CDF does not reach the requested quantile")


def budget_mixture(case: dict, checks: Checks) -> dict:
    name = case["id"]
    score = moment = mean = naive = Fraction(0)
    all_masses = defaultdict(Fraction)
    success_masses = defaultdict(Fraction)
    checks.equal(sum(rational(row["weight"]) for row in case["budgets"]), Fraction(1), f"{name}: mixture weights")
    for row in case["budgets"]:
        weight = rational(row["weight"])
        success = rational(row["successProbability"])
        cost = rational(row["actualFPSpentOnAllOutcomes"])
        checks.require(weight >= 0 and 0 <= success <= 1, f"{name}: legal mixture inputs")
        score += weight * success
        mean += weight * cost
        moment += weight * success * cost
        naive += weight * cost
        all_masses[cost] += weight
        success_masses[cost] += weight * success
    checks.require(0 < score < 1, f"{name}: nondegenerate conditional sample")
    success_masses = {cost: mass / score for cost, mass in success_masses.items()}
    result = {
        "score": score,
        "actualFPSpentMean": mean,
        "successfulFPFirstMoment": moment,
        "actualFPSpentGivenSuccessMean": moment / score,
        "failedFPWaste": mean - moment,
        "actualFPSpentGivenFailureMean": (mean - moment) / (1 - score),
        "incorrectUnreweightedConditionalMean": naive,
    }
    checks.require(moment / score != naive, f"{name}: counterexample must distinguish conditional reweighting")
    for label, masses in (("allOutcomes", all_masses), ("givenSuccess", success_masses)):
        checks.equal(sum(masses.values()), Fraction(1), f"{name}: {label} CDF mass")
        for percentile in (50, 90, 95):
            result[f"{label}P{percentile}"] = quantile(masses, Fraction(percentile, 100))
    return result


def material_refunds(case: dict, checks: Checks) -> dict:
    name = case["id"]
    rows = case["transitions"]
    checks.equal(sum(rational(row["p"]) for row in rows), Fraction(1), f"{name}: outgoing mass")
    means = defaultdict(Fraction)
    for row in rows:
        p = rational(row["p"])
        debit = sum(rational(value) for value in row["debit"].values())
        refund = sum(rational(value) for value in row["refund"].values())
        consumed = Fraction(0)
        for material in set(row["debit"]) | set(row["refund"]) | set(row["consumed"]):
            debit_units = rational(row["debit"].get(material, 0))
            refund_units = rational(row["refund"].get(material, 0))
            computed = debit_units - refund_units
            checks.require(debit_units >= 0 and 0 <= refund_units <= debit_units, f"{name}: valid input refund")
            checks.equal(computed, rational(row["consumed"].get(material, 0)), f"{name}: actual consumed ledger")
            consumed += computed
        means["attemptsMean"] += p * rational(row["attempts"])
        means["debitCountMean"] += p * debit
        means["refundCountMean"] += p * refund
        means["consumedCountMean"] += p * consumed
        means["recoveredToyShardMean"] += p * rational(row["recovered"]["toy-shard"])
    return {**means, "equalWeightMaterialCost": means["consumedCountMean"]}


def dominance_counterexample(case: dict, checks: Checks) -> dict:
    name = case["id"]
    final = {}
    before = {}
    for prefix in case["prefixes"]:
        prefix_name = prefix["name"]
        before[prefix_name] = rational(prefix["alreadySuccess"])
        remaining = sum(rational(row["p"]) for row in prefix["remaining"])
        checks.equal(before[prefix_name] + remaining, Fraction(1), f"{name}: prefix {prefix_name} mass")
        future = sum(
            rational(row["p"]) * rational(case["sharedSuffix"][f"successGiven{row['state'].capitalize()}"])
            for row in prefix["remaining"]
        )
        final[prefix_name] = before[prefix_name] + future
    checks.require(before["A"] > before["B"] and final["A"] < final["B"], f"{name}: common-suffix counterexample")
    return {
        "finalSuccessA": final["A"],
        "finalSuccessB": final["B"],
        "prefixAIsSafeDominating": final["A"] >= final["B"],
    }


HANDLERS = {
    "last-budget-action-success": one_step,
    "policy-abort-no-recovery": one_step,
    "zero-cost-state-changing-scc": state_changing_scc,
    "nonterminating-closed-scc": closed_scc,
    "success-conditioned-budget-mixture": budget_mixture,
    "refund-versus-extra-output": material_refunds,
    "prefix-success-is-not-safe-dominance": dominance_counterexample,
}


def check_fixtures(path: Path | str = DEFAULT_FIXTURES) -> dict:
    """Raise FixtureCheckError on failure; return a compact serializable summary."""
    source = Path(path)
    raw = source.read_bytes()
    document = json.loads(raw.decode("utf-8-sig"))
    checks = Checks()
    checks.equal(document["schemaVersion"], 1, "fixture schema")
    checks.require(document["notGameMechanics"] is True, "Synthetic values must never be labelled game mechanics")
    checks.equal(document["kind"], "SYNTHETIC_MATHEMATICAL_FIXTURES", "fixture kind")
    cases = document["cases"]
    case_ids = [case["id"] for case in cases]
    checks.equal(len(case_ids), len(set(case_ids)), "unique fixture IDs")
    checks.equal(set(case_ids), set(HANDLERS), "required mathematical case coverage")
    for case in cases:
        computed = HANDLERS[case["id"]](case, checks)
        compare_expected(computed, case["expected"], case["id"], checks)
    return {
        "status": "passed",
        "syntheticCases": len(cases),
        "rationalChecks": checks.count,
        "fixtureSHA256": hashlib.sha256(raw).hexdigest(),
        "notGameMechanics": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    arguments = parser.parse_args()
    try:
        summary = check_fixtures(arguments.fixtures)
    except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
