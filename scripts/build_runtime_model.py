"""Project the audited snapshot into a self-contained, versioned browser model."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/game/1.5.3'
OUTPUT = ROOT / 'src/generated/model.json'


def read(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def encode(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def compile_model() -> dict:
    manifest = read(SOURCE / 'manifest.json')
    legacy = read(ROOT / 'research/legacy-forge-compatibility.json')
    if legacy['gameVersion'] != manifest['gameVersion'] or legacy['steamBuildId'] != manifest['steamBuildId']:
        raise ValueError('Forge compatibility audit version mismatch')
    for name, entry in manifest['artifacts'].items():
        if hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError(f'Audited input changed: {name}')
    affixes = []
    for row in read(SOURCE / 'affixes.json')['affixes']:
        d = row['definition']
        affixes.append({'id': row['id'], 'name': d.get('affixDisplayName') or d['affixName'],
                        'side': d['type'], 'special': d['specialAffixType'],
                        'canRollOn': d['canRollOn'], 'classSpecificity': d['classSpecificity'],
                        'levelRequirement': d['levelRequirement'], 'weight': d['weighting'],
                        'overrides': [{'equipmentType': x['equipmentType'], 'weight': x['weighting']}
                                      for x in d['specificRerollChances']],
                        'tiers': d['tiers'], 'rollsOn': d['rollsOn']})
    items = read(SOURCE / 'items.json')
    types = {row['id']: row['definition'] for row in items['itemTypes']}
    bases = []
    for row in items['bases']:
        d, t = row['definition'], types[row['baseTypeId']]
        bases.append({'id': row['id'], 'name': d.get('displayName') or d['name'],
                      'baseType': row['baseTypeId'], 'subType': row['subTypeId'],
                      'equipmentType': t['type'], 'typeName': t.get('displayName') or t['BaseTypeName'],
                      'maxAffixes': t['maximumAffixes'], 'levelRequirement': d['levelRequirement'],
                      'classRequirement': d['classRequirement'], 'subClassRequirement': d['subClassRequirement'],
                      'corrupted': bool(d['isCorruptedSubtype']), 'legacy': bool(d['isLegacySubType']),
                      'obsolete': bool(d['obsoleteItem']),
                      'ordinaryEquipment': row['baseTypeId'] in set(range(25)) - {11, 24}})
    model = {'schemaVersion': 1, 'gameVersion': manifest['gameVersion'],
             'steamBuildId': manifest['steamBuildId'], 'dataRevision': manifest['dataRevision'],
             'rngModel': 'DISPLAY_PARAMETERS_INDEPENDENT_DRAWS_V1',
             'qualification': 'Audited native control flow, binary64 representations of nominal displayed thresholds, normalized current craft weights and uniform changed Havoc layouts; not client PRNG replay.',
             'materials': 'UNLIMITED', 'fpMaximum': 63,
             'practicalPolicy': read(ROOT / 'src/core/policy.json'),
             'legacyForgeIds': legacy['rule']['existingAttributeOverrideIds'],
             'parameters': {'hope': 0.25, 'ice': 0.3, 'critical': 0.12, 'blood': 0.3,
                            'luckyCost': 0.285, 'lowFpPreservation': 0.05,
                            'sealMultipliers': [0.7, 0.46, 0.23, 0.1]},
             'evidence': ['research/affix-action-claims.json', 'research/forge-fp-claims.json',
                          'research/7710-native-claims.json', 'research/legacy-forge-compatibility.json',
                          'research/crafting-level-claims.json'],
             'affixes': affixes, 'bases': bases}
    model['evidenceHashes'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in model['evidence']}
    model['implementationHashes'] = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                                     for path in sorted((ROOT / 'src/core').glob('*.ts')) if not path.name.endswith('.test.ts')}
    model['modelId'] = 'le-' + manifest['gameVersion'] + '-iid-' + hashlib.sha256(encode(model)).hexdigest()[:16]
    return model


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    model = compile_model()
    content = encode(model)
    if args.verify_only:
        if not OUTPUT.is_file() or OUTPUT.read_bytes() != content:
            raise ValueError('Runtime model is stale; explicitly run scripts/build_runtime_model.py and review changes')
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(content)
    print(json.dumps({'modelId': model['modelId'], 'affixes': len(model['affixes']),
                      'bases': len(model['bases']), 'bytes': len(content), 'verifiedOnly': args.verify_only}))


if __name__ == '__main__':
    main()
