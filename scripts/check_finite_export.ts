import { readFileSync, writeFileSync } from 'node:fs';
import { catalogForInputModel } from '../src/core/input-model';
import { parsePlanRequest } from '../src/core/request';
import { replayFiniteProfile } from '../src/core/finite-replay';
import { FINITE_POLICY_VERSION } from '../src/core/finite-policy';
import type { PlanReport } from '../src/core/planner';

const inputPath = process.argv[2]; if (!inputPath) throw new Error('Usage: tsx scripts/check_finite_export.ts <export.json> [--output result.json]');
const record = JSON.parse(readFileSync(inputPath, 'utf8')) as { schemaVersion: number; input: unknown; report: PlanReport };
const catalog = catalogForInputModel(record.report.inputModel), parsed = parsePlanRequest(record.input, catalog);
if (!parsed.request || record.schemaVersion !== 2 || record.report.modelId !== catalog.model.modelId || record.report.finiteProfiles?.version !== FINITE_POLICY_VERSION ||
  record.report.finiteProfiles.profiles.map(row => row.fpType).join(',') !== 'NORMAL,ICE,BLOOD') throw new Error('Export input/model/version mismatch');
const checks = [];
for (const profile of record.report.finiteProfiles.profiles) checks.push(await replayFiniteProfile(parsed.request, catalog, profile));
const result = { status: 'PASS_THREE_EXPORTED_PROFILES', modelId: catalog.model.modelId, checks };
const out = process.argv.indexOf('--output'); if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
