import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { MODEL_ID } from '../src/core/catalog';
import { reportRoute } from '../src/core/evaluation';
import { RuleEngine } from '../src/core/rules';
import type { Item, PlanRequest, Route } from '../src/core/types';

const cases = ['double_t7_havoc', '7710_direct', '7713_prepare', 'removal_then_fill', 'rare_redemption_onecast'];
const selected = process.argv.indexOf('--case');
const makeItem = (rows: number[][], fpType: Item['fpType']): Item => ({ baseId: '4:0', itemLevel: 100, corrupted: false, fpType,
  affixes: rows.map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: 128 })) });

function run(id: string) {
  const engine = new RuleEngine();
  const records = [];
  for (const fpType of ['NORMAL', 'ICE', 'BLOOD'] as const) {
    const start = performance.now();
    if (id === 'rare_redemption_onecast') {
      const result = engine.transition(makeItem([[2, 7], [26, 7], [7, 3], [10, 2]], fpType), 63,
        { kind: 'redemption', glyph: 'hope' }, { playerLevel: 100 });
      records.push({ fpType, milliseconds: performance.now() - start, states: result.outcomes.length,
        scope: 'SINGLE_ATOMIC_ACTION_ONLY', successScore: null });
      continue;
    }
    const rows = id === '7710_direct' ? [[7, 7], [10, 7], [2, 1]] :
      id === '7713_prepare' ? [[4, 7], [26, 7], [10, 1], [7, 3]] : [[4, 7], [5, 1], [7, 7], [10, 1]];
    const request: PlanRequest = { modelId: MODEL_ID, item: makeItem(rows, fpType), craftingContext: { playerLevel: 100 },
      target: { requirements: [4, 5].map((affix) => ({ ids: [affix], minTier: 7, maxTier: 7, slot: 'ordinary' })) },
      constraints: {}, scoring: {}, search: { milliseconds: 10000, maxRoutes: 100, macroStages: 12, maxStates: 100000 } };
    const final: Route['macros'][number] = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
    const route: Route = { id, macros: id === '7710_direct' ? [
      { kind: 'once', action: { kind: 'add', id: 4, glyph: 'hope' } },
      { kind: 'seal', selector: { side: 0, excludedIds: [4, 5], minTier: 1, maxTier: 4 } },
      { kind: 'once', action: { kind: 'add', id: 5, glyph: 'hope' } }, final,
    ] : id === '7713_prepare' ? [
      { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector: { side: 0, excludedIds: [4, 5], minTier: 1, maxTier: 1 } } },
      { kind: 'seal', selector: { side: 0, excludedIds: [4, 5], minTier: 1, maxTier: 1 } },
      { kind: 'once', action: { kind: 'add', id: 5, glyph: 'hope' } }, final,
    ] : id === 'removal_then_fill' ? [
      { kind: 'once', action: { kind: 'removal', glyph: 'hope', acceptedIds: [10] } },
      { kind: 'once', action: { kind: 'add', id: 8, glyph: 'hope' } }, final,
    ] : [final] };
    const result = reportRoute(engine, request, route);
    records.push({ fpType, milliseconds: performance.now() - start, states: result.states,
      scope: 'COMPLETE_FIXED_ROUTE_ALL_FP_0_TO_63', successScore: result.score });
  }
  return { id, records, peakRssMiB: process.resourceUsage().maxRSS / 1024 };
}

if (selected >= 0) {
  console.log(JSON.stringify(run(process.argv[selected + 1])));
} else {
  const samples = cases.map((id) => {
    const result = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--case', id], { encoding: 'utf8' });
    return JSON.parse(result);
  });
  const output = { schemaVersion: 1, measuredOn: '2026-11-03', modelId: MODEL_ID,
    scope: 'PHASE_2_NODE_ATOMIC_AND_KNOWN_MACRO_ROUTES_NOT_FULL_SOLVER_OR_BROWSER',
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, memoryGiB: totalmem() / 2 ** 30 },
    measurement: 'One cold child process per input; three FP types in declared order share rule-kernel cache. Import/model load and engine construction excluded from milliseconds; peak RSS includes the whole process. No warm repetitions or hardware emulation.',
    cases: samples };
  writeFileSync(new URL('../research/phase2-node-benchmark.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ modelId: MODEL_ID, cases: samples.length,
    maximumMilliseconds: Math.max(...samples.flatMap((entry) => entry.records.map((row: { milliseconds: number }) => row.milliseconds))),
    peakRssMiB: Math.max(...samples.map((entry) => entry.peakRssMiB)),
    limitation: 'Node known routes only; browser and full solver remain unmeasured.' }));
}
