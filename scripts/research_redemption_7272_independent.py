"""Independent nominal-probability calculation for the fixed 7272 Redemption controller.

No production TypeScript imports. Actual resource pools, a weight-class identity
chain, and scalar finite-FP tail recurrences; not a native client experiment.
"""
from __future__ import annotations

from collections import defaultdict
from fractions import Fraction
import argparse
import json
import math

from research_redemption_intrinsic import ROOT, pools, make_chain, analyze, solve, fee_mean
from research_fp_generation_20261103 import initial_pmf

SEAL = 0.69
CRITICAL = 0.12


def nominal_cost(upper: int):
    result = defaultdict(Fraction)
    lucky = Fraction(285, 1000)
    for value in range(1, upper):
        result[value] += (1 - lucky) / (upper - 1)
        if value == 1:
            result[1] += lucky / (upper - 1)
        else:
            for lower in range(1, value):
                result[lower] += lucky / ((upper - 1) * (value - 1))
    assert sum(result.values()) == 1
    return result


def cost_kernel(fp: int, upper: int, hope: bool):
    """Remaining FP; includes native last-charge preservation, standard potential."""
    output = defaultdict(Fraction)
    free = Fraction(1, 4) if hope else Fraction(0)
    output[fp] += free
    preserve = Fraction(1, 20)
    for charge, weight in nominal_cost(upper).items():
        paid = max(0, fp - charge)
        weight *= 1 - free
        if paid < 2 and fp > 2:
            output[2] += weight * preserve
            if paid == 0:
                output[1] += weight * (1 - preserve) * preserve
                output[0] += weight * (1 - preserve) ** 2
            else:
                output[paid] += weight * (1 - preserve)
        elif paid == 0 and fp > 1:
            output[1] += weight * preserve
            output[0] += weight * (1 - preserve)
        else:
            output[paid] += weight
    assert sum(output.values()) == 1
    return {remaining: float(p) for remaining, p in output.items() if p}


def tail_tables(maximum=63):
    kernels = {(fp, upper, hope): cost_kernel(fp, upper, hope)
               for fp in range(1, maximum + 1) for upper, hope in [(20, True), (12, False), (18, True)]}
    def havoc(hit):
        values = [0.0] * (maximum + 1)
        for fp in range(1, maximum + 1):
            kernel = kernels[fp, 20, True]
            numerator = hit + (1 - hit) * math.fsum(p * values[remaining]
                                                  for remaining, p in kernel.items() if remaining < fp)
            values[fp] = numerator / (1 - (1 - hit) * kernel.get(fp, 0))
        return values
    distinct, repeated = havoc(2 / 11), havoc(1 / 5)
    add = [0.0] * (maximum + 1)
    tail = [0.0] * (maximum + 1)
    for fp in range(1, maximum + 1):
        # Critical refunds FP; with two eligible low tiers, either gets the extra tier with probability1/2.
        add[fp] = (1 - CRITICAL) * math.fsum(p * distinct[remaining]
                                          for remaining, p in kernels[fp, 18, True].items())
        add[fp] += CRITICAL * (distinct[fp] + repeated[fp]) / 2
        tail[fp] = SEAL * math.fsum(p * add[remaining] for remaining, p in kernels[fp, 12, False].items())
    return tail, kernels


def finite_redemption(chain, initial, tail, kernels, maximum=63):
    groups, states, transition = chain['groups'], chain['states'], chain['transition']
    def count(state):
        return sum(groups[g]['targetId'] is not None for g in state)
    transient = [i for i, state in enumerate(states) if count(state) == 0]
    q = [[transition[i].get(j, 0.0) for j in transient] for i in transient]
    both = [math.fsum(p for j, p in transition[i].items() if count(states[j]) == 2) for i in transient]
    one = [math.fsum(p for j, p in transition[i].items() if count(states[j]) == 1) for i in transient]
    values = [[0.0] * len(transient)]
    start = transient.index(chain['stateIndex'][tuple(chain['lookup'][identity] for identity in initial)])
    for fp in range(1, maximum + 1):
        kernel = kernels[fp, 20, True]
        free = kernel.get(fp, 0)
        matrix = [[int(i == j) - free * q[i][j] for j in range(len(transient))] for i in range(len(transient))]
        rhs = []
        for i in range(len(transient)):
            value = both[i] + one[i] * math.fsum(p * tail[remaining] for remaining, p in kernel.items())
            value += math.fsum(p * math.fsum(q[i][j] * values[remaining][j] for j in range(len(transient)))
                               for remaining, p in kernel.items() if remaining < fp)
            rhs.append([value])
        values.append([row[0] for row in solve(matrix, rhs)])
    return [row[start] for row in values]


def run(verify_only=False):
    production = json.loads((ROOT / 'research/redemption-7272-audit.json').read_text(encoding='utf-8'))
    tail, kernels = tail_tables()
    fees = fee_mean()
    seal_cost = fee_mean(12)['baseAfterLucky']
    add_cost = fee_mean(18)['normalAndBlood'] * (1 - CRITICAL)
    havoc_attempts = (1 - CRITICAL / 2) * Fraction(11, 2) + CRITICAL / 2 * 5
    havoc_cost = float(havoc_attempts) * fees['normalAndBlood']
    post_mean = seal_cost + add_cost + havoc_cost
    cases = []
    for case in production['cases']:
        equipment_type = int(case['baseId'].split(':')[0])
        requirement = 31 if case['inputModel'].startswith('FORGEABLE_') else 0
        entries = [entry for side in pools(equipment_type, requirement) for entry in side if entry['id'] not in (5, 8)]
        if case['inputModel'] == 'FORGEABLE_EQUAL':
            entries = [{**entry, 'weight': 1.0} for entry in entries]
        chain = make_chain(entries, tuple(case['targetIds']), (0, 1))
        hit = analyze(chain, (4, 7), 'AT_LEAST_ONE')
        exits = hit['terminalOrderedWeightGroupDistribution']
        both = math.fsum(row['probability'] for row in exits if len(row['targetIds']) == 2)
        only = 1 - both
        success = both + SEAL * only
        casts_both = math.fsum(row['castCountFirstMoment'] for row in exits if len(row['targetIds']) == 2)
        casts_one = hit['expectedCasts'] - casts_both
        red_cost_given_success = fees['normalAndBlood'] * (casts_both + SEAL * casts_one) / success
        post_given_success = SEAL * only * post_mean / success
        mean = red_cost_given_success + post_given_success
        if abs(success - sum(case['score'].values()) / 2) > 1e-8:
            raise ValueError('Independent success probability differs from production')
        if case['expectedFpGivenSuccess'] and abs(mean - sum(case['expectedFpGivenSuccess'].values()) / 2) > 1e-6:
            raise ValueError('Independent full FP mean differs from production')
        if abs(red_cost_given_success - case['stageFpGivenFinalSuccess'][0]) > 1e-6:
            raise ValueError('Independent joint prefix cost differs from production')
        finite = finite_redemption(chain, (4, 7), tail, kernels)
        # Normal generation for L100 with an uncraftable affix; re-audited separately.
        fp_pmf, _ = initial_pmf(100, 4, True)
        natural = math.fsum(p * finite[fp] for fp, p in fp_pmf.items())
        entry = {'label': case['label'], 'baseId': case['baseId'], 'targetIds': case['targetIds'],
                 'expectedRedemptionCasts': hit['expectedCasts'], 'doubleAtFirstHit': both, 'oneAtFirstHit': only,
                 'operationSuccess': success, 'redemptionFpGivenFinalSuccess': red_cost_given_success,
                 'postFpGivenFinalSuccess': post_given_success, 'fullFpGivenFinalSuccess': mean,
                 'finiteFpCompletionCurve': [{'fp': fp, 'probability': p} for fp, p in enumerate(finite)],
                 'normalNaturalL100CompletionProbability': natural,
                 'finiteFpMeaning': 'Actually settle charged FP, last-charge preservation, critical refunds; final action can succeed at FP0; not merely P(total demand <= initial FP).'}
        cases.append(entry)
        print(json.dumps({**entry, 'finiteFpCompletionCurve': {fp: finite[fp] for fp in (32, 40, 48, 56, 63)}}, ensure_ascii=False))
    result = {'schemaVersion': 1, 'date': '2026-11-03', 'modelId': production['modelId'],
              'qualification': 'Independent nominal-probability Python recurrence; no TypeScript rule-engine calls or client crafting experiments. Normal FP only. Natural FP mixture is restricted to ordinary normal-context L100 generation with uncraftable affixes at roll time; verify source and historical FP edits separately.',
              'postSingleHit': {'sealProbability': SEAL, 'sealMeanFp': seal_cost, 'addMeanFp': add_cost,
                                'finalHavocMeanAttempts': float(havoc_attempts), 'finalHavocMeanFp': havoc_cost,
                                'totalFpGivenSealSuccess': post_mean},
              'fee': fees, 'cases': cases}
    output = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    path = ROOT / 'research/redemption-7272-independent.json'
    if verify_only:
        assert path.read_text(encoding='utf-8') == output
    else:
        path.write_text(output, encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-only', action='store_true')
    run(parser.parse_args().verify_only)
