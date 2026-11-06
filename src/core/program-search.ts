/** Example-guided fixed-program generation, shared by production and research. */
import { allowedMacro, routeId, routeKey } from './candidates';
import { ordinary } from './catalog';
import { macroStep, predicateReached, EvaluationLimitError } from './evaluation';
import { evaluateIntrinsic, IntrinsicWorkspace } from './intrinsic';
import type { IntrinsicReport } from './intrinsic';
import { OutcomeLimitError, RuleEngine } from './rules';
import type { Macro, PlanRequest, Predicate, Route, Selector } from './types';
import { compactProgram } from './program-compact';
import { targetReached } from './target';

export type LearningRound = 0 | 1 | 2 | 3;
export const ROUND_NAMES = ['原子顺序基线', '合法空槽补词与准备', '联合停止窗口', '对象优先级与非连续集合'] as const;
type Clear = 'REMOVE' | 'SEAL';
interface SealChoice { readonly tiers: readonly number[]; readonly prepare: boolean; readonly lowestFirst: boolean }
export interface SearchResult {
  readonly primary: IntrinsicReport | null;
  readonly generated: number;
  readonly evaluated: number;
  readonly abandoned: number;
  readonly unresolved: number;
  readonly cacheHits: number;
  readonly scope: 'TWO_T7_TWO_GOALS_MINIMUM_VACANCY_EDITS_V1';
}
const identity = (id: number): Predicate => ({ kind: 'identity', requirement: { ids: [id], minTier: 1, maxTier: 8, slot: 'ordinary' } });
const midpoint = (value: {lower: number; upper: number} | null) => value ? (value.lower + value.upper) / 2 : Infinity;
const programSize = (values: readonly Macro[]): number => values.reduce((sum, macro) => sum + 1 +
  (macro.kind === 'conditional' ? programSize(macro.then) + programSize(macro.otherwise ?? []) : 0), 0);
export function compareLearningReports(a: IntrinsicReport, b: IntrinsicReport): number {
  if (Math.abs(a.scoreEstimate - b.scoreEstimate) > 1e-9) return b.scoreEstimate - a.scoreEstimate;
  const cost = midpoint(a.expectedFpGivenSuccess) - midpoint(b.expectedFpGivenSuccess);
  if (Math.abs(cost) > 1e-7) return cost;
  return programSize(a.route.macros) - programSize(b.route.macros) || a.route.id.localeCompare(b.route.id, 'en');
}

/** Only facts before the first actual action may specialize the fixed program. */
function specialize(values: readonly Macro[], request: PlanRequest, engine: RuleEngine): readonly Macro[] | null {
  let pristine = true, impossible = false;
  const walk = (macros: readonly Macro[]): Macro[] => macros.flatMap(macro => {
    if (!pristine) return [macro];
    if (macro.kind === 'conditional') return walk(predicateReached(request.item, macro.when, request, engine) ? macro.then : macro.otherwise ?? []);
    const step = macroStep(macro, request.item, request, engine);
    if (step === 'SKIP') return [];
    if (step === 'INAPPLICABLE') { impossible = true; pristine = false; return [macro]; }
    pristine = false; return [macro];
  });
  const result = walk(values); return impossible ? null : result;
}

function sealChoices(round: LearningRound): SealChoice[] {
  const choices: SealChoice[] = [{ tiers: [1, 2, 3, 4], prepare: false, lowestFirst: false }];
  if (round === 0) return choices;
  for (let mask = 1; mask < 16; mask++) {
    const tiers = [1, 2, 3, 4].filter(tier => mask & 1 << tier - 1);
    const contiguous = tiers.every((tier, index) => !index || tier === tiers[index - 1] + 1);
    if (round === 1 && tiers.length !== 1 || round === 2 && !contiguous) continue;
    if (contiguous) choices.push({ tiers, prepare: true, lowestFirst: false });
    if (round === 3 && tiers.length > 1) choices.push({ tiers, prepare: true, lowestFirst: true });
    if (round === 3 && tiers.length < 4) choices.push({ tiers, prepare: false, lowestFirst: !contiguous });
  }
  return choices;
}

/** Grammar has no item-pattern labels, teacher programs or example-specific IDs. */
export function generateLearningPrograms(request: PlanRequest, engine: RuleEngine, round: LearningRound,
  options: { readonly compact?: boolean; readonly dynamic?: boolean } = {}): readonly Route[] {
  const requirements = request.target.requirements.filter(row => !row.optional);
  if (requirements.length !== 2 || requirements.some(row => row.ids.length !== 1 || row.slot !== 'ordinary' || row.minTier !== 7 ||
    row.maxTier !== 7 || row.minRollByte !== undefined) || ordinary(request.item).filter(row => row.tier === 7).length !== 2)
    throw new Error('Experimental grammar requires two ordinary T7 sources and two distinct ordinary T7 goals.');
  const ids = requirements.map(row => row.ids[0]);
  if (new Set(ids).size !== 2) throw new Error('Distinct target identities required.');
  const missing = options.dynamic ? ids : ids.filter(id => !ordinary(request.item).some(row => row.id === id));
  const deficits = [0, 1].map(side => Math.max(0, missing.filter(id => engine.catalog.side(id) === side).length -
    (2 - ordinary(request.item).filter(row => engine.catalog.side(row.id) === side).length)));
  const edits = deficits[0] + deficits[1];
  const exclusions = [...ids, ...(request.constraints.protected?.map(row => row.id) ?? [])];
  const fillers = engine.catalog.model.affixes.filter(row => row.special === 0 && row.side < 2 && !ids.includes(row.id) &&
    engine.catalog.hasShard(row.id) && engine.catalog.canRollOn(row.id, request.item.baseId)).map(row => row.id).sort((a, b) => a - b);
  const fill: Macro = { kind: 'fill', ids: fillers, glyph: 'hope' };
  const finish: Macro[] = [fill, { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' },...(options.dynamic?{onUnreachable:'ABORT' as const}:{}) }];
  const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });
  const orders = missing.length === 2 ? [missing, [...missing].reverse()] : [missing];
  const sequences: Clear[][] = [];
  const extend = (prefix: Clear[], seals: number): void => {
    if (prefix.length === edits) { sequences.push(prefix); return; }
    extend([...prefix, 'REMOVE'], seals);
    if (seals === 0) extend([...prefix, 'SEAL'], 1);
  };
  extend([], 0);
  const routes: Route[] = [], seen = new Set<string>();
  const append = (macros: readonly Macro[], description: string) => {
    const entry = options.dynamic ? macros : specialize(macros, request, engine);
    const simplified = entry && options.compact !== false ? compactProgram(entry, request, engine.catalog,options.dynamic) : entry;
    if (!simplified || simplified.some(macro => !allowedMacro(macro, request))) return;
    const route = { id: routeId(simplified), macros: simplified, description }, key = routeKey(route);
    if (!seen.has(key)) { seen.add(key); routes.push(route); }
  };
  for (const order of orders) {
    const ready: Macro[] = order.map(id => ({ kind: 'conditional', when: identity(id), then: [], otherwise: [
      { kind: 'conditional', when: { kind: 'count', selector: { side: engine.catalog.side(id) as 0 | 1 }, minimum: 2 },
        then: [], otherwise: [add(id)] },
    ] }));
    const firstMissing = (body: (id: number) => readonly Macro[], index = 0): readonly Macro[] => index >= order.length ? [] : [{
      kind: 'conditional', when: identity(order[index]), then: firstMissing(body, index + 1), otherwise: options.dynamic?[{
        kind:'conditional',when:{kind:'count',selector:{side:engine.catalog.side(order[index]) as 0|1},minimum:2},then:body(order[index]),otherwise:[],
      }]:body(order[index]),
    }];
    const remove = (allSides: boolean, prepare: boolean): readonly Macro[] => {
      const body = (present: readonly number[]): readonly Macro[] => {
        const sides = new Set(present.map(id => engine.catalog.side(id)));
        const selector: Selector = { excludedIds: exclusions, minTier: 1, maxTier: 6, eligibleAction: 'removal',
          ...(sides.size === 1 ? { side: [...sides][0] as 0 | 1 } : {}) };
        return [...(prepare ? [fill, { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector },...(options.dynamic?{onUnreachable:'ABORT' as const}:{}) } as Macro] : []),
          { kind: 'removal', accepted: selector, glyph: 'hope' }];
      };
      if (!allSides || order.length < 2) return firstMissing(id => body([id]));
      return [{ kind: 'conditional', when: identity(order[0]), then: firstMissing(id => body([id]), 1), otherwise: [
        { kind: 'conditional', when: identity(order[1]), then: body([order[0]]), otherwise: body(order) },
      ] }];
    };
    const seal = (choice: SealChoice): readonly Macro[] => firstMissing(id => {
      const selector: Selector = { excludedIds: exclusions, side: engine.catalog.side(id) as 0 | 1,
        minTier: choice.tiers[0], maxTier: choice.tiers.at(-1), sealable: true };
      const exactSelectors = choice.tiers.map(tier => ({ ...selector, minTier: tier, maxTier: tier }));
      const contiguous = choice.tiers.every((tier, index) => !index || tier === choice.tiers[index - 1] + 1);
      const predicate: Predicate = contiguous ? { kind: 'exists', selector } :
        { kind: 'any', predicates: exactSelectors.map(entry => ({ kind: 'exists', selector: entry })) };
      const chooseTier = (index: number): readonly Macro[] => index === exactSelectors.length - 1 ? [{ kind: 'seal', selector: exactSelectors[index] }] : [{
        kind: 'conditional', when: { kind: 'exists', selector: exactSelectors[index] },
        then: [{ kind: 'seal', selector: exactSelectors[index] }], otherwise: chooseTier(index + 1),
      }];
      return [...(choice.prepare ? [fill, { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: predicate,...(options.dynamic?{onUnreachable:'ABORT' as const}:{}) } as Macro] : []),
        ...(choice.lowestFirst ? chooseTier(0) : [{ kind: 'seal', selector } as Macro])];
    });
    for (const sequence of sequences) {
      if (sequence.includes('SEAL') && request.item.affixes.some(row => row.slot === 'sealed')) continue;
      for (const choice of sequence.includes('SEAL') ? sealChoices(round) : [{ tiers: [1], prepare: false, lowestFirst: false }]) {
        for (const allSides of [false, true]) for (const prepareRemoval of round === 0 ? [false] : [false, true]) {
          const blocks = sequence.map(kind => kind === 'SEAL' ? seal(choice) : remove(allSides, prepareRemoval));
          // Fixed additions distributed over every edit position; their order never changes at execution time.
          const placements = (index: number, minimum: number, selected: number[]): void => {
            if (index < order.length) { for (let at = minimum; at <= edits; at++) placements(index + 1, at, [...selected, at]); return; }
            const macros: Macro[] = [];
            for (let at = 0; at <= edits; at++) {
              order.forEach((id, i) => { if (selected[i] === at) macros.push(add(id)); });
              if (at < edits) macros.push(...blocks[at]);
            }
            append([...macros, ...finish], '固定添加顺序／开槽顺序');
          };
          if (!options.dynamic) placements(0, 0, []);
          if (round >= 1) for (let mask = 0; mask < 1 << edits; mask++) {
            const macros: Macro[] = [];
            for (let at = 0; at <= edits; at++) {
              if (at === edits || mask & 1 << at) macros.push(...ready);
              if (at < edits) macros.push(...blocks[at]);
            }
            append([...macros, ...finish], '固定合法空槽分支／开槽顺序');
          }
        }
      }
    }
  }
  return routes;
}

export function supportsPrograms(request: PlanRequest): boolean {
  const rows=request.target.requirements.filter(row=>!row.optional);
  return rows.length===2 && rows.every(row=>row.ids.length===1 && row.slot==='ordinary' && row.minTier===7 && row.maxTier===7 && row.minRollByte===undefined) &&
    rows[0].ids[0]!==rows[1].ids[0] && ordinary(request.item).filter(row=>row.tier===7).length===2;
}

/** A single identity-changing stage followed by a fixed, predeclared recovery program. */
export function productionPrograms(request: PlanRequest, engine: RuleEngine): readonly Route[] | null {
  if(!supportsPrograms(request))return null;
  if(targetReached(request.item,request.target))return[{id:routeId([]),macros:[],description:'目标已经达成'}];
  const goals=request.target.requirements.filter(row=>!row.optional).map(row=>row.ids[0]);
  const experimental=ordinary(request.item).filter(row=>engine.catalog.affix(row.id).special===1 && !goals.includes(row.id));
  const blocked=experimental.filter(row=>goals.filter(id=>engine.catalog.side(id)===engine.catalog.side(row.id)).length===2);
  const ordinaryPrograms=generateLearningPrograms(request,engine,2);
  if(!blocked.length)return ordinaryPrograms;
  const fillers=engine.catalog.model.affixes.filter(row=>row.special===0 && row.side<2 && !goals.includes(row.id) && engine.catalog.hasShard(row.id) && engine.catalog.canRollOn(row.id,request.item.baseId)).map(row=>row.id).sort((a,b)=>a-b);
  const fill:Macro={kind:'fill',ids:fillers,glyph:'hope'};
  const wanted=ordinary(request.item).filter(row=>goals.includes(row.id));
  const predicates:Predicate[]=blocked.map(row=>({kind:'identity',requirement:{ids:[row.id],minTier:6,maxTier:7,slot:'ordinary'}}));
  const prefixes:Macro[][]=[];
  if(blocked.every(row=>row.tier>=6))prefixes.push([{kind:'once',action:{kind:'redemption',glyph:'hope'}}]);
  for(const protect of wanted.length?[false,true]:[false]){
    const conditions=[...predicates,...(protect?wanted.map((row):Predicate=>({kind:'identity',requirement:{ids:[row.id],minTier:1,maxTier:5,slot:'ordinary'}})):[])];
    prefixes.push([fill,{kind:'repeat',action:{kind:'havoc',glyph:'hope'},until:{kind:'all',predicates:conditions},onUnreachable:'ABORT'},{kind:'once',action:{kind:'redemption',glyph:'hope'}}]);
  }
  // Filled prefixes require the corresponding full-slot recovery grammar.
  const full:PlanRequest={...request,item:{...request.item,affixes:[...request.item.affixes]}};
  const used=new Set(full.item.affixes.map(row=>row.id));
  for(const side of [0,1])while(ordinary(full.item).filter(row=>engine.catalog.side(row.id)===side).length<2){
    const id=fillers.find(id=>!used.has(id)&&engine.catalog.side(id)===side);if(id===undefined)break;
    used.add(id);(full.item.affixes as import('./types').Affix[]).push({id,tier:1,slot:'ordinary',roll:null});
  }
  const seen=new Set<string>(),routes:Route[]=[];
  for(const prefix of prefixes){
    const leading=specialize(prefix,request,engine);if(!leading)continue;
    const base=prefix[0].kind==='fill'?full:request;
    for(const suffix of generateLearningPrograms(base,engine,2,{dynamic:true})){
      const macros=[...leading,...suffix.macros];if(macros.some(m=>!allowedMacro(m,request)))continue;
      const route={id:routeId(macros),macros,description:'实验词缀转普通后，按固定开槽／补词顺序完成目标'};
      const key=routeKey(route);if(!seen.has(key)){seen.add(key);routes.push(route);}
    }
  }
  return routes;
}

export function searchLearningPrograms(workspace: IntrinsicWorkspace, round: LearningRound): SearchResult {
  const routes = generateLearningPrograms(workspace.request, workspace.engine, round);
  let primary: IntrinsicReport | null = null, abandoned = 0, unresolved = 0;
  const hits = workspace.cacheHits;
  for (const route of routes) {
    try {
      const report = evaluateIntrinsic(workspace, route);
      if (report.intrinsic.decision === 'ABANDONED') abandoned++;
      else if (report.intrinsic.decision === 'UNRESOLVED') unresolved++;
      else if (!primary || compareLearningReports(report, primary) < 0) primary = report;
    } catch (error) {
      if (!(error instanceof EvaluationLimitError || error instanceof OutcomeLimitError)) throw error;
      unresolved++;
    }
  }
  return { primary, generated: routes.length, evaluated: routes.length, abandoned, unresolved, cacheHits: workspace.cacheHits - hits,
    scope: 'TWO_T7_TWO_GOALS_MINIMUM_VACANCY_EDITS_V1' };
}
