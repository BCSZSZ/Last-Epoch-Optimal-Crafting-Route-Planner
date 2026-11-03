"""Serve the unchanged production bundles with a local, isolated memory-observation panel.

Run a Pages-base build first. Browser operations stay manual/through the approved UI tool.
The panel only observes the real application's existing Worker; it never drives crafting UI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PREFIX = '/Last-Epoch-Optimal-Crafting-Route-Planner/'
PANEL = r'''
<details id="memory-panel" open style="position:fixed;right:12px;bottom:12px;z-index:10000;background:#182630;color:#e1e8ec;border:1px solid #88d9c2;border-radius:10px;padding:12px;width:340px;max-width:90vw;font:12px system-ui">
<summary>研发验收：浏览器内存</summary><p id="memory-environment"></p>
<button id="memory-start">开始内存采样</button> <button id="memory-stop">停止内存采样</button> <button id="memory-export">导出内存记录</button>
<p id="memory-status">尚未开始</p><textarea id="memory-data" aria-label="内存测量原始记录" rows="5" style="width:100%" readonly></textarea>
</details><script>
(() => {
  const build = __BUILD__;
  const environment = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null, secureContext: isSecureContext,
    crossOriginIsolated, measurementApi: typeof performance.measureUserAgentSpecificMemory };
  const output = document.querySelector('#memory-data');
  const status = document.querySelector('#memory-status');
  document.querySelector('#memory-environment').textContent = `安全上下文 ${environment.secureContext} · 隔离 ${environment.crossOriginIsolated} · 内存API ${environment.measurementApi}`;
  let active = false;
  let measuring = false;
  let startedAt = 0;
  let samples = [];
  const progress = () => document.querySelector('.planning-controls')?.innerText?.slice(0, 220) ?? '';
  const report = () => ({ schemaVersion: 1, modelId: build.modelId, build, environment,
    measuredOn: new Date().toISOString(), active, measurementPending: measuring,
    scope: 'ACTUAL_PRODUCTION_APP_AND_WORKER_WITH_LOCAL_COOP_COEP_OBSERVER',
    qualification: 'Native browser memory estimates including workers. Each completed call may perform GC and affect timing. Maximum samples are observed post-GC sample maxima, not a proof of the allocation peak between samples. Not OS process RSS or a low-end-device emulation.',
    maximumTotalBytesObserved: samples.length ? Math.max(...samples.map(row => row.measurement.bytes)) : null,
    maximumWorkerExclusiveBytesObserved: samples.length ? Math.max(...samples.map(row => row.workerExclusiveBytes)) : null,
    samples });
  const publish = () => { output.value = JSON.stringify(report(), null, 2); };
  async function capture() {
    if (!active || measuring) return;
    measuring = true; publish();
    status.textContent = `等待浏览器测量，第 ${samples.length + 1} 次`;
    const begin = performance.now(); const startProgress = progress();
    try {
      const measurement = await performance.measureUserAgentSpecificMemory();
      const attributed = (measurement.breakdown ?? []).filter(row => (row.attribution ?? []).length === 1 && row.attribution[0].scope === 'DedicatedWorkerGlobalScope');
      samples.push({ beginMilliseconds: begin - startedAt, endMilliseconds: performance.now() - startedAt,
        startProgress, endProgress: progress(), workerExclusiveBytes: attributed.reduce((sum, row) => sum + row.bytes, 0), measurement });
      status.textContent = `${samples.length} 个样本；应用 ${(measurement.bytes / 1048576).toFixed(2)} MiB，Worker单独归属 ${(samples.at(-1).workerExclusiveBytes / 1048576).toFixed(2)} MiB`;
    } catch (error) { active = false; status.textContent = `${error.name}: ${error.message}`; }
    finally { measuring = false; publish(); }
    if (active && samples.length < 30) setTimeout(capture, 500);
    else active = false;
  }
  document.querySelector('#memory-start').onclick = () => {
    if (measuring || active) return;
    samples = []; startedAt = performance.now(); active = true; capture();
  };
  document.querySelector('#memory-stop').onclick = () => { active = false; publish(); status.textContent += '；已停止，正在进行的测量完成后仍会保留'; };
  document.querySelector('#memory-export').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'last-epoch-browser-memory.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  publish();
})();
</script>
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4175)
    args = parser.parse_args()
    dist = ROOT / 'dist'
    if not (dist / 'index.html').is_file():
        raise FileNotFoundError('Build the production app first')
    build = {'modelId': json.loads((ROOT / 'src/generated/model.json').read_text(encoding='utf-8'))['modelId'],
             'artifacts': {path.relative_to(dist).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in sorted(dist.rglob('*')) if path.is_file()}}
    html = (dist / 'index.html').read_text(encoding='utf-8').replace('</body>', PANEL.replace('__BUILD__', json.dumps(build)) + '</body>').encode('utf-8')

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *items, **kwargs):
            super().__init__(*items, directory=str(dist), **kwargs)

        def end_headers(self):
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            super().end_headers()

        def do_GET(self):
            path = urlsplit(self.path).path
            if path in ('/', '/app/', '/index.html', PREFIX):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(html)))
                self.end_headers()
                self.wfile.write(html)
            else:
                if path.startswith(PREFIX):
                    self.path = '/' + self.path[len(PREFIX):]
                super().do_GET()

        def log_message(self, *_items):
            pass

    print(f'Isolated memory observer: http://127.0.0.1:{args.port}/app/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
