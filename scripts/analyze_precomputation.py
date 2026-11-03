"""Read-only capacity estimates for offline solver tables; not a production table generator."""
from __future__ import annotations

import hashlib
import itertools
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]


def f32(value):
    return struct.unpack('f', struct.pack('f', value))[0]


def main():
    model = json.loads((ROOT / 'src/generated/model.json').read_text(encoding='utf-8'))
    bases = [base for base in model['bases'] if base['ordinaryEquipment']]
    groups = sorted({(base['equipmentType'], base['classRequirement']) for base in bases})
    by_id = {row['id']: row for row in model['affixes']}

    def matches(requirement, specificity):
        return requirement == 31 or specificity == 0 or (requirement == 0 and specificity & 1) or ((requirement << 1) & specificity)

    def weight(row, equipment_type):
        raw = next((entry['weight'] for entry in row['overrides'] if entry['equipmentType'] == equipment_type), row['weight'])
        return min(1, f32(2 * raw)) if raw < 1 else raw

    summaries, literal_cells, ids_union, fingerprints = [], 0, set(), set()
    for equipment_type, requirement in groups:
        pool = [row for row in model['affixes'] if row['special'] == 0 and row['side'] in (0, 1)
                and equipment_type in row['canRollOn'] and matches(requirement, row['classSpecificity']) and weight(row, equipment_type) > 0]
        ids_union.update(row['id'] for row in pool)
        fingerprints.add(tuple((row['id'], weight(row, equipment_type)) for row in pool))
        # Restrict the literal-state count to definite legal T7, shard-bearing Standard IDs.
        subset = [row for row in pool if row['rollsOn'] == 0 and len(row['tiers']) >= 7]
        p, s = [sum(row['side'] == side for row in subset) for side in (0, 1)]
        identity_sets = math.comb(p, 2) * math.comb(s, 2)
        target_pairs = math.comb(p + s, 2)
        # Six T7 placements, 6^2 low-tier assignments, 24 native orders; no sealed/extra slots or rolls.
        cells = identity_sets * 216 * 24 * target_pairs
        literal_cells += cells
        summaries.append({'equipmentType': equipment_type, 'classRequirement': requirement,
                          'positiveStandardPrefixIds': sum(row['side'] == 0 for row in pool),
                          'positiveStandardSuffixIds': sum(row['side'] == 1 for row in pool),
                          'positiveDistinctWeights': len({weight(row, equipment_type) for row in pool}),
                          'literalSubsetPrefixIds': p, 'literalSubsetSuffixIds': s,
                          'literalItemIdentitySets': identity_sets, 'literalTargetPairs': target_pairs,
                          'literalStateTargetCells': cells})
    full = {tuple(sorted((7, 7, a, b))) for a in range(1, 7) for b in range(1, 7)}
    ordered = {tiers for multiset in full for tiers in itertools.permutations(multiset)}
    assert len(full) == 21 and len(ordered) == 216
    structural = json.loads((ROOT / 'research/strategy-classification-coverage.json').read_text(encoding='utf-8'))['abstractStateCount']
    assert structural == 8580
    scenarios = []
    for native_multiplier in (1, 24):
        for frontier_entries in (1, 4):
            rows = structural * 2 * 2 * native_multiplier * frontier_entries
            scenarios.append({'nativeOrderMultiplier': native_multiplier, 'frontierEntriesAssumed': frontier_entries,
                              'entryBytesAssumed': 64, 'entries': rows, 'rawBytes': rows * 64,
                              'rawMiB': rows * 64 / 2**20})
    source_paths = ['src/generated/model.json', 'src/core/levels.ts', 'src/core/rules.ts', 'src/core/catalog.ts',
                    'research/strategy-classification-coverage.json', 'scripts/analyze_precomputation.py']
    report = {'schemaVersion': 1, 'modelId': model['modelId'], 'scope': 'PRECOMPUTATION_CAPACITY_ANALYSIS_NOT_IMPLEMENTATION',
              'ordinaryBases': len(bases), 'typeClassPoolContexts': len(groups), 'distinctIdWeightPoolFingerprints': len(fingerprints),
              'ordinaryPositiveStandardIdsUnion': len(ids_union), 'maximumOrdinaryBaseLevel': max(base['levelRequirement'] for base in bases),
              'minimumLowTierMultisets': len(full), 'fourSlotOrderedTierLayouts': len(ordered),
              'canonicalStructuralRepresentatives': structural,
              'twoSealFlagsTwoCriticalRegimesStructuralProduct': structural * 2 * 2,
              'rawTableSizeScenarios': scenarios,
              'literalNoExtraSlotStateTargetCellsAcrossPoolContexts': literal_cells,
              'literalTableTwoFloat64Bytes': literal_cells * 16,
              'literalTableTwoFloat64TiB': literal_cells * 16 / 2**40,
              'iceFeeFactor': 1 - model['parameters']['ice'], 'normalCostCeilingNeededToRetainIce100': 100 / (1 - model['parameters']['ice']),
              'pools': summaries,
              'qualifications': ['Structural products are capacity scenarios, NOT a proof of exact state equivalence or a final table schema.',
                                 '64 bytes per entry and four Pareto entries are illustrative storage assumptions; no encoding/compression benchmark is claimed.',
                                 'Literal total sums itemType/class pool contexts: Standard shard-bearing T7-capable IDs, four ordinary affixes, exactly two T7s, other tiers1..6, unordered two-target choice and native orders. No seal, extra slot, protection, roll, player-level or base-subtype multiplication. This is the full audited API, not the minimal UI reference space.',
                                 'Effective kernel fingerprints may collapse pool contexts; the literal total enumerates contexts as requested inputs, not a minimum information-theoretic table size.',
                                 'Normal/ICE scaling applies to a fixed route under intrinsic no-balance rules, not necessarily to the chosen optimum after100FP filtering.'],
              'sourceSha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_paths}}
    destination = ROOT / 'research/precomputation-capacity.json'
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({key: report[key] for key in ['modelId', 'ordinaryBases', 'typeClassPoolContexts', 'distinctIdWeightPoolFingerprints',
          'ordinaryPositiveStandardIdsUnion', 'maximumOrdinaryBaseLevel', 'minimumLowTierMultisets', 'fourSlotOrderedTierLayouts',
          'twoSealFlagsTwoCriticalRegimesStructuralProduct', 'literalNoExtraSlotStateTargetCellsAcrossPoolContexts',
          'literalTableTwoFloat64TiB', 'rawTableSizeScenarios']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
