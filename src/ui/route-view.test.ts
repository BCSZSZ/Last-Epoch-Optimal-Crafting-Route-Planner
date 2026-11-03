import { expect, it } from 'vitest';
import { compileDraft, emptyDraft } from '../core/draft';
import { compileTemplates } from '../core/hierarchy';
import { catalogForInputModel } from '../core/input-model';
import { RuleEngine } from '../core/rules';
import type { Macro } from '../core/types';
import { routeSteps } from './route-view';

function fixture() {
  const draft = emptyDraft();
  const scenario = compileDraft({ ...draft, part: 19, slots: { ...draft.slots,
    prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null }, suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null } },
    counts: [{ desired: 1, owned: 0, ownedT7: 0 }, { desired: 1, owned: 0, ownedT7: 0 }] }).scenarios[0];
  const catalog = catalogForInputModel(scenario.request.inputModel);
  return { ...scenario, catalog, engine: new RuleEngine(catalog) };
}

it('renders the actual vacancy-aware controller as five concise steps with no repeated Hope or redundant fill', () => {
  const { request, aliases, catalog, engine } = fixture();
  const route = compileTemplates(request, engine)!.templates.find((row) => row.family === 'INTERLEAVED_ACQUIRE' &&
    row.macros[0].kind === 'removal' && row.description?.includes('直接封印'))!;
  const rendered = routeSteps(route.macros, request, catalog, aliases);
  expect(rendered.map((row) => row.title)).toEqual(['剥离', '添加词缀', '封印', '添加词缀', '浩劫直至两项目标均为T7']);
  expect(rendered[1].condition).toContain('空槽');
  expect(rendered[2].condition).toContain('非目标');
  expect(JSON.stringify(rendered)).not.toContain('希望');
  const lowest = compileTemplates(request, engine)!.templates.find((row) => row.family === 'INTERLEAVED_MIN_SEAL' && row.macros[0].kind === 'removal')!;
  const prepared = routeSteps(lowest.macros, request, catalog, aliases);
  expect(prepared.map((row) => row.title)).toEqual(['剥离', '添加词缀', '浩劫直至最低阶落在无关词缀', '封印', '添加词缀', '浩劫直至两项目标均为T7']);
  expect(prepared[2].condition).toContain('没有T1时改用T2');
});

it('inlines only a guaranteed identity guard, retaining uncertain post-Redemption branches', () => {
  const { request, aliases, catalog } = fixture(), id = request.target.requirements[0].ids[0];
  const add: Macro = { kind: 'once', action: { kind: 'add', id, glyph: 'hope' } };
  const guard: Macro = { kind: 'conditional', when: { kind: 'identity', requirement: { ids: [id], minTier: 1, maxTier: 8, slot: 'ordinary' } }, then: [], otherwise: [add] };
  expect(routeSteps([guard], request, catalog, aliases).map((row) => row.title)).toEqual(['添加词缀']);
  const uncertain = routeSteps([{ kind: 'once', action: { kind: 'redemption', glyph: 'hope' } }, guard], request, catalog, aliases);
  expect(uncertain[1].branches).toHaveLength(2);
  const owned = { ...request, item: { ...request.item, affixes: request.item.affixes.map((row, index) => index === 0 ? { ...row, id } : row) } };
  expect(routeSteps([guard], owned, catalog, aliases)).toEqual([]);
});
