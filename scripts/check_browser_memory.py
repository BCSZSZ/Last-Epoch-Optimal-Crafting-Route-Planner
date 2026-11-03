"""Check actual browser memory observations and their exact input/build context."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def check(require_live_match=False, allow_historical=False):
    folder = ROOT / 'research/browser-memory'
    memory = json.loads((folder / '7710-normal-memory.json').read_text(encoding='utf-8'))
    request = json.loads((folder / '7710-normal-input.json').read_text(encoding='utf-8'))
    plan = json.loads((folder / '7710-normal-plan.json').read_text(encoding='utf-8'))
    model = json.loads((ROOT / 'src/generated/model.json').read_text(encoding='utf-8'))
    historical = memory['modelId'] != model['modelId']
    if historical:
        if not allow_historical:
            raise ValueError('Historical observation requires --allow-historical; it is not current-release memory evidence')
        manifest = json.loads((ROOT / 'research/runtime-model-archive/manifest.json').read_text(encoding='utf-8'))
        archived = manifest['models'][memory['modelId']]
        archive_path = (ROOT / archived['file']).resolve()
        if not archive_path.is_relative_to((ROOT / 'research/runtime-model-archive').resolve()) or hashlib.sha256(archive_path.read_bytes()).hexdigest() != archived['sha256']:
            raise ValueError('Invalid historical model archive')
    if len({memory['modelId'], request['modelId'], plan['modelId']}) != 1:
        raise ValueError('Input, browser and plan model versions differ')
    if memory['active'] or memory['measurementPending']:
        raise ValueError('Measurement did not finish')
    if not memory['environment']['secureContext'] or not memory['environment']['crossOriginIsolated']:
        raise ValueError('Native memory observation lacks required isolation')
    observations = []
    active_observations = 0
    worker_urls = set()
    for sample in memory['samples']:
        native = sample['measurement']
        if sum(entry['bytes'] for entry in native['breakdown']) != native['bytes']:
            raise ValueError('Browser memory breakdown does not sum to its total')
        exclusive = 0
        for entry in native['breakdown']:
            attribution = entry.get('attribution', [])
            if len(attribution) == 1 and attribution[0].get('scope') == 'DedicatedWorkerGlobalScope':
                url = attribution[0]['url']
                asset = 'assets/' + Path(urlsplit(url).path).name
                if not asset.startswith('assets/planner.worker-') or asset not in memory['build']['artifacts']:
                    raise ValueError('Observed Worker is not the recorded production artifact')
                worker_urls.add(url)
                exclusive += entry['bytes']
        if exclusive != sample['workerExclusiveBytes'] or sample['beginMilliseconds'] > sample['endMilliseconds']:
            raise ValueError('Invalid attributed memory or observation timing')
        if '正在比较路线' in sample['startProgress'] or '正在比较路线' in sample['endProgress']:
            active_observations += 1
        observations.append(native['bytes'])
    if not observations or not worker_urls or not active_observations:
        raise ValueError('No actual planning/Worker memory observation')
    maximum = max(observations)
    worker_maximum = max(sample['workerExclusiveBytes'] for sample in memory['samples'])
    if maximum != memory['maximumTotalBytesObserved'] or worker_maximum != memory['maximumWorkerExclusiveBytesObserved']:
        raise ValueError('Published sample maxima do not match observations')
    if require_live_match:
        live = json.loads((ROOT / 'research/static-deployment.json').read_text(encoding='utf-8'))
        if live['modelId'] != memory['modelId']:
            raise ValueError('Live build model differs')
        live_artifacts = {entry['file']: entry['sha256'] for entry in live['checks']}
        for name, fingerprint in memory['build']['artifacts'].items():
            if name != 'index.html' and live_artifacts.get(name) != fingerprint:
                raise ValueError('Observed JS/CSS/Worker bytes differ from live static validation')
    return {'status': 'PASS', 'modelId': memory['modelId'], 'currentModelId': model['modelId'], 'historical': historical, 'samples': len(observations),
            'samplesOverlappingPlanning': active_observations, 'workerUrls': sorted(worker_urls),
            'maximumTotalMiBObserved': maximum / 2 ** 20, 'maximumWorkerExclusiveMiBObserved': worker_maximum / 2 ** 20,
            'requestScope': request['search'], 'evaluatedRoutes': plan['search']['evaluatedRoutes'],
            'planningMillisecondsWithObserver': plan['search']['elapsedMilliseconds'],
            'liveBytesChecked': require_live_match,
            'qualification': 'Native post-GC memory estimates and observed maxima under local COOP/COEP. Not an allocation peak between samples, OS RSS, or low-end hardware.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-live-match', action='store_true')
    parser.add_argument('--write-report', action='store_true')
    parser.add_argument('--allow-historical', action='store_true')
    args = parser.parse_args()
    result = check(args.require_live_match, args.allow_historical)
    if args.write_report:
        (ROOT / 'research/browser-memory/validation.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(result, ensure_ascii=False))
