"""Infinite-FP repeat-Redemption research with exact weight-class state compression.

Uses only Python's standard library and committed local resource snapshots.
Linear systems are solved in binary64; this is not native-client RNG replay.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from fractions import Fraction
import json
import math

from research_redemption_average import ROOT, ORDINARY_TYPES, read, digest, class_matches, craft_weight

OUTPUT = ROOT / 'research/redemption-intrinsic.json'


def pools(equipment_type: int, requirement: int):
    result = ([], [])
    for affix in read('data/game/1.5.3/affixes.json')['affixes']:
        definition = affix['definition']
        if (definition['specialAffixType'] == 0 and definition['type'] in (0, 1) and
                equipment_type in definition['canRollOn'] and class_matches(requirement, definition['classSpecificity'])):
            weight = craft_weight(definition, equipment_type)
            if weight > 0:
                result[definition['type']].append({'id': affix['id'], 'name': definition['affixName'],
                                                   'side': definition['type'], 'weight': weight})
    return result


def fee_mean(upper: int = 20):
    lucky, hope, ice = Fraction(285, 1000), Fraction(1, 4), Fraction(3, 10)
    mean = sum(((1 - lucky) * cost + lucky * (Fraction(cost, 2) if cost > 1 else 1)
                for cost in range(1, upper)), Fraction()) / (upper - 1)
    normal = mean * (1 - hope)
    return {'baseAfterLucky': float(mean), 'normalAndBlood': float(normal),
            'ice': float(normal * (1 - ice)), 'normalFraction': str(normal), 'iceFraction': str(normal * (1 - ice))}


def make_chain(entries, target_ids: tuple[int, int], slot_sides: tuple[int, int]):
    by_weight = defaultdict(list)
    targets = set(target_ids)
    for entry in entries:
        key = (entry['side'], 'TARGET_' + str(entry['id']) if entry['id'] in targets else 'OTHER', entry['weight'])
        by_weight[key].append(entry['id'])
    groups = [{'side': side, 'targetId': ids[0] if label != 'OTHER' else None,
               'weight': weight, 'ids': sorted(ids), 'count': len(ids)}
              for (side, label, weight), ids in sorted(by_weight.items())]
    lookup = {identity: index for index, group in enumerate(groups) for identity in group['ids']}
    sides = [[index for index, group in enumerate(groups) if group['side'] == side] for side in slot_sides]
    states = [(a, b) for a in sides[0] for b in sides[1] if a != b or groups[a]['count'] >= 2]
    state_index = {state: index for index, state in enumerate(states)}
    transition = []
    for a, b in states:
        first = [(g, (groups[g]['count'] - int(g == a) - int(g == b)) * groups[g]['weight']) for g in sides[0]]
        first = [(g, weight) for g, weight in first if weight > 0]
        total_first = math.fsum(weight for _, weight in first)
        row = defaultdict(float)
        for g, first_weight in first:
            second = [(h, (groups[h]['count'] - int(h == g) - int(h == b)) * groups[h]['weight']) for h in sides[1]]
            second = [(h, weight) for h, weight in second if weight > 0]
            total_second = math.fsum(weight for _, weight in second)
            for h, second_weight in second:
                row[state_index[(g, h)]] += first_weight / total_first * second_weight / total_second
        if abs(math.fsum(row.values()) - 1) > 1e-13:
            raise ValueError('Compressed transition does not conserve probability mass')
        transition.append(dict(row))
    return {'groups': groups, 'states': states, 'stateIndex': state_index,
            'lookup': lookup, 'transition': transition, 'targetIds': target_ids, 'slotSides': slot_sides}


def solve(matrix, rhs):
    n, width = len(matrix), len(rhs[0])
    augmented = [row[:] + right[:] for row, right in zip(matrix, rhs)]
    for column in range(n):
        pivot = max(range(column, n), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-14:
            raise ValueError('Nonabsorbing or numerically singular chain')
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        scale = augmented[column][column]
        for j in range(column, n + width):
            augmented[column][j] /= scale
        for row in range(n):
            if row == column:
                continue
            scale = augmented[row][column]
            if scale:
                for j in range(column, n + width):
                    augmented[row][j] -= scale * augmented[column][j]
    return [row[n:] for row in augmented]


def analyze(chain, initial_ids: tuple[int, int], mode: str, terminals: bool = True):
    groups, states, transition = chain['groups'], chain['states'], chain['transition']
    def hits(state):
        return {groups[g]['targetId'] for g in state if groups[g]['targetId'] is not None}
    def reached(state):
        found = hits(state)
        if mode == 'TARGET_A':
            return chain['targetIds'][0] in found
        if mode == 'TARGET_B':
            return chain['targetIds'][1] in found
        return len(found) >= (2 if mode == 'BOTH' else 1)
    absorbing = [index for index, state in enumerate(states) if reached(state)]
    reachable = set(absorbing)
    while True:
        expanded = reachable | {index for index, row in enumerate(transition)
                                if any(probability > 0 and destination in reachable for destination, probability in row.items())}
        if expanded == reachable:
            break
        reachable = expanded
    if len(reachable) != len(states):
        raise ValueError('Some states cannot reach the stopping set; do not claim eventual probability one')
    transient = [index for index in range(len(states)) if index not in set(absorbing)]
    at = {value: index for index, value in enumerate(transient)}
    initial = chain['stateIndex'][tuple(chain['lookup'][identity] for identity in initial_ids)]
    if initial in absorbing:
        raise ValueError('Research fixtures must start below their stopping target')
    matrix, rhs = [], []
    for index in transient:
        row = [-transition[index].get(j, 0.0) for j in transient]
        row[at[index]] += 1
        matrix.append(row)
        rhs.append([1.0, math.fsum(transition[index].get(j, 0.0) for j in absorbing)] +
                   ([transition[index].get(j, 0.0) for j in absorbing] if terminals else []))
    values = solve(matrix, rhs)
    maximum_residual = max(abs(math.fsum(matrix[i][j] * values[j][0] for j in range(len(transient))) - 1)
                           for i in range(len(transient)))
    result = values[at[initial]]
    no_target_states = [index for index in transient if not hits(states[index])]
    best = min(no_target_states, key=lambda index: values[at[index]][0])
    worst = max(no_target_states, key=lambda index: values[at[index]][0])
    fees = fee_mean()
    report = {'mode': mode, 'initialT7Ids': list(initial_ids), 'compressedStates': len(states),
              'transientStates': len(transient), 'eventualHitProbability': result[1],
              'allStatesCanReachAbsorbingSet': True,
              'expectedCasts': result[0], 'expectedFpNormalAndBlood': result[0] * fees['normalAndBlood'],
              'expectedFpIce': result[0] * fees['ice'], 'linearEquationMaximumResidual': maximum_residual,
              'bestNoTargetStartExpectedCasts': values[at[best]][0], 'worstNoTargetStartExpectedCasts': values[at[worst]][0],
              'bestNoTargetState': list(states[best]), 'bestNoTargetStartExpectedFpNormalAndBlood': values[at[best]][0] * fees['normalAndBlood'],
              'bestNoTargetStartExpectedFpIce': values[at[best]][0] * fees['ice']}
    if abs(result[1] - 1) > 1e-10 or maximum_residual > 1e-8:
        raise ValueError('Absorption probability/residual check failed')
    if terminals:
        moments = solve(matrix, [row[2:] for row in values])
        exit_moments = moments[at[initial]]
        exits = []
        aggregate = defaultdict(float)
        for state_index, probability, attempts_moment in zip(absorbing, result[2:], exit_moments):
            state = states[state_index]
            found = sorted(hits(state))
            label = 'BOTH' if len(found) == 2 else str(found[0])
            aggregate[label] += probability
            exits.append({'orderedGroupIndices': list(state), 'representativeT7Ids': list(representative_ids(chain, state)),
                          'targetIds': found, 'probability': probability,
                          'castCountFirstMoment': attempts_moment,
                          'fpFirstMomentNormalAndBlood': attempts_moment * fees['normalAndBlood'],
                          'fpFirstMomentIce': attempts_moment * fees['ice'],
                          'expectedCastsGivenExit': attempts_moment / probability if probability > 0 else None})
        if abs(math.fsum(entry['probability'] for entry in exits) - 1) > 1e-10:
            raise ValueError('Absorbing distribution did not sum to one')
        if abs(math.fsum(entry['castCountFirstMoment'] for entry in exits) - result[0]) > 1e-8:
            raise ValueError('Terminal cast-count moments did not sum to expected attempts')
        report['terminalTargetMass'] = dict(aggregate)
        report['terminalOrderedWeightGroupDistribution'] = exits
    return report


def representative_ids(chain, state):
    a, b = state
    return (chain['groups'][a]['ids'][0], chain['groups'][b]['ids'][1 if a == b else 0])


def glove_report():
    prefix, _ = pools(4, 0)
    chain = make_chain(prefix, (4, 5), (0, 0))
    return {'baseId': '4:0', 'initialAllIds': [2, 26, 7, 10], 'initialTiers': [7, 7, 3, 2],
            'targetIds': [4, 5], 'groups': chain['groups'],
            'both': analyze(chain, (2, 26), 'BOTH'),
            'atLeastOne': analyze(chain, (2, 26), 'AT_LEAST_ONE'),
            'targetA': analyze(chain, (2, 26), 'TARGET_A'),
            'targetB': analyze(chain, (2, 26), 'TARGET_B')}


def check_compaction():
    prefix, _ = pools(4, 0)
    chain = make_chain(prefix, (4, 5), (0, 0))
    entries = {entry['id']: entry for entry in prefix}
    maximum = 0.0
    checked = 0
    for x in entries:
        for y in entries:
            if x == y:
                continue
            native = defaultdict(float)
            first = [entry for identity, entry in entries.items() if identity not in (x, y)]
            total_first = math.fsum(entry['weight'] for entry in first)
            for first_entry in first:
                u = first_entry['id']
                second = [entry for identity, entry in entries.items() if identity not in (u, y)]
                total_second = math.fsum(entry['weight'] for entry in second)
                for second_entry in second:
                    group_state = (chain['lookup'][u], chain['lookup'][second_entry['id']])
                    native[chain['stateIndex'][group_state]] += first_entry['weight'] / total_first * second_entry['weight'] / total_second
            state = chain['stateIndex'][(chain['lookup'][x], chain['lookup'][y])]
            compressed = chain['transition'][state]
            maximum = max(maximum, max(abs(native.get(i, 0) - compressed.get(i, 0)) for i in range(len(chain['states']))))
            checked += 1
    if maximum > 1e-13:
        raise ValueError('Full individual-ID transitions disagree with the compressed chain')

    toy_entries = [{'id': identity, 'side': 0, 'weight': 1.0, 'name': str(identity)} for identity in range(4)]
    compressed = make_chain(toy_entries, (0, 1), (0, 0))
    states = [(x, y) for x in range(4) for y in range(4) if x != y]
    raw = []
    for x, y in states:
        row = defaultdict(Fraction)
        for u in range(4):
            if u in (x, y):
                continue
            for v in range(4):
                if v not in (u, y):
                    row[(u, v)] += Fraction(1, 4)
        raw.append(row)
    exact_checks = []
    for mode in ('BOTH', 'AT_LEAST_ONE', 'TARGET_A'):
        def terminal(state):
            if mode == 'BOTH':
                return set(state) == {0, 1}
            if mode == 'TARGET_A':
                return 0 in state
            return bool(set(state) & {0, 1})
        transient = [state for state in states if not terminal(state)]
        matrix = []
        for state in transient:
            row = [-raw[states.index(state)].get(other, Fraction()) for other in transient]
            row[transient.index(state)] += 1
            matrix.append(row)
        result = solve(matrix, [[Fraction(1)] for _ in transient])[transient.index((2, 3))][0]
        observed = analyze(compressed, (2, 3), mode, terminals=False)['expectedCasts']
        if abs(observed - float(result)) > 1e-12:
            raise ValueError('Small exact individual-ID solve differs from compressed result')
        exact_checks.append({'mode': mode, 'expectedCastsExactFraction': str(result), 'compressedValue': observed})
    return {'fullGloveOrderedIdStatesChecked': checked, 'maximumTransitionDifference': maximum,
            'exactFourIdModels': exact_checks}


def scan():
    items = read('data/game/1.5.3/items.json')
    keys = sorted({(base['baseTypeId'], base['definition']['classRequirement']) for base in items['bases']
                   if base['baseTypeId'] in ORDINARY_TYPES})
    results = []
    for equipment_type, requirement in keys:
        prefix, suffix = pools(equipment_type, requirement)
        for side, entries in enumerate((prefix, suffix)):
            ranked = sorted(entries, key=lambda entry: (-entry['weight'], entry['id']))
            targets = tuple(entry['id'] for entry in ranked[:2])
            initial = tuple(entry['id'] for entry in ranked[2:4])
            chain = make_chain(entries, targets, (side, side))
            report = analyze(chain, initial, 'BOTH', terminals=False)
            best_ids = representative_ids(chain, report['bestNoTargetState'])
            results.append({'equipmentType': equipment_type, 'classRequirement': requirement,
                            'pattern': 'TWO_PREFIX_T7' if side == 0 else 'TWO_SUFFIX_T7',
                            'targetIds': list(targets), 'targetWeights': [ranked[0]['weight'], ranked[1]['weight']],
                            'poolCount': len(entries), 'poolWeight': math.fsum(entry['weight'] for entry in entries),
                            'bestNoTargetT7Ids': list(best_ids), **report})
        targets = (max(prefix, key=lambda entry: entry['weight'])['id'], max(suffix, key=lambda entry: entry['weight'])['id'])
        low_prefix = max((entry for entry in prefix if entry['id'] != targets[0]), key=lambda entry: entry['weight'])
        low_suffix = max((entry for entry in suffix if entry['id'] != targets[1]), key=lambda entry: entry['weight'])
        entries = [entry for entry in prefix + suffix if entry['id'] not in (low_prefix['id'], low_suffix['id'])]
        chain = make_chain(entries, targets, (0, 1))
        initial = tuple(next(entry['id'] for entry in entries if entry['side'] == side and entry['id'] != targets[side]) for side in (0, 1))
        report = analyze(chain, initial, 'BOTH', terminals=False)
        results.append({'equipmentType': equipment_type, 'classRequirement': requirement, 'pattern': 'ONE_PREFIX_ONE_SUFFIX_T7',
                        'targetIds': list(targets), 'fixedLowTierIds': [low_prefix['id'], low_suffix['id']],
                        'bestNoTargetT7Ids': list(representative_ids(chain, report['bestNoTargetState'])), **report})
    return results


def one_cast_bound():
    items = read('data/game/1.5.3/items.json')
    keys = sorted({(base['baseTypeId'], base['definition']['classRequirement']) for base in items['bases']
                   if base['baseTypeId'] in ORDINARY_TYPES})
    rows = []
    for equipment_type, requirement in keys:
        for side, entries in enumerate(pools(equipment_type, requirement)):
            weights = [Fraction(entry['weight']) for entry in entries]
            rows.append({'equipmentType': equipment_type, 'classRequirement': requirement, 'side': side,
                         'count': len(weights), 'total': sum(weights, Fraction()), 'maximum': max(weights)})
    maximum = max(row['maximum'] for row in rows)
    if maximum > 1:
        raise ValueError('Unit-weight single-cast bound does not apply: candidate weight exceeds one')
    minimum = min(row['total'] for row in rows)
    minimum_prefix = min(row['total'] for row in rows if row['side'] == 0)
    minimum_suffix = min(row['total'] for row in rows if row['side'] == 1)
    same = 2 / (minimum - 2) ** 2
    mixed = 1 / ((minimum_prefix - 2) * (minimum_suffix - 2))
    if not (same < Fraction(15, 100) and mixed < Fraction(15, 100)):
        raise ValueError('Computed single-cast bound does not pass the strict15% filter')
    from research_redemption_average import exact_cast
    prefix, _ = pools(3, 0)
    pool = {entry['id']: {**entry, 'weight': Fraction(entry['weight'])} for entry in prefix}
    distribution = exact_cast((502, 504, 7, 10), (0, 1), pool)
    attained = sum((probability for ids, probability in distribution.items() if set(ids[:2]) == {28, 501}), Fraction())
    if attained != same:
        raise ValueError('Current boots example does not attain the stated global same-side bound')
    return {'modelScope': 'ONE_COMPLETE_REDEMPTION_CAST_NO_OTHER_ACTIONS_FOUR_STANDARD_ORDINARY_AFFIXES_NO_ADDITIONAL_SEALED_IDS',
            'poolGroupsChecked': len(keys), 'sidePoolsChecked': len(rows), 'maximumCandidateCraftWeight': float(maximum),
            'minimumSidePoolWeight': float(minimum), 'minimumPrefixPoolWeight': float(minimum_prefix),
            'minimumSuffixPoolWeight': float(minimum_suffix),
            'sameSideGlobalUpperBound': float(same), 'sameSideGlobalUpperBoundFraction': str(same),
            'mixedSideGlobalUpperBound': float(mixed), 'mixedSideGlobalUpperBoundFraction': str(mixed),
            'strictlyBelow15PercentByExactFractionComparison': True,
            'attainingBootsExample': {'baseId': '3:0', 'initialIds': [502, 504, 7, 10], 'initialTiers': [7, 7, 3, 2],
                                     'targetIds': [28, 501], 'singleCastProbabilityFraction': str(attained),
                                     'singleCastProbability': float(attained)},
            'sidePools': [{**row, 'total': float(row['total']), 'totalFraction': str(row['total']),
                           'maximum': float(row['maximum'])} for row in rows],
            'qualification': 'Each denominator excludes at most two eligible identities on its side, each with weight at most one. Two same-side target orders give2/(W-2)^2; mixed sides give1/((Wp-2)(Ws-2)). This bound is for a one-cast route only, not repeat-until-both, other mixed actions, extra sealed exclusions, or native RNG replay.'}


def build():
    manifest = read('data/game/1.5.3/manifest.json')
    for filename in ('affixes.json', 'items.json'):
        if digest('data/game/1.5.3/' + filename) != manifest['artifacts'][filename]['sha256']:
            raise ValueError('Frozen snapshot hash differs: ' + filename)
    glove = glove_report()
    scans = scan()
    paths = ('data/game/1.5.3/affixes.json', 'data/game/1.5.3/items.json', 'data/game/1.5.3/manifest.json',
             'research/affix-action-claims.json', 'research/forge-fp-claims.json',
             'scripts/research_redemption_average.py', 'scripts/research_redemption_intrinsic.py')
    return {'schemaVersion': 1, 'auditedOn': '2026-11-03', 'gameVersion': manifest['gameVersion'],
            'steamBuildId': manifest['steamBuildId'], 'dataRevision': manifest['dataRevision'],
            'model': 'INDEPENDENT_NORMALIZED_CURRENT_CRAFT_WEIGHTS_INFINITE_FP_DEMAND',
            'actualClientTests': 0, 'nativeGridBitExact': False, 'dependency': 'PYTHON_STANDARD_LIBRARY_ONLY',
            'feePerCast': fee_mean(), 'gloveFixture': glove, 'scan': scans,
            'independentChecks': check_compaction(),
            'oneCastGlobalBound': one_cast_bound(),
            'scanMinimumNormal': min(scans, key=lambda row: row['bestNoTargetStartExpectedFpNormalAndBlood']),
            'scanMinimumIce': min(scans, key=lambda row: row['bestNoTargetStartExpectedFpIce']),
            'normalCasesAtMost100': sum(row['bestNoTargetStartExpectedFpNormalAndBlood'] <= 100 for row in scans),
            'iceCasesAtMost100': sum(row['bestNoTargetStartExpectedFpIce'] <= 100 for row in scans),
            'sideMismatchImpossibleExample': {'baseId': '4:0', 'initialIds': [2, 26, 7, 10],
                                              'initialTiers': [3, 2, 7, 7], 'targetT7Ids': [4, 5],
                                              'eventualHitProbability': 0, 'nonterminationProbability': 1,
                                              'expectedCasts': None, 'expectedFpDemand': None,
                                              'reason': 'PURE_REDEMPTION_PRESERVES_TIER_AND_SIDE; BOTH_T7_SUFFIXES_CANNOT_BECOME_TARGET_PREFIXES'},
            'inputSha256': {path: digest(path) for path in paths},
            'qualification': 'Finite weight-class Markov chain, whole two-slot cast before stopping, binary64 linear solve. No initial-FP truncation or low-FP preservation; each cast uses untruncated cost, Hope and optional Ice. First-one terminal groups preserve target identity/order/other weight class, not individual non-target identities within an exchangeable class. Scan uses highest craft-weight targets and reports best/worst legal no-target starts; it is a search for counterexamples, not a dominance proof over every target pair or mixed route.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--fixture-only', action='store_true')
    args = parser.parse_args()
    if args.fixture_only:
        print(json.dumps({'fee': fee_mean(), 'glove': glove_report()}, ensure_ascii=False))
        return
    report = build()
    encoded = (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
    if args.verify_only:
        if OUTPUT.read_bytes() != encoded:
            raise ValueError('Saved intrinsic Redemption report is stale')
    else:
        OUTPUT.write_bytes(encoded)
    summary_keys = ('eventualHitProbability', 'expectedCasts', 'expectedFpNormalAndBlood', 'expectedFpIce',
                    'compressedStates', 'linearEquationMaximumResidual')
    print(json.dumps({'gloveBoth': {key: report['gloveFixture']['both'][key] for key in summary_keys},
                      'gloveOne': {key: report['gloveFixture']['atLeastOne'][key] for key in summary_keys},
                      'normalCasesAtMost100': report['normalCasesAtMost100'], 'iceCasesAtMost100': report['iceCasesAtMost100'],
                      'minimumNormal': report['scanMinimumNormal'], 'verifiedOnly': args.verify_only}, ensure_ascii=False))


if __name__ == '__main__':
    main()
