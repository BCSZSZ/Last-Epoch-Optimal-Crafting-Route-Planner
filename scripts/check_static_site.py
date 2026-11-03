"""Verify the live Pages build against local static artifacts, without browser automation."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    args = parser.parse_args()
    base = args.url.rstrip('/') + '/'
    path_prefix = urlparse(base).path
    checks = []
    for local in sorted((ROOT / 'dist').rglob('*')):
        if not local.is_file():
            continue
        relative = local.relative_to(ROOT / 'dist').as_posix()
        url = urljoin(base, relative)
        with urlopen(Request(url, headers={'User-Agent': 'LE-Crafting-Static-Validation/0.1'}), timeout=30) as response:
            data = response.read()
            mime = response.headers.get_content_type()
            status = response.status
        expected = local.read_bytes()
        if data != expected:
            raise ValueError(f'Live bytes differ from audited local build: {relative}')
        if relative.endswith('.js') and mime not in ('application/javascript', 'text/javascript'):
            raise ValueError(f'Incorrect JavaScript MIME: {relative}: {mime}')
        if relative == 'index.html':
            assets = re.findall(r'(?:src|href)="([^"]+\.(?:js|css))"', data.decode())
            if not assets or not all(asset.startswith(path_prefix + 'assets/') for asset in assets):
                raise ValueError('Index does not use the repository subpath')
        checks.append({'file': relative, 'url': url, 'status': status, 'contentType': mime,
                       'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    report = {'schemaVersion': 1, 'checkedAt': datetime.now(timezone.utc).isoformat(),
              'site': base, 'modelId': json.loads((ROOT / 'src/generated/model.json').read_text(encoding='utf-8'))['modelId'],
              'status': 'PASS', 'checks': checks,
              'qualification': 'HTTP byte identity and repository subpath only. Actual UI and Worker behavior are checked separately in the browser.'}
    (ROOT / 'research/static-deployment.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
