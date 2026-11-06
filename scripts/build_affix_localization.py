"""Build standalone ID-indexed Chinese UI names; never change mechanics or weights."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/localization/affix-names-source.json'
MODEL = ROOT / 'src/generated/model.json'


def build() -> dict[str, bytes]:
    source_bytes, model_bytes = SOURCE.read_bytes(), MODEL.read_bytes()
    source, model = json.loads(source_bytes), json.loads(model_bytes)
    rows = {row['id']: row for row in source['affixes']}
    if len(rows) != len(source['affixes']) or set(rows) != {row['id'] for row in model['affixes']}:
        raise ValueError('Translation IDs do not exactly match the audited affix snapshot')
    differences = []
    for actual in model['affixes']:
        row = rows[actual['id']]
        for key in ['side', 'special', 'classSpecificity']:
            if row[key] != actual[key]:
                raise ValueError(f"Affix {row['id']} changed {key}; translation requires review")
        if set(row['canRollOn']) != set(actual['canRollOn']):
            raise ValueError(f"Affix {row['id']} changed equipment eligibility")
        if not re.search(r'[\u4e00-\u9fff]', row['zh']):
            raise ValueError(f"Affix {row['id']} has no Chinese display name")
        if row['en'] != actual['name']:
            differences.append(row['id'])
    digest = hashlib.sha256(source_bytes).hexdigest()
    data = {'schemaVersion': 1, 'locale': 'zh-CN', 'sourceSha256': digest,
            'names': {str(identity): rows[identity]['zh'] for identity in sorted(rows)}}
    report = {'schemaVersion': 1, 'status': 'PASS', 'modelId': model['modelId'],
              'locale': 'zh-CN', 'affixes': len(rows), 'translated': len(rows), 'missing': [],
              'structuralMismatches': [], 'englishDisplayNameDifferences': differences,
              'sourceVersion': source['sourceVersion'], 'sourceSha256': digest,
              'modelSha256': hashlib.sha256(model_bytes).hexdigest(), 'sources': source['sources'],
              'qualification': source['qualification']}
    return {'src/generated/affix-names.zh-CN.json': (json.dumps(data, ensure_ascii=False, separators=(',', ':'))+'\n').encode(),
            'research/affix-localization.json': (json.dumps(report, ensure_ascii=False, indent=2)+'\n').encode()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    outputs = build()
    for name, content in outputs.items():
        path = ROOT / name
        if args.verify_only:
            if not path.is_file() or path.read_bytes() != content:
                raise ValueError(f'Stale localization: {name}')
        else:
            path.write_bytes(content)
    report = json.loads(outputs['research/affix-localization.json'])
    print(json.dumps({'status': 'PASS', 'translated': report['translated'], 'verifiedOnly': args.verify_only}))


if __name__ == '__main__':
    main()
