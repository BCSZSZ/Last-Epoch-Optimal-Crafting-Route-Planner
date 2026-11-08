import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { exampleRequest } from './examples';
import { plan } from './planner';
import { solveCompactProfile } from './finite-policy';
import { catalogForInputModel } from './input-model';
import type { PlanRequest } from './types';
import { replayFiniteProfile } from './finite-replay';

it('shows one repeat phase for87.590% ice Havoc, with20.80 actual expected FP', async () => {
  const input = {...exampleRequest('7732-ready'),initialFp:48}, report = await plan(input, { now: () => 0 });
  const row = report.finiteProfiles!.profiles[1];
  expect(row.estimate).toBeCloseTo(.8758957816592063, 10);
  expect(row.fixedFp).toBeDefined();
  expect(row.fixedFp!.totalExpectedFp).toBeCloseTo(20.798186498975767,8);
  expect(Object.values(row.fixedFp!.macros).reduce((sum,stat)=>sum+stat.totalFpContribution,0)).toBeCloseTo(20.798186498975767,8);
  expect(row.fixedFp!.totalExpectedFp).not.toBeCloseTo(row.successActualMeanFp!,1);
  expect((await replayFiniteProfile(input, catalogForInputModel(input.inputModel), row)).actualMeanFp).toBeCloseTo(20.798186498975767, 8);
}, 30000);

it('partitions real repeat-stage occupation costs rather than subtracting a chosen example balance', async () => {
  const source = JSON.parse(readFileSync(new URL('../../research/fixtures/finite48-three-profiles-99.json', import.meta.url), 'utf8')).rows[0].request as PlanRequest;
  const catalog = catalogForInputModel(source.inputModel), input = { ...source, modelId: catalog.model.modelId, initialFp:48 };
  const row = (await solveCompactProfile(input, catalog, 'ICE', { stopped: () => false }))!;
  const steps = row.stepPlan!.steps;
  expect(steps.map(step => step.operation)).toEqual(['救赎', '浩劫']);
  expect(steps[0].expectedFp).toBeCloseTo(28.624892088796, 8);
  expect(steps[1].expectedEntries).toBeCloseTo(.66372075698332, 10);
  expect(steps.reduce((sum, step) => sum + step.expectedFp * step.expectedEntries, 0)).toBeCloseTo(row.actualMeanFp!, 8);
  expect(row.stepPlan!.main).toEqual([1, 2]);
  const replay = await replayFiniteProfile(input, catalog, row); expect(replay.actualMeanFp).toBeCloseTo(row.actualMeanFp!, 8);
}, 30000);

it('preparation acceptance describes the next seal rather than unioning unrelated low-FP exits', async () => {
  const source = JSON.parse(readFileSync(new URL('../../research/fixtures/finite48-three-profiles-99.json', import.meta.url), 'utf8')).rows[2].request as PlanRequest;
  const catalog = catalogForInputModel(source.inputModel), row = (await solveCompactProfile({ ...source, modelId: catalog.model.modelId, initialFp:48 }, catalog, 'ICE', { stopped: () => false }))!;
  const preparation = row.stepPlan!.steps.find(s => row.stepPlan!.main.includes(s.id) && s.operation === '浩劫' && s.key !== 'havoc:finish')!;
  expect(preparation.criterion).toContain('后缀1为T1');
  expect(preparation.criterion).not.toContain('前缀1为T1或T7');
}, 30000);
