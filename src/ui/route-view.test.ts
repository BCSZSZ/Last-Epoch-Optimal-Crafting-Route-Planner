import { expect, it } from 'vitest';
import { compileDraft, emptyDraft } from '../core/draft';
import { compileTemplates } from '../core/hierarchy';
import { catalogForInputModel } from '../core/input-model';
import { RuleEngine } from '../core/rules';
import type { Macro } from '../core/types';
import type { PlanRequest } from '../core/types';
import { routeSteps } from './route-view';

it('omits initially satisfied Redemption and preparation macros for an ownedT7 example', () => {
  const { request: base, catalog } = fixture();
  const request: PlanRequest = { ...base, item: { ...base.item, affixes: [[4,7],[26,7],[7,2],[10,1]]
    .map(([id,tier]) => ({id,tier,slot:'ordinary',roll:null})) },
    target: { requirements: [4,8].map(id=>({ids:[id],minTier:7,maxTier:7,slot:'ordinary'})) } };
  const selector={side:1 as const,excludedIds:[4,8],minTier:1,maxTier:1,sealable:true};
  const macros:Macro[]=[{kind:'repeat',action:{kind:'redemption',glyph:'hope'},until:{kind:'any',predicates:[4,8]
    .map(id=>({kind:'identity',requirement:{ids:[id],minTier:1,maxTier:8,slot:'ordinary'}}))}},
    {kind:'conditional',when:{kind:'identity',requirement:{ids:[4],minTier:1,maxTier:8,slot:'ordinary'}},then:[
      {kind:'repeat',action:{kind:'havoc',glyph:'hope'},until:{kind:'exists',selector}}, {kind:'seal',selector},
      {kind:'once',action:{kind:'add',id:8,glyph:'hope'}}]},
    {kind:'repeat',action:{kind:'havoc',glyph:'hope'},until:{kind:'target'}}];
  expect(routeSteps(macros,request,catalog).map(row=>row.title)).toEqual(['封印','添加词缀','浩劫直至两项目标均为T7']);
});

function fixture() {
  const draft = emptyDraft();
  const scenario = compileDraft({ ...draft, part: 19, slots: { ...draft.slots,
    prefix1: { tier: 7, id: null }, prefix2: { tier: 3, id: null }, suffix1: { tier: 7, id: null }, suffix2: { tier: 2, id: null } },
    counts: [{ desired: 1 }, { desired: 1 }] }).scenarios[0];
  const catalog = catalogForInputModel(scenario.request.inputModel);
  return { ...scenario, catalog, engine: new RuleEngine(catalog) };
}

it('names the original garbage prefix and only reachable tiers for the 7271 preparation', () => {
  const draft = emptyDraft();
  const { request, aliases } = compileDraft({ ...draft, part: 1, slots: { ...draft.slots,
    prefix1: { tier: 7, id: null }, prefix2: { tier: 2, id: null, isTarget: true },
    suffix1: { tier: 7, id: null }, suffix2: { tier: 1, id: null } },
    counts: [{ desired: 2 }, { desired: 0 }] }).scenarios[0];
  const catalog = catalogForInputModel(request.inputModel);
  const accepted = { side: 0 as const, excludedIds: request.target.requirements.flatMap(row => row.ids), minTier: 1, maxTier: 6 };
  const steps = routeSteps([{ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector: accepted } },
    { kind: 'removal', accepted, glyph: 'hope' }], request, catalog, aliases);
  expect(steps[0].title).toBe('浩劫至前缀1为T1或T2');
  expect(steps[1].condition).toBe('仅接受前缀1（T1或T2）；剥歪即停止。');
});

it('keeps a multiple-slot stop explicit and drops original slot facts after Redemption', () => {
  const { request: source, catalog } = fixture();
  const request = { ...source, item: { ...source.item, affixes: source.item.affixes.map((row, index) => ({ ...row, tier: [7, 7, 3, 2][index] })) } };
  const prepare: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' },
    until: { kind: 'exists', selector: { side: 0, minTier: 1, maxTier: 6 } } };
  expect(routeSteps([prepare], request, catalog)[0].title).toBe('浩劫至前缀1／前缀2中至少一条为T2或T3');
  const changed = routeSteps([{ kind: 'once', action: { kind: 'redemption', glyph: 'hope' } }, prepare], request, catalog);
  expect(changed[1].title).not.toContain('前缀1');
  expect(changed[1].title).toContain('T1–T6');
});

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
