"""Enumerate the six two-T7 identity classes; no game probability calculation.

Each ordinary slot is empty or holds A, B or one position-specific garbage ID,
with tiers1..7. A/B are distinct fixed IDs and obey their configured sides.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
from itertools import permutations, product
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'research/strategy-classification-coverage.json'
CATEGORIES = ('220', '211', '202', '210', '201', '200')
SLOT_NAMES = ('P0', 'P1', 'S0', 'S1')


def classify(state):
    ordinary = [entry for entry in state if entry is not None]
    sevens = sum(entry[1] == 7 for entry in ordinary)
    right = sum(entry[0] in ('A', 'B') and entry[1] == 7 for entry in ordinary)
    low = sum(entry[0] in ('A', 'B') and entry[1] != 7 for entry in ordinary)
    return f'{sevens}{right}{low}'


def digest(relative):
    return hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()


def fresh_stats():
    return {'count': 0, 'ordinaryCounts': Counter(), 'emptySides': Counter(), 'targetPositions': Counter(),
            'targetTierPairs': Counter(), 'garbageTierMultisets': Counter(), 'garbageTierPresence': Counter(),
            'directMissingTargetAdds': Counter(), 'allMissingTargetsFitTogether': Counter(),
            'leafCounters': Counter(), 'targetTierDomains': {'A': set(), 'B': set()}}


def add_stats(stats, state, sides):
    entries = [entry for entry in state if entry]
    stats['count'] += 1
    n = len(entries)
    stats['ordinaryCounts'][str(n)] += 1
    free = [sum(state[index] is None for index in range(side * 2, side * 2 + 2)) for side in (0, 1)]
    empty_key = f'P{free[0]}_S{free[1]}'
    stats['emptySides'][empty_key] += 1
    positions = {label: next((index for index, entry in enumerate(state) if entry and entry[0] == label), None)
                 for label in ('A', 'B')}
    position_key = '|'.join(label + '=' + (SLOT_NAMES[positions[label]] if positions[label] is not None else 'ABSENT') for label in ('A', 'B'))
    stats['targetPositions'][position_key] += 1
    tiers = {label: state[index][1] if index is not None else 0 for label, index in positions.items()}
    stats['targetTierPairs'][f'A{tiers["A"]}_B{tiers["B"]}'] += 1
    for label in ('A', 'B'):
        if tiers[label]:
            stats['targetTierDomains'][label].add(tiers[label])
    garbage = sorted(entry[1] for entry in entries if entry[0] not in ('A', 'B'))
    stats['garbageTierMultisets'][','.join(map(str, garbage)) or 'NONE'] += 1
    for tier in set(garbage):
        stats['garbageTierPresence'][str(tier)] += 1
    missing = [label for label in ('A', 'B') if positions[label] is None]
    available = [label for label in missing if free[sides[0 if label == 'A' else 1]] > 0]
    available_key = '+'.join(available) or ('NONE' if missing else 'ALREADY_PRESENT')
    stats['directMissingTargetAdds'][available_key] += 1
    fit = all(sum(sides[0 if label == 'A' else 1] == side for label in missing) <= free[side] for side in (0, 1))
    stats['allMissingTargetsFitTogether'][str(fit).lower()] += 1
    stats['leafCounters'][f'n{n}|{empty_key}|add={available_key}|fit={int(fit)}'] += 1


def plain(stats):
    return {key: {label: sorted(values) for label, values in value.items()} if key == 'targetTierDomains'
            else dict(sorted(value.items())) if isinstance(value, Counter) else value for key, value in stats.items()}


def enumerate_case(sides):
    options = []
    for index in range(4):
        side = index // 2
        labels = [f'X{index}'] + [label for label, required_side in zip(('A', 'B'), sides) if side == required_side]
        options.append([None] + [(label, tier) for label in labels for tier in range(1, 8)])
    counters = Counter()
    stats = {category: fresh_stats() for category in CATEGORIES}
    accepted = []
    for state in product(*options):
        counters['rawCandidates'] += 1
        if sum(entry is not None and entry[1] == 7 for entry in state) != 2:
            counters['rejectedNotExactlyTwoT7'] += 1
            continue
        labels = [entry[0] for entry in state if entry]
        if labels.count('A') > 1 or labels.count('B') > 1:
            counters['rejectedDuplicateTargetId'] += 1
            continue
        category = classify(state)
        if category not in stats:
            raise ValueError('An admissible identity combination fell outside the six classes')
        counters['acceptedStates'] += 1
        add_stats(stats[category], state, sides)
        accepted.append(state)
    same_side = sides[0] == sides[1]
    target_placements = 2 if same_side else 4
    independent_counts = {'200': 6 * 7 ** 2, '201': 2 * 2 * 6 * 3 * 7,
                          '202': target_placements * 6 ** 2, '210': 2 * 2 * 3 * 7 ** 2,
                          '211': 2 * 6 * target_placements * 2 * 7, '220': target_placements * 7 ** 2}
    if {category: value['count'] for category, value in stats.items()} != independent_counts:
        raise ValueError('Enumeration disagrees with independent placement/tiers product counts')
    return {'targetSides': {'A': sides[0], 'B': sides[1]}, 'enumeration': dict(counters),
            'independentCombinatorialCounts': independent_counts,
            'categories': {category: plain(value) for category, value in stats.items()}}, accepted


def add(state, identity, side, sealed_ids=()):
    if identity in sealed_ids or any(entry and entry[0] == identity for entry in state):
        raise ValueError('Cannot add an existing ordinary/sealed ID')
    positions = [index for index in range(side * 2, side * 2 + 2) if state[index] is None]
    if not positions:
        raise ValueError('No legal ordinary slot on the requested side')
    changed = list(state)
    changed[positions[0]] = (identity, 1)
    return tuple(changed)


def havoc(state, tiers):
    if any(entry is None for entry in state) or len(set(entry[1] for entry in state)) < 2:
        raise ValueError('Havoc needs four occupied slots and nonidentical tiers')
    old = [entry[1] for entry in state]
    if sorted(old) != sorted(tiers) or old == list(tiers):
        raise ValueError('Havoc witness must be a changed layout of the same tiers')
    return tuple((entry[0], tier) for entry, tier in zip(state, tiers))


def remove_or_seal(state, index, seal=False, sealed_free=True):
    entry = state[index]
    if entry is None or entry[0] in ('A', 'B'):
        raise ValueError('This witness only removes/seals an unwanted ordinary identity')
    if seal and (not sealed_free or not 1 <= entry[1] <= 4):
        raise ValueError('No legal seal in this witness')
    changed = list(state)
    changed[index] = None
    return tuple(changed)


def redempt(state, replacements):
    expected = [index for index, entry in enumerate(state) if entry and entry[1] >= 6]
    if list(replacements) != expected:
        raise ValueError('A Redemption cast must visit every T6/T7 ordinary slot in native order')
    changed = list(state)
    for index in expected:
        identity = replacements[index]
        if any(entry and entry[0] == identity for entry in changed):
            raise ValueError('The updated full ID exclusion set forbids this reroll witness')
        changed[index] = (identity, changed[index][1])
    return tuple(changed)


def show(state):
    return [{'position': SLOT_NAMES[index], 'idRole': entry[0], 'tier': entry[1]} if entry else
            {'position': SLOT_NAMES[index], 'empty': True} for index, entry in enumerate(state)]


def witnesses():
    # A/B are both prefixes unless explicitly stated otherwise.
    direct = (('A', 7), None, ('X2', 7), ('X3', 1))
    blocked = (('A', 7), ('X1', 1), ('X2', 7), None)
    if classify(direct) != '210' or classify(blocked) != '210':
        raise ValueError('Same-class counterexample was mistyped')
    add(direct, 'B', 0)
    try:
        add(blocked, 'B', 0)
    except ValueError:
        pass
    else:
        raise ValueError('Wrong-side vacancy unexpectedly admitted B')

    start = (('X0', 7), ('X1', 7), None, None)
    full = add(add(start, 'X2', 1), 'X3', 1)
    prepared = havoc(full, (1, 7, 7, 1))
    # First accepted removal opens A while preserving the ordinary seal for B.
    opened = remove_or_seal(prepared, 0)
    acquired = add(opened, 'A', 0)
    wrong_side_prepared_b = havoc(acquired, (7, 1, 7, 1))
    wrong_side_sealed_b = remove_or_seal(wrong_side_prepared_b, 1, seal=True)
    wrong_side_added_b = add(wrong_side_sealed_b, 'B', 0)
    wrong_side_finished = havoc(wrong_side_added_b, (7, 7, 1, 1))

    # Required template remove -> addA -> prepare -> seal -> addB.
    start_remove = (('X0', 3), ('X1', 7), ('X2', 7), ('X3', 1))
    removed = remove_or_seal(start_remove, 0)
    added_a = add(removed, 'A', 0)
    prepared_b = havoc(added_a, (7, 1, 7, 1))
    sealed_b = remove_or_seal(prepared_b, 1, seal=True)
    added_b = add(sealed_b, 'B', 0)
    finished = havoc(added_b, (7, 7, 1, 1))
    if [classify(value) for value in (start_remove, removed, added_a, prepared_b, sealed_b, added_b, finished)] != ['200', '200', '201', '210', '210', '211', '220']:
        raise ValueError('Mixed structural witness did not follow its stated classes')

    # First acquire A; deliberately move A belowT6 before a SECOND Redemption phase.
    first_start = (('X0', 7), ('X1', 7), ('X2', 3), ('X3', 2))
    first_hit = redempt(first_start, {0: 'A', 1: 'Y1'})
    demoted = havoc(first_hit, (3, 7, 7, 2))
    second_hit = redempt(demoted, {1: 'B', 2: 'Y2'})
    two_phase_end = havoc(second_hit, (7, 7, 3, 2))
    if [classify(value) for value in (first_start, first_hit, demoted, second_hit, two_phase_end)] != ['200', '210', '201', '211', '220']:
        raise ValueError('Two-phase Redemption structural witness was mistyped')
    if demoted[0] != second_hit[0]:
        raise ValueError('SubT6 A should not be rerolled by the second Redemption')

    immediate = redempt(first_start, {0: 'A', 1: 'B'})
    t6_start = (('X0', 7), ('X1', 6), ('X2', 7), ('X3', 1))
    immediate_211 = redempt(t6_start, {0: 'A', 1: 'B', 2: 'Y2'})
    if classify(immediate) != '220' or classify(immediate_211) != '211':
        raise ValueError('Direct class-skipping Redemption witness was mistyped')
    reverse_start = (('A', 7), ('B', 1), ('X2', 7), ('X3', 2))
    reversed_targets = havoc(reverse_start, (1, 2, 7, 7))
    if classify(reverse_start) != '211' or classify(reversed_targets) != '202':
        raise ValueError('Havoc regression witness was mistyped')

    def sequence(entries):
        return [{'action': name, 'category': classify(state), 'state': show(state)} for name, state in entries]
    return {'same210DifferentAddEligibility': {'directB': show(direct), 'blockedB': show(blocked),
                                               'sameClass': '210', 'ordinaryCount': 3,
                                               'targetSides': {'A': 0, 'B': 0}},
            '200AllVacanciesWrongSide': sequence([('START', start), ('ADD_GARBAGE_TO_FOUR', full),
                                                  ('HAVOC_PREPARE_PREFIX_T1', prepared), ('ACCEPTED_REMOVAL_PREFIX', opened), ('ADD_A', acquired),
                                                  ('HAVOC_PREPARE_B_PREFIX', wrong_side_prepared_b), ('REQUIRED_SEAL_SUCCESS', wrong_side_sealed_b),
                                                  ('ADD_B', wrong_side_added_b), ('FINAL_HAVOC', wrong_side_finished)]),
            'removeAddPrepareSealAdd': sequence([('START', start_remove), ('ACCEPTED_REMOVAL', removed), ('ADD_A', added_a),
                                                 ('HAVOC_PREPARE', prepared_b), ('REQUIRED_SEAL_SUCCESS', sealed_b), ('ADD_B', added_b), ('FINAL_HAVOC', finished)]),
            'twoRedemptionPhasesWithDemotedKnownTarget': sequence([('START', first_start), ('FIRST_REDEMPTION_PHASE_EXIT', first_hit),
                                                                  ('HAVOC_DEMOTE_A_BELOW_T6', demoted), ('SECOND_REDEMPTION_PHASE_EXIT', second_hit), ('FINAL_HAVOC', two_phase_end)]),
            'direct200To220': sequence([('START', first_start), ('REDEMPTION_BOTH_TARGETS', immediate)]),
            'direct200To211ViaT6': sequence([('START', t6_start), ('REDEMPTION_REPLACED_ALL_THREE_EXALTED', immediate_211)]),
            'havoc211To202': sequence([('START', reverse_start), ('HAVOC', reversed_targets)]),
            'scope': 'Positive-possibility symbolic branches only; no probabilities, FP, protection, concrete shard or level assertions. Complete casts are checked; all garbage IDs are distinct. A/B side is prefix in these witnesses.'}


def build():
    aggregate = {category: fresh_stats() for category in CATEGORIES}
    cases = {}
    havoc_edges = set()
    for sides in product((0, 1), repeat=2):
        report, states = enumerate_case(sides)
        cases[f'A{sides[0]}_B{sides[1]}'] = report
        for state in states:
            add_stats(aggregate[classify(state)], state, sides)
            if all(state) and classify(state) != '220':
                old_tiers = tuple(entry[1] for entry in state)
                for tiers in set(permutations(old_tiers)) - {old_tiers}:
                    changed = tuple((entry[0], tier) for entry, tier in zip(state, tiers))
                    havoc_edges.add((classify(state), classify(changed)))
    counts = {category: stats['count'] for category, stats in aggregate.items()}
    allowed_occupancy = {'220': [2, 3, 4], '211': [3, 4], '202': [4], '210': [2, 3, 4], '201': [3, 4], '200': [2, 3, 4]}
    for category, allowed in allowed_occupancy.items():
        if sorted(map(int, aggregate[category]['ordinaryCounts'])) != allowed:
            raise ValueError('Unexpected occupancy range for ' + category)
    paths = ('src/core/rules.ts', 'src/core/catalog.ts', 'src/core/validation.ts',
             'docs/strategy-classification.md', 'scripts/check_strategy_classification.py')
    return {'schemaVersion': 1, 'auditedOn': '2026-11-03', 'scope': 'ABSTRACT_STANDARD_TWO_T7_STRUCTURE_ONLY',
            'slotOrder': list(SLOT_NAMES), 'targetSideSettings': 4,
            'abstractStateCount': sum(counts.values()), 'categoryCounts': counts,
            'categoriesAreExclusiveAndExhaustiveInScope': True,
            'allowedOrdinaryCounts': allowed_occupancy,
            'orthogonalOrdinarySealOccupancyFlags': ['EMPTY', 'OCCUPIED'],
            'stateFlagProductCountNotAdditionalPhysicalValidation': 2 * sum(counts.values()),
            'scopeExclusions': ['Actual affix-ID permutations/weights, base/class compatibility, shard availability, levels, special affixes, roll objectives, protections, corrupted/primordial slots, sealed identities and native list order are not enumerated.',
                                'The occupied seal flag alone is insufficient: the sealed ID affects duplicate-ID exclusion and whether a missing target is trapped outside ordinary slots.',
                                'Counts are labelled structural representatives, not a loot/target distribution and not a complete count of concrete game states.',
                                'Template sequence witnesses prove structural possibility only, not policy conformance, optimality,15% threshold or100FP acceptance.'],
            'aggregate': {category: plain(stats) for category, stats in aggregate.items()},
            'havocClassEdgesWith220Terminal': [list(edge) for edge in sorted(havoc_edges)],
            'cases': cases, 'witnesses': witnesses(),
            'inputSha256': {path: digest(path) for path in paths}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    report = build()
    content = (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')
    if args.verify_only:
        if OUTPUT.read_bytes() != content:
            raise ValueError('Saved classification coverage is stale')
    else:
        OUTPUT.write_bytes(content)
    print(json.dumps({'states': report['abstractStateCount'], 'counts': report['categoryCounts'],
                      'exclusiveAndExhaustive': True, 'verifiedOnly': args.verify_only}))


if __name__ == '__main__':
    main()
