"""Compare coarse upper-state labels on the existing8580 structure representatives.

This is an action-signature/projection analysis, not a probability kernel or a
physical game-state enumeration. No production modules are modified/imported.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from itertools import product
import json
from pathlib import Path

from check_strategy_classification import ROOT, enumerate_case, classify, digest, show

OUTPUT = ROOT / 'research/upper-state-projection.json'
LEVELS = ('G', 'G_N', 'G_N_S', 'G_N_S_EMPTY', 'G_N_S_EMPTY_CONTEXT_MASK')


def fields(state, sides, sealed_count):
    n = sum(entry is not None for entry in state)
    identities = {entry[0] for entry in state if entry}
    empty = tuple(sum(state[index] is None for index in range(side * 2, side * 2 + 2)) for side in (0, 1))
    mask = sum(1 << index for index, identity in enumerate(('A', 'B')) if identity in identities)
    return {'G': classify(state), 'N': n, 'S': sealed_count, 'T': n + sealed_count,
            'emptyPrefix': empty[0], 'emptySuffix': empty[1], 'sideA': sides[0], 'sideB': sides[1], 'presentTargetMask': mask}


def projections(value):
    g, n, s = value['G'], value['N'], value['S']
    base = (g, n, s)
    empty = base + (value['emptyPrefix'], value['emptySuffix'])
    return {'G': (g,), 'G_N': (g, n), 'G_N_S': base, 'G_N_S_EMPTY': empty,
            'G_N_S_EMPTY_CONTEXT_MASK': empty + (value['sideA'], value['sideB'], value['presentTargetMask']),
            'G_T': (g, value['T']), 'G_T_S': (g, value['T'], s)}


def signature(state, sides, sealed_count, extra_sealed_ids=()):
    identities = {entry[0] for entry in state if entry} | set(extra_sealed_ids)
    free = [sum(state[index] is None for index in range(side * 2, side * 2 + 2)) for side in (0, 1)]
    direct_add = tuple(identity for index, identity in enumerate(('A', 'B'))
                       if identity not in identities and free[sides[index]] > 0)
    n = sum(entry is not None for entry in state)
    havoc = n == 4  # Exactly twoT7 already implies exalted and nonidentical tiers here.
    sealable_garbage = tuple(sorted({(index // 2, entry[1]) for index, entry in enumerate(state)
                                    if not sealed_count and entry and entry[0] not in ('A', 'B') and entry[1] <= 4}))
    return direct_add, havoc, sealable_garbage


def new_bucket():
    return {'representatives': 0, 'joint': set(), 'add': set(), 'havoc': set(), 'seal': set()}


def summarize(buckets):
    terminal = sum(key[0] == '220' for key in buckets)
    return {'labels': len(buckets), 'terminal220Labels': terminal, 'activeLabels': len(buckets) - terminal,
            'labelsAfterMerging220IntoOneTerminal': len(buckets) - terminal + 1,
            'heterogeneousJointBuckets': sum(len(row['joint']) > 1 for row in buckets.values()),
            'heterogeneousActiveJointBuckets': sum(key[0] != '220' and len(row['joint']) > 1 for key, row in buckets.items()),
            'heterogeneousDirectAddBuckets': sum(len(row['add']) > 1 for row in buckets.values()),
            'heterogeneousHavocEligibilityBuckets': sum(len(row['havoc']) > 1 for row in buckets.values()),
            'heterogeneousPotentialGarbageSealBuckets': sum(len(row['seal']) > 1 for row in buckets.values()),
            'maximumJointSignaturesInOneBucket': max(len(row['joint']) for row in buckets.values())}


def witnesses():
    sides = (0, 0)
    direct = (('A', 7), None, ('X2', 7), ('X3', 1))
    blocked = (('A', 7), ('X1', 1), ('X2', 7), None)
    if projections(fields(direct, sides, 0))['G_N_S'] != projections(fields(blocked, sides, 0))['G_N_S']:
        raise ValueError('Direct-add witness labels differ')
    if signature(direct, sides, 0)[0] != ('B',) or signature(blocked, sides, 0)[0] != ():
        raise ValueError('Wrong-side vacancy counterexample failed')
    equal_low = (('A', 7), ('B', 1), ('X2', 7), ('X3', 1))
    different_low = (('A', 7), ('B', 1), ('X2', 7), ('X3', 2))
    if fields(equal_low, sides, 0) != fields(different_low, sides, 0):
        raise ValueError('Havoc witness labels differ even at the finest tested projection')
    sealed_b_adds = signature(direct, sides, 1, ('B',))[0]
    sealed_c_adds = signature(direct, sides, 1, ('C',))[0]
    if sealed_b_adds != () or sealed_c_adds != ('B',):
        raise ValueError('Sealed identity exclusion witness failed')
    return {'same210N3S0DifferentVacancySide': {'directState': show(direct), 'blockedState': show(blocked),
                                               'coarseLabel': ['210', 3, 0], 'directAdds': ['B'], 'blockedAdds': []},
            'same211N4S0DifferentLowTierMultiplicity': {'equalLowState': show(equal_low), 'differentLowState': show(different_low),
                                                       'sameFinestProjection': fields(equal_low, sides, 0),
                                                       'probabilitiesNotRecomputedByThisScript': True,
                                                       'productionKernelEvidence': 'research/upper-state-havoc-check.json'},
            'same210N3S1DifferentSealedIdentity': {'ordinaryState': show(direct), 'label': ['210', 3, 1],
                                                 'sealedB': {'directAdds': [], 'requiredOrdinaryBReachable': False},
                                                 'sealedFreshGarbageC': {'directAdds': ['B'], 'canThenReachBothT7': True},
                                                 'outsideFlagOnlyPopulation': True,
                                                 'proof': 'Full item IDs block add/reroll duplicates; no current operation removes/unseals sealedB. GarbageC leaves the empty prefix available forB.'}}


def build():
    all_levels = LEVELS + ('G_T', 'G_T_S')
    buckets = {level: defaultdict(new_bucket) for level in all_levels}
    contexts = {}
    ordinary_representatives = 0
    for sides in product((0, 1), repeat=2):
        _, states = enumerate_case(sides)
        ordinary_representatives += len(states)
        context_labels = {level: set() for level in all_levels}
        for state in states:
            for s in (0, 1):
                value = fields(state, sides, s)
                keys = projections(value)
                sig = signature(state, sides, s)
                for level, key in keys.items():
                    row = buckets[level][key]
                    row['representatives'] += 1
                    row['joint'].add(sig)
                    row['add'].add(sig[0])
                    row['havoc'].add(sig[1])
                    row['seal'].add(sig[2])
                    context_labels[level].add(key)
        contexts[f'A{sides[0]}_B{sides[1]}'] = {'ordinaryStructureRepresentatives': len(states),
                                              'flagReplicas': len(states) * 2,
                                              'labelCountsWithinThisFixedContext': {level: len(keys) for level, keys in context_labels.items()}}
    expected = {'G': 6, 'G_N': 14, 'G_N_S': 28, 'G_N_S_EMPTY': 50, 'G_N_S_EMPTY_CONTEXT_MASK': 232, 'G_T': 20, 'G_T_S': 28}
    if {level: len(rows) for level, rows in buckets.items()} != expected or ordinary_representatives != 8580:
        raise ValueError('Projection counts disagree with the reviewed population')
    details = []
    for (g, n, s), row in sorted(buckets['G_N_S'].items()):
        details.append({'G': g, 'N': n, 'S': s, 'T': n + s, 'flagReplicas': row['representatives'],
                        'directAddVariants': [list(value) for value in sorted(row['add'])],
                        'havocEligibilityVariants': sorted(row['havoc']),
                        'potentialGarbageSealVariants': [[list(value) for value in variant] for variant in sorted(row['seal'])],
                        'jointSignatureCount': len(row['joint']),
                        'directAddHomogeneous': len(row['add']) == 1, 'havocEligibilityHomogeneous': len(row['havoc']) == 1,
                        'potentialGarbageSealHomogeneous': len(row['seal']) == 1, 'jointHomogeneous': len(row['joint']) == 1})
    categories = []
    for g in ('220', '211', '202', '210', '201', '200'):
        ns = sorted({key[1] for key in buckets['G_N'] if key[0] == g})
        categories.append({'G': g, 'allowedN': ns, 'allowedTWithS0': ns, 'allowedTWithS1': [n + 1 for n in ns],
                           'GNSLabels': 2 * len(ns), 'terminal': g == '220'})
    paths = ('scripts/check_strategy_classification.py', 'scripts/analyze_upper_state_projection.py',
             'src/core/rules.ts', 'src/core/catalog.ts', 'src/core/validation.ts',
             'research/upper-state-havoc-check.json', 'scripts/check_upper_state_havoc.ts')
    return {'schemaVersion': 1, 'auditedOn': '2026-11-03',
            'definitions': {'G': 'Two ordinaryT7 identity class220/211/202/210/201/200',
                            'N': 'Ordinary unsealed affix count', 'S': 'Ordinary Despair sealed-slot occupancy0or1',
                            'T': 'N+S; excludes primordialT8/corrupted extra slots',
                            'presentTargetMask': 'A=1,B=2; ordinary identity present at any tier, not justT7'},
            'population': {'ordinaryStructureRepresentatives': ordinary_representatives,
                           'flagReplicas': 2 * ordinary_representatives, 'targetSideContexts': 4,
                           'additionalPhysicalGameStatesVerified': 0,
                           'sealFlagAssumption': 'Only an orthogonal flag with fresh non-target sealed identity; level/protection/weight-pool effects are not modeled'},
            'categories': categories, 'projectionSummaries': {level: summarize(buckets[level]) for level in all_levels},
            'contexts': contexts, 'GNSBucketDetails': details, 'witnesses': witnesses(),
            'qualifications': ['The signatures test only side-capacity/ID-absence additions, four-slot Havoc eligibility and potential tier1..4 non-target seals.',
                               'No game probabilities or FP were computed; the existing production-kernel evidence is referenced separately.',
                               'Homogeneous tested signatures are necessary checks, not proof of Markov lumpability or equal transition/cost distributions.',
                               'Counts are across all four target-side contexts; with one fixed context the most-refined tested label set has56or60 labels, not232.',
                               'Base/model/target can be fixed external context, but native order, actual IDs, tiers, sealed identity, protections and roll requirements remain relevant to particular macros.'],
            'inputSha256': {path: digest(path) for path in paths}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    report = build()
    content = (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')
    if args.verify_only:
        if OUTPUT.read_bytes() != content:
            raise ValueError('Saved upper-state projection is stale')
    else:
        OUTPUT.write_bytes(content)
    print(json.dumps({'labels': {level: report['projectionSummaries'][level]['labels'] for level in LEVELS},
                      'GNSHeterogeneous': report['projectionSummaries']['G_N_S']['heterogeneousJointBuckets'],
                      'GNSActiveHeterogeneous': report['projectionSummaries']['G_N_S']['heterogeneousActiveJointBuckets'],
                      'GNSAfterTerminalMerge': report['projectionSummaries']['G_N_S']['labelsAfterMerging220IntoOneTerminal'],
                      'verifiedOnly': args.verify_only}))


if __name__ == '__main__':
    main()
