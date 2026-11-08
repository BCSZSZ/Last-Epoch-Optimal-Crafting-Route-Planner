import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { MODEL_ID } from '../src/core/catalog';
import { reportRoute } from '../src/core/evaluation';
import { parsePlanRequest } from '../src/core/request';
import { RuleEngine } from '../src/core/rules';
import { sampleRoute } from '../src/core/sampling';
import { benchmarkMatrix } from '../src/diagnostics/cases';
import type { DeviceBenchmarkRecord } from '../src/diagnostics/record';
import { evaluateIntrinsic, IntrinsicWorkspace } from '../src/core/intrinsic';
import { recordCatalog } from './runtime_model_archive';
import type { FiniteProfileResult } from '../src/core/finite-policy';
import { replayFiniteProfile } from '../src/core/finite-replay';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('用法：npx tsx scripts/check_device_benchmark.ts <完整JSON记录> [--output <验证JSON>] [--allow-partial]');
const record: DeviceBenchmarkRecord = JSON.parse(readFileSync(inputPath, 'utf8'));
const catalog = recordCatalog(record.modelId, process.argv.includes('--historical'));
if (record.schemaVersion !== 1 || !['FULL', 'NORMAL_ONLY'].includes(record.mode)) throw new Error('设备记录schema或模式不匹配');
const matrix = benchmarkMatrix(record.mode);
if (!Array.isArray(record.entries) || record.totalCases !== matrix.length || record.entries.length > matrix.length) throw new Error('设备记录案例数无效');
if (!process.argv.includes('--allow-partial') && (record.status !== 'COMPLETE' || record.entries.length !== matrix.length)) throw new Error('记录未完成；部分记录需显式使用--allow-partial，不能作为完整矩阵验收');
if (!['RUNNING', 'COMPLETE', 'CANCELLED', 'ERROR'].includes(record.status) ||
    !Array.isArray(record.visibility) || record.visibility.length === 0 || record.visibility[0].milliseconds !== 0 ||
    record.visibility.some((entry, index) => !['visible', 'hidden'].includes(entry.state) || !Number.isFinite(entry.milliseconds) ||
      entry.milliseconds < 0 || (index > 0 && entry.milliseconds < record.visibility[index - 1].milliseconds))) throw new Error('设备记录状态或前台时间线无效');

function canonical(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object' ?
    Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, entry]) => [key, ordered(entry)])) : item;
  return JSON.stringify(ordered(value));
}

function compare(actual: unknown, expected: unknown, path = 'primary'): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > 1e-14 + 1e-12 * Math.max(Math.abs(actual), Math.abs(expected))) throw new Error(`跨平台数值不同：${path}`);
    return;
  }
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') {
    if (actual !== expected) throw new Error(`跨平台字段不同：${path}`);
    return;
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) throw new Error(`跨平台结构不同：${path}`);
  const left = Object.entries(actual); const right = Object.entries(expected);
  if (canonical(left.map(([key]) => key).sort()) !== canonical(right.map(([key]) => key).sort())) throw new Error(`跨平台字段集不同：${path}`);
  for (const [key, value] of left) compare(value, Reflect.get(expected, key), `${path}.${key}`);
}

const engine = new RuleEngine(catalog);
const checks = [];
let noRecommendation = 0;
for (const [index, entry] of record.entries.entries()) {
  const expected = matrix[index];
  if (entry.id !== expected.id || entry.fpType !== expected.fpType || canonical(entry.request) !== canonical({ ...expected.request, modelId: record.modelId })) throw new Error(`固定案例输入与顺序不同：${index}`);
  const parsed = parsePlanRequest(entry.request, catalog);
  if (!parsed.request || entry.report.modelId !== record.modelId) throw new Error(`案例输入或模型无效：${index}`);
  if (!Number.isFinite(entry.adapterWallMilliseconds) || entry.adapterWallMilliseconds < 0 || !Number.isFinite(entry.report.search.elapsedMilliseconds) || entry.report.search.elapsedMilliseconds < 0) throw new Error(`案例计时无效：${index}`);
  if (entry.report.finiteProfiles) {
    if (entry.report.finiteProfiles.profiles.map((row: FiniteProfileResult) => row.fpType).join(',') !== 'NORMAL,ICE,BLOOD') throw new Error('Missing three profiles');
    const profiles = [];
    for (const profile of entry.report.finiteProfiles.profiles) profiles.push(await replayFiniteProfile(parsed.request, catalog, profile));
    checks.push({ id: entry.id, fpType: entry.fpType, comparison: 'THREE_EXPORTED_POLICIES_REPLAYED_AT48FP', profiles,
      adapterMilliseconds: entry.adapterWallMilliseconds, searchStatus: entry.report.searchStatus });
    continue;
  }
  const primary = entry.report.primary;
  if (!primary) {
    noRecommendation++;
    checks.push({ id: entry.id, fpType: entry.fpType, comparison: 'NO_RECOMMENDATION_IN_REPORTED_SCOPE', status: entry.report.status });
    continue;
  }
  const node = primary.intrinsic ? evaluateIntrinsic(new IntrinsicWorkspace(engine, parsed.request), primary.route) : primary.sampling ? sampleRoute(engine, parsed.request, primary.route, {
    seed: primary.sampling.seed, samplesPerFp: primary.sampling.samplesPerFp,
    confidence: primary.sampling.confidence, attemptGuard: primary.sampling.attemptGuard,
  }) : reportRoute(engine, parsed.request, primary.route);
  compare(primary, node);
  checks.push({ id: entry.id, fpType: entry.fpType, comparison: 'NUMERICALLY_EQUIVALENT_COMPLETE_ROUTE_REPORT',
    bitIdentical: canonical(primary) === canonical(node), score: primary.scoreEstimate, routeId: primary.route.id,
    adapterMilliseconds: entry.adapterWallMilliseconds, workerMilliseconds: entry.report.search.elapsedMilliseconds,
    evaluatedRoutes: entry.report.search.evaluatedRoutes, searchStatus: entry.report.searchStatus });
}
const result = { status: noRecommendation ? 'RETURNED_ROUTES_VERIFIED_WITH_MISSING_RECOMMENDATIONS' : record.status === 'COMPLETE' ? 'PASS_MATRIX_AND_ROUTE_PARITY' : 'PASS_COMPLETED_SUBSET_ONLY',
  inputFile: basename(inputPath), modelId: record.modelId, currentModelId: MODEL_ID, historical: record.modelId !== MODEL_ID,
  checkedAt: new Date().toISOString(), mode: record.mode,
  declaredDeviceClass: record.declaredDeviceClass, deviceLabel: record.deviceLabel, physicalDeviceClassCertifiedByThisChecker: false,
  foregroundThroughout: record.visibility.every((entry) => entry.state === 'visible'), totalCases: matrix.length,
  completedCases: record.entries.length, noRecommendation, checks,
  qualification: 'Current three-profile reports replay their submitted decisions at48FP, including recommendation and actual FP rewards. Legacy reports replay the same chosen fixed routes; search coverage and elapsed time are reported separately. Historical records replay with their pinned model in the retained finite evaluator and do not certify current performance. Comparison tolerance is 1e-14 absolute plus 1e-12 relative, with bit identity reported separately. Kernel parity is not independent mechanics validation or proof of physical device class.' };
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
