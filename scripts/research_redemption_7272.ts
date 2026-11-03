/** Replays the published 7272 controller; compares input assumptions and real weights.
 * Research only: same production rules, no change to thresholds or the model.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Catalog, MODEL_ID, snapshot } from '../src/core/catalog';
import { catalogForInputModel } from '../src/core/input-model';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { RuleEngine } from '../src/core/rules';
import type { InputModel, Item, PlanRequest, Route } from '../src/core/types';

const sourcePath = 'research/fixtures/redemption-7272-public-input.json';
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const request: PlanRequest = source.input;
const route: Route = source.route;
const middle = (value: { lower: number; upper: number } | null) => value && (value.lower + value.upper) / 2;
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function pool(catalog: Catalog, item: Item, side: 0 | 1) {
  return catalog.model.affixes.filter(row => row.side === side && row.special === 0 && catalog.canRollOn(row.id, item.baseId))
    .map(row => ({ id: row.id, name: row.name, weight: catalog.craftWeight(row.id, item.baseId) }))
    .filter(row => row.weight > 0);
}
function replaceGoals(original: Route, oldIds: readonly number[], newIds: readonly number[]): Route {
  // The exported controller stores its IDs in id/ids/excludedIds fields only.
  const replace = (value: unknown, key = ''): unknown => {
    if (typeof value === 'number' && ['id', 'ids', 'excludedIds'].includes(key)) {
      const at = oldIds.indexOf(value); return at < 0 ? value : newIds[at];
    }
    if (Array.isArray(value)) return value.map(entry => replace(entry, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v, k)]));
    return value;
  };
  return replace(original) as Route;
}
function run(mode: InputModel, label: string, ids = [6, 10], baseId = request.item.baseId) {
  const catalog = catalogForInputModel(mode), engine = new RuleEngine(catalog);
  const req: PlanRequest = { ...request, item: { ...request.item, baseId }, inputModel: mode, search: { ...request.search, maxStates: 200000 },
    target: { ...request.target, requirements: request.target.requirements.map((entry, i) => ({ ...entry, ids: [ids[i]] })) } };
  const selected = replaceGoals(route, [6, 10], ids);
  const started = performance.now();
  const report = evaluateIntrinsic(new IntrinsicWorkspace(engine, req), selected, undefined, true);
  const p = middle(report.score)!;
  const result = { label, inputModel: mode, baseId, targetIds: ids,
    targets: ids.map(id => ({ id, name: catalog.affix(id).name, weight: catalog.craftWeight(id, req.item.baseId) })),
    pools: [pool(catalog, req.item, 0), pool(catalog, req.item, 1)],
    score: report.score, expectedFpGivenSuccess: report.expectedFpGivenSuccess,
    successfulFpLowerBound: report.intrinsic.successfulFpLowerBound,
    stageFpGivenFinalSuccess: report.intrinsic.stages.map(row => middle(row.successfulFpMoment)! / p),
    states: report.states, report };
  process.stdout.write(JSON.stringify({ ...result, pools: result.pools.map(rows => ({ count: rows.length, totalWeight: rows.reduce((sum, row) => sum + row.weight, 0) })), report: undefined, milliseconds: performance.now() - started }) + '\n');
  return result;
}

const equal = run('FORGEABLE_EQUAL', 'PUBLISHED_EQUAL');
assert(Math.abs(middle(equal.score)! - 0.7034782607) < 1e-8);
assert(Math.abs(middle(equal.expectedFpGivenSuccess)! - 82.67725552) < 1e-6);
const weighted = run('FORGEABLE_WEIGHTED', 'SAME_IDS_REAL_WEIGHTS_ALL_CLASSES');
const audited = run('AUDITED', 'SAME_IDS_REAL_WEIGHTS_EXACT_BASE');
const real = new Catalog();
const prefix = pool(real, request.item, 0).filter(row => !request.item.affixes.some(affix => affix.id === row.id));
const suffix = pool(real, request.item, 1).filter(row => !request.item.affixes.some(affix => affix.id === row.id));
const rarePrefix = [...prefix].sort((a, b) => a.weight - b.weight || a.id - b.id)[0];
const rareSuffix = [...suffix].sort((a, b) => a.weight - b.weight || a.id - b.id)[0];
const rare = run('AUDITED', 'RAREST_MISSING_PAIR_REAL_WEIGHTS_EXACT_BASE', [rarePrefix.id, rareSuffix.id]);
const gloveItem = { ...request.item, baseId: '4:0' };
assert(gloveItem.affixes.every(row => real.canRollOn(row.id, gloveItem.baseId)));
const glovePools = ([0, 1] as const).map(side => pool(real, gloveItem, side)
  .filter(row => !gloveItem.affixes.some(affix => affix.id === row.id)));
const commonGloveIds = glovePools.map(rows => [...rows].sort((a,b) => b.weight - a.weight || a.id - b.id)[0].id);
const rareGloveIds = glovePools.map(rows => [...rows].sort((a,b) => a.weight - b.weight || a.id - b.id)[0].id);
const gloveCommonEqual = run('FORGEABLE_EQUAL', 'GLOVES_COMMON_PAIR_EQUAL_ALL_CLASSES', commonGloveIds, '4:0');
const gloveCommon = run('AUDITED', 'GLOVES_COMMON_PAIR_REAL_WEIGHTS', commonGloveIds, '4:0');
const gloveRareEqual = run('FORGEABLE_EQUAL', 'GLOVES_RARE_PAIR_EQUAL_ALL_CLASSES', rareGloveIds, '4:0');
const gloveRare = run('AUDITED', 'GLOVES_RARE_PAIR_REAL_WEIGHTS', rareGloveIds, '4:0');
const result = { schemaVersion: 1, date: '2026-11-03', modelId: MODEL_ID,
  qualification: 'Actual audited resources and production controller, independent-draw nominal probability model; no client crafting sample. Fixed Glass Catalyst19:0, normal potential, 7272, one new prefix and suffix. Not all equipment or a player-specific recommendation.',
  inputs: { sourceSha256: digest(sourcePath), modelSha256: digest('src/generated/model.json'), resourceSha256: digest('data/game/1.5.3/affixes.json') },
  sourceInput: request, sourceRoute: route, cases: [equal, weighted, audited, rare, gloveCommonEqual, gloveCommon, gloveRareEqual, gloveRare],
  parameters: snapshot.parameters };
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--verify-only')) assert.equal(readFileSync('research/redemption-7272-audit.json', 'utf8'), output);
else writeFileSync('research/redemption-7272-audit.json', output);
