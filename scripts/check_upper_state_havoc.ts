/** Same G/N/S label, different actual Havoc kernel and resource demand. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODEL_ID } from '../src/core/catalog';
import { RuleEngine } from '../src/core/rules';
import { targetReached } from '../src/core/target';
import type { Item, Target } from '../src/core/types';

const target: Target = { requirements: [4, 5].map((id) => ({ ids: [id], minTier: 7, maxTier: 7, slot: 'ordinary' })) };
const rows = [];
for (const lastTier of [1, 2]) {
  const item: Item = { baseId: '4:0', itemLevel: 100, fpType: 'NORMAL', corrupted: false, affixes:
    [[4, 7], [7, 7], [5, 1], [10, lastTier]].map(([id, tier]) => ({ id, tier, slot: 'ordinary', roll: null })) };
  const distribution = new RuleEngine().transition(item, 63, { kind: 'havoc', glyph: 'hope' }, { playerLevel: 100 });
  if (distribution.issues.length) throw new Error('Counterexample was not legal');
  const probability = distribution.outcomes.reduce((sum, row) => sum + (targetReached(row.item, target) ? row.probability : 0), 0);
  const meanCost = distribution.outcomes.reduce((sum, row) => sum + row.probability * (63 - row.fp), 0);
  const expectedProbability = lastTier === 1 ? 1 / 5 : 2 / 11;
  if (Math.abs(probability - expectedProbability) > 1e-12 || Math.abs(meanCost - 6.436875) > 1e-12) throw new Error('Independent hand formula differs');
  rows.push({ item, coarseLabel: { category: '211', ordinaryCount: 4, ordinarySealedCount: 0, totalCount: 4 },
    perCastSuccessProbability: probability, meanFpPerCastWithoutBalanceBoundary: meanCost,
    eventualOperationSuccessProbability: 1, meanAttemptsUntilSuccess: 1 / probability,
    expectedSuccessPathFp: meanCost / probability });
}
const root = new URL('../', import.meta.url);
const sourcePaths = ['src/generated/model.json', 'src/core/rules.ts', 'src/core/probability.ts', 'scripts/check_upper_state_havoc.ts'];
const output = { schemaVersion: 1, date: '2026-11-03', sourceModelId: MODEL_ID,
  analysisModel: 'INTRINSIC_OPERATION_SUCCESS_AND_SUCCESS_PATH_FP_V1', rows,
  sameCoarseLabelButDifferentTransitionAndCost: true,
  qualification: 'One legal concrete no-roll target example. Current production atomic kernel with continuously sufficient FP; Havoc changed-layout symmetry gives the repeated-macro mean. Not a benchmark or client measurement.',
  inputSha256: Object.fromEntries(sourcePaths.map((path) => [path, createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')])) };
const encoded = JSON.stringify(output, null, 2) + '\n';
const outputPath = new URL('research/upper-state-havoc-check.json', root);
if (process.argv.includes('--verify-only')) {
  if (readFileSync(outputPath, 'utf8') !== encoded) throw new Error('Saved upper-state Havoc result is stale');
} else writeFileSync(outputPath, encoded);
console.log(JSON.stringify(rows.map((row) => ({ label: row.coarseLabel, tiers: row.item.affixes.map((affix) => affix.tier),
  perCastSuccess: row.perCastSuccessProbability, expectedSuccessFp: row.expectedSuccessPathFp }))));
