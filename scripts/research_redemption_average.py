"""Recompute explicitly weighted one-cast Redemption averages from local resources.

Python standard library only. This does not import the production solver or
assume an unchanged per-cast success probability on repeated Redemption casts.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from fractions import Fraction
from functools import lru_cache
import hashlib
from itertools import combinations
import json
import math
from pathlib import Path
import struct


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'research/redemption-average.json'
ORDINARY_TYPES = frozenset(range(25)) - {11, 24}


def read(relative: str):
    return json.loads((ROOT / relative).read_text(encoding='utf-8'))


def digest(relative: str) -> str:
    return hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()


def class_matches(requirement: int, specificity: int) -> bool:
    return bool(requirement == 31 or specificity == 0 or
                (requirement == 0 and specificity & 1) or ((requirement << 1) & specificity))


def craft_weight(definition: dict, equipment_type: int) -> float:
    weight = definition['weighting']
    for override in definition['specificRerollChances']:
        if override['equipmentType'] == equipment_type:
            weight = override['weighting']
            break
    if weight < 1:
        weight = min(1.0, struct.unpack('<f', struct.pack('<f', 2 * weight))[0])
    return weight


@lru_cache(maxsize=None)
def mean_both_new(weights: tuple[float, ...]) -> float:
    """Mean over uniformly chosen ordered distinct starting same-side IDs x,y."""
    n, total = len(weights), math.fsum(weights)
    if n < 4:
        raise ValueError('Need two old and at least two missing identities per side')
    return math.fsum(
        1 - math.fsum(x * u / ((total - x - y) * (total - u - y))
                      for ui, u in enumerate(weights) if ui not in (xi, yi))
        for xi, x in enumerate(weights) for yi, y in enumerate(weights) if xi != yi
    ) / (n * (n - 1))


def exact_cast(initial: tuple[int, ...], indices: tuple[int, ...], pool: dict[int, dict]):
    distribution = {initial: Fraction(1)}
    for index in indices:
        updated = defaultdict(Fraction)
        for ids, probability in distribution.items():
            side = pool[ids[index]]['side']
            eligible = [entry for identity, entry in pool.items() if entry['side'] == side and identity not in ids]
            total = sum((entry['weight'] for entry in eligible), Fraction())
            for entry in eligible:
                changed = list(ids)
                changed[index] = entry['id']
                updated[tuple(changed)] += probability * entry['weight'] / total
        distribution = updated
    if sum(distribution.values(), Fraction()) != 1:
        raise ValueError('Probability mass was not conserved')
    return distribution


def check_small_models() -> dict:
    uniform_checks = []
    for n in (4, 5, 19, 50):
        observed = mean_both_new((1.0,) * n)
        expected = (n - 3) / (n - 2)
        if abs(observed - expected) > 2e-15:
            raise ValueError('Uniform same-side closed form disagrees')
        uniform_checks.append({'poolSize': n, 'bothNew': observed,
                               'specifiedMissingPairProbability': observed / math.comb(n - 2, 2),
                               'closedFormSpecifiedPair': 2 / (n - 2) ** 2})
    pool = {i: {'id': i, 'side': int(i >= 4), 'weight': Fraction(weight)}
            for i, weight in enumerate((1, 2, 3, 4, 2, 3, 5, 7))}
    start = (0, 1, 4, 5)
    remaining = set(pool) - set(start)
    target_pairs = list(combinations(sorted(remaining), 2))
    cast_checks = []
    for indices in combinations(range(4), 2):
        distribution = exact_cast(start, indices, pool)
        enumerated = sum((probability for ids, probability in distribution.items()
                          if all(ids[index] in remaining for index in indices)), Fraction()) / len(target_pairs)
        sides = [pool[start[index]]['side'] for index in indices]
        if sides[0] != sides[1]:
            closed = Fraction(1, len(target_pairs))
        else:
            x, y = (pool[start[index]]['weight'] for index in indices)
            weights = [entry['weight'] for entry in pool.values() if entry['side'] == sides[0]]
            total = sum(weights, Fraction())
            old_ids = {start[index] for index in indices}
            return_old = sum((x * entry['weight'] / ((total - x - y) * (total - entry['weight'] - y))
                              for entry in pool.values() if entry['side'] == sides[0] and entry['id'] not in old_ids), Fraction())
            closed = (1 - return_old) / len(target_pairs)
        if enumerated != closed:
            raise ValueError('Independent exact toy enumeration disagrees with closed form')
        cast_checks.append({'t7Indices': list(indices), 'exactMean': str(enumerated), 'mass': '1'})
    return {'uniformChecks': uniform_checks, 'unequalWeightExactEnumeration': cast_checks}


def build_report() -> dict:
    manifest = read('data/game/1.5.3/manifest.json')
    for filename in ('affixes.json', 'items.json'):
        if digest('data/game/1.5.3/' + filename) != manifest['artifacts'][filename]['sha256']:
            raise ValueError('Frozen local resource hash differs: ' + filename)
    affixes = read('data/game/1.5.3/affixes.json')['affixes']
    items = read('data/game/1.5.3/items.json')
    bases = [base for base in items['bases'] if base['baseTypeId'] in ORDINARY_TYPES]
    counts = Counter((base['baseTypeId'], base['definition']['classRequirement']) for base in bases)
    type_definitions = {entry['id']: entry['definition'] for entry in items['itemTypes']}

    def pools(equipment_type: int, requirement: int):
        result = ([], [])
        for affix in affixes:
            definition = affix['definition']
            if (definition['specialAffixType'] == 0 and definition['type'] in (0, 1) and
                    equipment_type in definition['canRollOn'] and class_matches(requirement, definition['classSpecificity'])):
                weight = craft_weight(definition, equipment_type)
                if weight > 0:
                    result[definition['type']].append({'id': affix['id'], 'name': definition['affixName'],
                                                       'side': definition['type'], 'weight': weight})
        return result

    groups = []
    for (equipment_type, requirement), count in sorted(counts.items()):
        prefix, suffix = pools(equipment_type, requirement)
        np, ns = len(prefix), len(suffix)
        hp = mean_both_new(tuple(sorted(entry['weight'] for entry in prefix)))
        hs = mean_both_new(tuple(sorted(entry['weight'] for entry in suffix)))
        a, b = np - 2, ns - 2
        total_pairs = math.comb(a + b, 2)
        success_mass = (hp + hs + 4) / (6 * total_pairs)
        match_mass = (math.comb(a, 2) + math.comb(b, 2) + 4 * a * b) / (6 * total_pairs)
        groups.append({'equipmentType': equipment_type, 'typeName': type_definitions[equipment_type]['displayName'],
                       'classRequirement': requirement, 'baseCount': count, 'prefixCount': np, 'suffixCount': ns,
                       'prefixWeightTotal': math.fsum(entry['weight'] for entry in prefix),
                       'suffixWeightTotal': math.fsum(entry['weight'] for entry in suffix),
                       'meanBothNewWithTwoPrefixT7': hp, 'meanBothNewWithTwoSuffixT7': hs,
                       'missingTargetPairsPerStartingItem': total_pairs,
                       'oneCastMean': success_mass, 'sideMatchingEventProbability': match_mass,
                       'oneCastMeanGivenSideMatchingWithinGroup': success_mass / match_mass,
                       'positionBalancedMatchingTargetMean': (hp / math.comb(a, 2) + hs / math.comb(b, 2) + 4 / (a * b)) / 6})

    def aggregate(weighted_groups):
        denominator = math.fsum(weight for _, weight in weighted_groups)
        probability = math.fsum(group['oneCastMean'] * weight for group, weight in weighted_groups) / denominator
        matching = math.fsum(group['sideMatchingEventProbability'] * weight for group, weight in weighted_groups) / denominator
        return {'oneCastMean': probability, 'oneCastMeanPercent': 100 * probability,
                'sideMatchingEventProbability': matching,
                'oneCastMeanGivenSideMatching': probability / matching,
                'oneCastMeanGivenSideMatchingPercent': 100 * probability / matching,
                'reciprocalOfOneCastMeanNotExpectedRetryCount': 1 / probability}

    base_equal = aggregate([(group, group['baseCount']) for group in groups])
    type_counts = Counter(base['baseTypeId'] for base in bases)
    type_equal = aggregate([(group, group['baseCount'] / type_counts[group['equipmentType']]) for group in groups])
    glove_prefix, glove_suffix = pools(4, 0)
    glove_pool = {entry['id']: {**entry, 'weight': Fraction(entry['weight'])} for entry in glove_prefix + glove_suffix}
    distribution = exact_cast((2, 26, 7, 10), (0, 1), glove_pool)
    fixture_probability = sum((probability for ids, probability in distribution.items() if set(ids[:2]) == {4, 5}), Fraction())
    expected_fixture = Fraction(140737488355328, 16257994501799281)
    if fixture_probability != expected_fixture:
        raise ValueError('Current glove fixture did not match independent existing Fraction reference')
    source_paths = ('data/game/1.5.3/affixes.json', 'data/game/1.5.3/items.json', 'data/game/1.5.3/manifest.json',
                    'research/affix-action-claims.json', 'scripts/research_redemption_average.py')
    return {'schemaVersion': 1, 'auditedOn': '2026-11-03', 'gameVersion': manifest['gameVersion'],
            'steamBuildId': manifest['steamBuildId'], 'dataRevision': manifest['dataRevision'],
            'model': 'CURRENT_FLOAT32_CRAFT_WEIGHTS_NORMALIZED_INDEPENDENT_DRAWS',
            'evaluation': 'FINITE_SUMS_NO_MONTE_CARLO_BINARY64_AGGREGATION',
            'actualClientTests': 0, 'nativeGridBitExact': False,
            'population': {'ordinaryEquipmentTypes': len(type_counts), 'cataloguedOrdinaryBases': len(bases), 'poolGroups': len(groups),
                           'baseSelection': 'UNIFORM_OVER_ALL_565_FROZEN_ORDINARY_BASES_INCLUDING_LEGACY_OR_NON_DROPPING_ENTRIES',
                           'startingIds': 'UNIFORM_DISTINCT_TWO_PREFIX_AND_TWO_SUFFIX_STANDARD_POSITIVE_CRAFT_WEIGHT_IDS',
                           't7Placement': 'UNIFORM_OVER_SIX_UNORDERED_POSITION_PAIRS',
                           'targetPair': 'UNIFORM_UNORDERED_LEGAL_STANDARD_ID_PAIRS_ABSENT_FROM_ALL_FOUR_STARTING_IDS',
                           'sideMatchingConditional': 'CONDITION_THE_ENTIRE_BASE_EQUAL_POPULATION_ON_TARGET_SIDES_MATCHING_T7_SIDES; BASE_WEIGHTS_THEREFORE_CHANGE',
                           'tiers': ['7732', '7744'], 'additionalSealedAffixes': 0,
                           'naturalDropOrPlayerTargetDistribution': False},
            'baseEqual': base_equal, 'typeEqualWithBasesUniformWithinType': type_equal,
            'sameFor7732And7744OneCast': True,
            'fixtureCheck': {'baseId': '4:0', 'initialIds': [2, 26, 7, 10], 'targetIds': [4, 5],
                             'probabilityFraction': str(fixture_probability), 'probability': float(fixture_probability),
                             'probabilityPercent': 100 * float(fixture_probability), 'exitStates': len(distribution), 'mass': '1'},
            'sameFixtureTargetWeightExamples': [
                {'targetIds': list(target), 'targetNames': [glove_pool[identity]['name'] for identity in target],
                 'craftWeights': [float(glove_pool[identity]['weight']) for identity in target],
                 'probability': float(sum((probability for ids, probability in distribution.items()
                                            if set(ids[:2]) == set(target)), Fraction()))}
                for target in ((4, 5), (83, 503))],
            'mathChecks': check_small_models(), 'groups': groups,
            'inputSha256': {relative: digest(relative) for relative in source_paths},
            'limitations': ['Not a concrete-target upper bound and not safe for proving a whole route infeasible.',
                            'One cast only; no FP exhaustion, repeated casts, seal/removal/Chaos/Havoc alternatives, or roll targets.',
                            'Repeated Redemption updates identities and exclusion pools; 1/p is not its expected attempt count.',
                            'Current frozen-code audit is reused; this script does not disassemble the installed DLL again.',
                            'Uniform initial and target identities are a synthetic averaging convention, not player demand or loot frequencies.',
                            'The average does not represent only rare skill-affix targets.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    report = build_report()
    encoded = (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
    if args.verify_only:
        if OUTPUT.read_bytes() != encoded:
            raise ValueError('Saved Redemption average is stale')
    else:
        OUTPUT.write_bytes(encoded)
    print(json.dumps({'baseEqual': report['baseEqual'], 'typeEqual': report['typeEqualWithBasesUniformWithinType'],
                      'fixture': report['fixtureCheck'], 'verifiedOnly': args.verify_only}, ensure_ascii=False))


if __name__ == '__main__':
    main()
