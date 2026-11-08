import { Catalog } from './catalog';
import { validateRequest } from './validation';
import type { Issue, PlanRequest } from './types';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 128;

/** Strict data-only input reader shared by Worker messages, JSON imports and Node callers. */
export function parsePlanRequest(value: unknown, catalog = new Catalog()): { request: PlanRequest | null; issues: readonly Issue[] } {
  const issues: Issue[] = [];
  const fail = (path: string, message: string) => issues.push({ code: 'REQUEST_SCHEMA', path, message });
  const object = (input: unknown, path: string, fields: readonly string[]): input is Record<string, unknown> => {
    if (!record(input)) { fail(path, '需要对象'); return false; }
    for (const field of Object.keys(input)) if (!fields.includes(field)) fail(`${path}.${field}`, '未支持的字段；不会忽略或自动放宽限制');
    return true;
  };
  const number = (input: unknown, path: string, minimum: number, maximum: number, integer = true): boolean => {
    if (!finite(input) || input < minimum || input > maximum || (integer && !Number.isInteger(input))) { fail(path, `需要${minimum}至${maximum}的${integer ? '整数' : '有限数值'}`); return false; }
    return true;
  };
  const enumeration = (input: unknown, path: string, values: readonly unknown[]): boolean => {
    if (!values.includes(input)) { fail(path, '取值不在支持范围内'); return false; } return true;
  };
  const boolean = (input: unknown, path: string): boolean => {
    if (typeof input !== 'boolean') { fail(path, '需要布尔值'); return false; } return true;
  };
  const array = (input: unknown, path: string, maximum: number): input is unknown[] => {
    if (!Array.isArray(input) || input.length > maximum) { fail(path, `需要数组，最多${maximum}项`); return false; } return true;
  };
  const slots = ['ordinary', 'sealed', 'primordial', 'corrupted'];
  if (!object(value, 'request', ['modelId', 'inputModel', 'initialFp', 'item', 'craftingContext', 'target', 'constraints', 'scoring', 'search'])) return { request: null, issues };
  if (value.initialFp !== undefined) number(value.initialFp, 'initialFp', 0, catalog.model.fpMaximum);
  if (!text(value.modelId)) fail('modelId', '需要模型版本字符串');
  if (value.inputModel !== undefined) enumeration(value.inputModel, 'inputModel', ['AUDITED', 'FORGEABLE_WEIGHTED', 'FORGEABLE_EQUAL', 'FORGEABLE_ANY_EQUAL', 'CONCRETE_EQUAL', 'CONCRETE_WEIGHTED']);
  if (object(value.item, 'item', ['baseId', 'itemLevel', 'fpType', 'corrupted', 'affixes'])) {
    const item = value.item;
    if (!text(item.baseId)) fail('item.baseId', '需要底材ID字符串');
    number(item.itemLevel, 'item.itemLevel', 1, 100);
    enumeration(item.fpType, 'item.fpType', ['NORMAL', 'ICE', 'BLOOD']);
    boolean(item.corrupted, 'item.corrupted');
    if (array(item.affixes, 'item.affixes', 7)) item.affixes.forEach((entry, index) => {
      const path = `item.affixes.${index}`;
      if (!object(entry, path, ['id', 'tier', 'slot', 'roll'])) return;
      number(entry.id, `${path}.id`, 0, 65535);
      number(entry.tier, `${path}.tier`, 1, 8);
      enumeration(entry.slot, `${path}.slot`, slots);
      if (entry.roll !== null) number(entry.roll, `${path}.roll`, 0, 255);
    });
  }
  if (object(value.craftingContext, 'craftingContext', ['playerLevel'])) number(value.craftingContext.playerLevel, 'craftingContext.playerLevel', 1, 100);
  if (object(value.target, 'target', ['requirements']) && array(value.target.requirements, 'target.requirements', 32)) {
    value.target.requirements.forEach((entry, index) => {
      const path = `target.requirements.${index}`;
      if (!object(entry, path, ['ids', 'minTier', 'maxTier', 'slot', 'minRollByte', 'optional'])) return;
      if (array(entry.ids, `${path}.ids`, 1156)) entry.ids.forEach((id, i) => number(id, `${path}.ids.${i}`, 0, 65535));
      number(entry.minTier, `${path}.minTier`, 1, 8);
      if (entry.maxTier !== undefined) number(entry.maxTier, `${path}.maxTier`, 1, 8);
      enumeration(entry.slot, `${path}.slot`, [...slots, 'any']);
      if (entry.minRollByte !== undefined) number(entry.minRollByte, `${path}.minRollByte`, 0, 255);
      if (entry.optional !== undefined) boolean(entry.optional, `${path}.optional`);
    });
  }
  if (object(value.constraints, 'constraints', ['allowedActions', 'protected', 'maxAttempts'])) {
    if (value.constraints.allowedActions !== undefined && array(value.constraints.allowedActions, 'constraints.allowedActions', 7)) {
      value.constraints.allowedActions.forEach((kind, index) => enumeration(kind, `constraints.allowedActions.${index}`, ['add', 'upgrade', 'seal', 'chaos', 'havoc', 'redemption', 'removal']));
    }
    if (value.constraints.protected !== undefined && array(value.constraints.protected, 'constraints.protected', 7)) {
      value.constraints.protected.forEach((entry, index) => {
        const path = `constraints.protected.${index}`;
        if (!object(entry, path, ['id', 'identity', 'minTier', 'roll'])) return;
        number(entry.id, `${path}.id`, 0, 65535);
        if (entry.identity !== undefined) boolean(entry.identity, `${path}.identity`);
        if (entry.minTier !== undefined) number(entry.minTier, `${path}.minTier`, 1, 8);
        if (entry.roll !== undefined) boolean(entry.roll, `${path}.roll`);
      });
    }
    if (value.constraints.maxAttempts !== undefined) number(value.constraints.maxAttempts, 'constraints.maxAttempts', 1, 65536);
  }
  if (object(value.scoring, 'scoring', ['maximumFp', 'weights'])) {
    if (value.scoring.maximumFp !== undefined) number(value.scoring.maximumFp, 'scoring.maximumFp', 1, 63);
    if (value.scoring.weights !== undefined && array(value.scoring.weights, 'scoring.weights', 63)) {
      value.scoring.weights.forEach((weight, index) => number(weight, `scoring.weights.${index}`, 0, Number.MAX_VALUE, false));
    }
  }
  if (object(value.search, 'search', ['milliseconds', 'maxRoutes', 'macroStages', 'maxStates'])) {
    number(value.search.milliseconds, 'search.milliseconds', 1, 600000, false);
    number(value.search.maxRoutes, 'search.maxRoutes', 1, 10000);
    number(value.search.macroStages, 'search.macroStages', 1, 32);
    number(value.search.maxStates, 'search.maxStates', 1, 200000);
  }
  if (issues.length) return { request: null, issues };
  const request = value as unknown as PlanRequest;
  const semantic = validateRequest(request, catalog);
  return semantic.length ? { request: null, issues: semantic } : { request, issues: [] };
}
