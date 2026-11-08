import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogForInputModel } from '../src/core/input-model';
import { solveCompactProfile } from '../src/core/finite-policy';
import type { FpType, PlanRequest } from '../src/core/types';

const data = JSON.parse(readFileSync(new URL('../research/fixtures/finite48-three-profiles-99.json', import.meta.url), 'utf8')) as {
  rows: { caseId: string; request: PlanRequest; expected: Record<FpType, { probability: number }> }[];
};
const selected = process.argv.includes('--all') ? data.rows : data.rows.filter(row => ['C001', 'C028', 'C062', 'C087'].includes(row.caseId));
let checks = 0, maxError = 0; const start = performance.now();
for (const row of selected) for (const profile of ['NORMAL', 'ICE', 'BLOOD'] as const) {
  const catalog = catalogForInputModel(row.request.inputModel), request = { ...row.request, modelId: catalog.model.modelId };
  const result = await solveCompactProfile(request, catalog, profile, { stopped: () => false });
  assert(result, `${row.caseId}: compact domain unavailable`);
  const expected = row.expected[profile].probability, error = Math.abs(result.estimate! - expected);
  assert(error < 1e-9, `${row.caseId}/${profile}: ${result.estimate} vs${expected}`);
  assert(result.probability!.lower <= expected && result.probability!.upper >= expected, `${row.caseId}/${profile}: enclosure misses independent value`);
  maxError = Math.max(maxError, error); checks++;
  console.log(JSON.stringify({ caseId: row.caseId, profile, p: result.estimate, expected, width: result.probability!.upper - result.probability!.lower,
    states: result.states, first: result.firstAction, policyRows: result.decisions.length }));
}
console.log(JSON.stringify({ checks, maxError, elapsedMs: performance.now() - start }));
