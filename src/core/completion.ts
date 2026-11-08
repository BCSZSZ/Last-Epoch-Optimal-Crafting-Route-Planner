import { itemKey, ordinary } from './catalog';
import { EvaluationInterruptedError, EvaluationLimitError, macroStep, predicateReached } from './evaluation';
import { exact, Interval, ONE, ratio, ZERO } from './interval';
import { completionRecommendation, REFERENCE_FP } from './policy';
import type { CompletionRecommendation } from './policy';
import { tierPermutations } from './probability';
import type { BalanceKernel, RuleEngine } from './rules';
import { targetReached } from './target';
import { programProjection } from './program-projection';
import type { Item, Macro, PlanRequest, Route } from './types';
import type { FixedFpReport } from './fixed-fp';

export interface CompletionReport {
  readonly fpStats?: FixedFpReport;
  readonly routeId: string;
  readonly initialFp: number;
  readonly status: 'COMPLETE' | 'INCOMPLETE';
  readonly probability: { readonly lower: number; readonly upper: number } | null;
  readonly recommendation: CompletionRecommendation;
  readonly evaluation: 'BOUNDED_NUMERICAL';
  readonly states: number;
  readonly reason: string | null;
}
interface Instruction { macro: Macro; next: number; yes: number; no: number; stage:number; path:string }
interface Edge { to: number; p: Interval }
interface Group { balances: BalanceKernel; edges: Edge[]; values: Interval[] }
interface Node { item: Item; pc: number; left: number | undefined; terminal: 'SUCCESS' | 'FAILURE' | null; groups: Group[]; path:string; action:boolean }

function compile(macros: readonly Macro[]) {
  const instructions: Instruction[] = [];
  const sequence = (values: readonly Macro[], next: number, outer?:number, prefix=''): number => {
    for (let i = values.length - 1; i >= 0; i--) {
      const macro = values[i];
      const stage=outer??i;
      const path = prefix ? `${prefix}.${i}` : String(i);
      const yes = macro.kind === 'conditional' ? sequence(macro.then, next,stage,`${path}.then`) : -1;
      const no = macro.kind === 'conditional' ? sequence(macro.otherwise ?? [], next,stage,`${path}.otherwise`) : -1;
      instructions.push({ macro, next, yes, no,stage,path }); next = instructions.length - 1;
    }
    return next;
  };
  return { instructions, entry: sequence(macros, -1) };
}

function graph(engine: RuleEngine, request: PlanRequest, route: Route, maximum: number, stop?: () => boolean,identityProjection=true): Node[] {
  const program = compile(route.macros), projection=identityProjection?programProjection(request,route,engine.catalog):null;
  const nodes: Node[] = [], indices = new Map<string, number>();
  const free: BalanceKernel = Array.from({ length: maximum + 1 }, (_, fp) => [{ value: fp, bounds: ONE }]);
  const intern = (item: Item, pc: number, left: number | undefined): number => {
    if(projection&&(pc<0 || program.instructions[pc].stage>projection.afterStage))item=projection.project(item);
    const key = `${pc}|${left ?? '*'}|${itemKey(item)}`;
    const found = indices.get(key); if (found !== undefined) return found;
    if (nodes.length >= request.search.maxStates) throw new EvaluationLimitError('达到48FP评价状态预算');
    const index = nodes.length; indices.set(key, index);
    nodes.push({ item, pc, left, terminal: targetReached(item, request.target) ? 'SUCCESS' : pc < 0 ? 'FAILURE' : null, groups: [], path:pc<0?'':program.instructions[pc].path,action:false });
    return index;
  };
  intern(request.item, program.entry, request.constraints.maxAttempts);
  let failure = -1, edgeCount = 0;
  const failed = () => {
    if (failure < 0) { failure = nodes.length; nodes.push({ item: request.item, pc: -1, left: 0, terminal: 'FAILURE', groups: [],path:'',action:false }); }
    return failure;
  };
  const add = (node: Node, to: number, p: Interval, balances: BalanceKernel) => {
    if (p.upper === 0) return;
    let group = node.groups.find(row => row.balances === balances);
    if (!group) { group = { balances, edges: [], values: [] }; node.groups.push(group); }
    const previous=projection?group.edges.find(edge=>edge.to===to):undefined;
    if(previous)group.edges[group.edges.indexOf(previous)]={to,p:previous.p.add(p)};
    else{group.edges.push({ to, p }); edgeCount++;}
    if (edgeCount > Math.min(2000000, request.search.maxStates * 128)) throw new EvaluationLimitError('达到48FP评价转移预算');
  };
  for (let i = 0; i < nodes.length; i++) {
    if ((i & 15) === 0 && stop?.()) throw new EvaluationInterruptedError('48FP评价已取消或超时');
    const node = nodes[i]; if (node.terminal) continue;
    const instruction = program.instructions[node.pc], { macro } = instruction;
    if (macro.kind === 'conditional') {
      add(node, intern(node.item, predicateReached(node.item, macro.when, request, engine) ? instruction.yes : instruction.no, node.left), ONE, free); continue;
    }
    const step = macroStep(macro, node.item, request, engine);
    if (step === 'SKIP') { add(node, intern(node.item, instruction.next, node.left), ONE, free); continue; }
    if (step === 'INAPPLICABLE' || node.left === 0) { node.terminal = 'FAILURE'; continue; }
    const kernel = engine.budgetTransition(node.item, step.action, request.craftingContext, maximum, {
      projectItem:projection&&(step.advance?(instruction.next<0||program.instructions[instruction.next].stage>projection.afterStage):instruction.stage>projection.afterStage)?projection.project:undefined,
      constraints: request.constraints, trackRolls: request.target.requirements.some(row => row.minRollByte !== undefined),
      maxOutcomes: Math.min(200000, Math.max(1000, request.search.maxStates * 64)),
    });
    if (kernel.issues.length) { node.terminal = 'FAILURE'; continue; }
    node.action = true;
    if ((macro.kind === 'repeat' || macro.kind === 'chaos') && step.action.kind === 'havoc' && node.left === undefined) {
      const slots = node.item.affixes.flatMap((row, index) => row.slot === 'ordinary' ? [index] : []);
      const layouts = tierPermutations(ordinary(node.item).map(row => row.tier));
      const goals = layouts.map(tiers => {
        const affixes = [...node.item.affixes]; slots.forEach((index, j) => { affixes[index] = { ...affixes[index], tier: tiers[j] }; });
        return { ...node.item, affixes };
      }).filter(item => targetReached(item, request.target) || predicateReached(item,
        macro.kind === 'repeat' ? macro.until : { kind: 'exists', selector: macro.selector }, request, engine));
      if (!goals.length) { node.terminal = 'FAILURE'; continue; }
      // Changed-layout Havoc is a complete graph. All non-goal layouts share this first-hit law.
      const balances = kernel.outcomes[0].balances, hit = ratio(goals.length, layouts.length - 1);
      for (const goal of goals) add(node, intern(goal, macro.kind === 'chaos' ? node.pc : instruction.next, undefined),
        ratio(1, layouts.length - 1), balances);
      add(node, i, hit.complement(), balances);
    } else for (const outcome of kernel.outcomes) {
      add(node, outcome.abort ? failed() : intern(outcome.item, step.advance ? instruction.next : node.pc,
        node.left === undefined ? undefined : node.left - 1), new Interval(outcome.probability.lower, outcome.probability.upper), outcome.balances);
    }
  }
  return nodes;
}

/** Certify a common inverse bound for the same-balance matrix. Paid transitions only go to lower balances. */
function prepare(nodes: readonly Node[], stop?: () => boolean) {
  const reverse = nodes.map(() => [] as number[]), reachable = new Set<number>();
  nodes.forEach((node, i) => node.groups.forEach(group => group.edges.forEach(edge => { if (edge.p.upper > 0) reverse[edge.to].push(i); })));
  const queue = nodes.flatMap((node, i) => node.terminal === 'SUCCESS' ? [i] : []);
  queue.forEach(i => reachable.add(i));
  for (let cursor = 0; cursor < queue.length; cursor++) for (const prior of reverse[queue[cursor]]) if (!reachable.has(prior)) { reachable.add(prior); queue.push(prior); }
  const active = nodes.flatMap((node, i) => !node.terminal && reachable.has(i) ? [i] : []), allowed = new Set(active);
  const rows = nodes.map(node => {
    const row = new Map<number, Interval>(); let success = ZERO;
    for (const group of node.groups) {
      const free = group.balances[1].find(entry => entry.value === 1)?.bounds ?? ZERO;
      for (const edge of group.edges) {
        const p = free.mul(edge.p);
        if (allowed.has(edge.to)) row.set(edge.to, (row.get(edge.to) ?? ZERO).add(p));
        else if (nodes[edge.to].terminal === 'SUCCESS') success = success.add(p);
      }
    }
    return { edges: [...row].map(([to, p]) => ({ to, p })), success };
  });
  const h = new Float64Array(nodes.length), value = new Float64Array(nodes.length);
  if (!active.length) return { active, rows, h };
  for (let iteration = 0; iteration < 10000; iteration++) {
    if ((iteration & 15) === 0 && stop?.()) throw new EvaluationInterruptedError('48FP零费用核已取消或超时');
    let change = 0;
    for (let cursor = active.length - 1; cursor >= 0; cursor--) {
      const i = active[cursor]; let next = 1, self = 0;
      for (const edge of rows[i].edges) if (edge.to === i) self += edge.p.midpoint; else next += edge.p.midpoint * value[edge.to];
      next /= 1 - self; change = Math.max(change, Math.abs(next - value[i])); value[i] = next;
    }
    if (iteration < 2 || (change > 1e-8 && iteration % 32 !== 31)) continue;
    let margin = Infinity;
    for (const i of active) {
      const q = rows[i].edges.reduce((sum, edge) => sum.add(edge.p.mul(exact(value[edge.to] + 1))), ZERO);
      margin = Math.min(margin, exact(value[i] + 1).sub(q).lower);
    }
    if (margin <= 1e-8) continue;
    const scale = (1 + 1e-6) / margin;
    for (const i of active) h[i] = (value[i] + 1) * scale;
    if (active.every(i => exact(h[i]).sub(rows[i].edges.reduce((sum, edge) => sum.add(edge.p.mul(exact(h[edge.to]))), ZERO)).lower >= 1)) {
      return { active, rows, h };
    }
  }
  throw new EvaluationLimitError('尚未证实48FP零费用回路的误差界');
}

export function evaluateCompletion(engine: RuleEngine, request: PlanRequest, route: Route, stop?: () => boolean,
  initialFp = request.initialFp ?? engine.catalog.model.practicalPolicy?.referenceFp ?? REFERENCE_FP,identityProjection=true,includeFp=false): CompletionReport {
  if (!Number.isInteger(initialFp) || initialFp < 0 || initialFp > engine.catalog.model.fpMaximum) throw new RangeError('参考FP超出模型范围');
  if (initialFp === 0) {
    const p = Number(targetReached(request.item, request.target));
    return { routeId: route.id, initialFp, status: 'COMPLETE', probability: { lower: p, upper: p },
      recommendation: completionRecommendation({ lower: p, upper: p }, engine.catalog.model.practicalPolicy), evaluation: 'BOUNDED_NUMERICAL', states: 1, reason: null,
      ...(includeFp ? { fpStats:{initialFp,totalExpectedFp:0,successExpectedFp:p?0:null,macros:{}} } : {}) };
  }
  const nodes = graph(engine, request, route, initialFp, stop,identityProjection), sys = prepare(nodes, stop);
  let bounds = nodes.map(node => node.terminal === 'SUCCESS' ? ONE : ZERO);
  const project = (fp: number) => nodes.forEach(node => node.groups.forEach(group => {
    group.values[fp] = group.edges.reduce((sum, edge) => sum.add(edge.p.mul(bounds[edge.to])), ZERO).clamp(0, 1);
  }));
  project(0);
  for (let fp = 1; fp <= initialFp; fp++) {
    if (stop?.()) throw new EvaluationInterruptedError('48FP余额递推已取消或超时');
    const source = nodes.map((node, i) => node.groups.reduce((sum, group) => group.balances[fp].reduce((value, row) =>
      row.value < fp ? value.add(row.bounds.mul(group.values[row.value])) : value, sum), sys.rows[i].success));
    const values = new Float64Array(nodes.length);
    for (let iteration = 0; iteration < 10000; iteration++) {
      if ((iteration & 15) === 0 && stop?.()) throw new EvaluationInterruptedError('48FP概率核已取消或超时');
      let change = 0;
      for (let cursor = sys.active.length - 1; cursor >= 0; cursor--) {
        const i = sys.active[cursor]; let next = source[i].midpoint, self = 0;
        for (const edge of sys.rows[i].edges) if (edge.to === i) self += edge.p.midpoint; else next += edge.p.midpoint * values[edge.to];
        next /= 1 - self; change = Math.max(change, Math.abs(next - values[i])); values[i] = next;
      }
      if (change < 1e-12) break;
      if (iteration === 9999) throw new EvaluationLimitError('48FP概率递推未在执行预算内收敛');
    }
    let residual = 0;
    for (const i of sys.active) {
      const error = sys.rows[i].edges.reduce((sum, edge) => sum.add(edge.p.mul(exact(values[edge.to]))), source[i]).sub(exact(values[i]));
      residual = Math.max(residual, -error.lower, error.upper);
    }
    bounds = nodes.map((node, i) => {
      if (node.terminal) return node.terminal === 'SUCCESS' ? ONE : ZERO;
      const error = exact(sys.h[i]).mul(exact(residual)), value = exact(values[i]);
      return new Interval(Math.max(0, value.sub(error).lower), Math.min(1, value.add(error).upper));
    });
    project(fp);
  }
  const probability = bounds[0].report();
  return { routeId: route.id, initialFp, status: 'COMPLETE', probability, recommendation: completionRecommendation(probability, engine.catalog.model.practicalPolicy),
    evaluation: 'BOUNDED_NUMERICAL', states: nodes.length, reason: null,
    ...(includeFp ? { fpStats:fixedRewards(nodes,initialFp,(probability.lower+probability.upper)/2,stop) } : {}) };
}

/** Occupation rewards reuse the very same joint state/cost graph as completion.
 * Deterministic branch/skip nodes are collapsed before summing free loops. */
function fixedRewards(nodes: readonly Node[], maximum: number, probability: number, stop?:()=>boolean): FixedFpReport {
  const n=nodes.length, resolved=new Int32Array(n).fill(-1);
  const resolve=(s:number):number=>{
    if(resolved[s]>=0)return resolved[s]; const chain:number[]=[];let t=s;
    while(!nodes[t].terminal&&!nodes[t].action){
      if(resolved[t]>=0){t=resolved[t];break;}
      if(chain.includes(t)||nodes[t].groups.length!==1||nodes[t].groups[0].edges.length!==1)throw new EvaluationLimitError('非制作分支无法解析');
      chain.push(t);t=nodes[t].groups[0].edges[0].to;
    }
    resolved[t]=t;for(const k of chain)resolved[k]=t;resolved[s]=t;return t;
  };
  const entries=new Map<string,number>(), costs=new Map<string,number>();
  const groups=nodes.map(node=>node.groups.map(group=>({balances:group.balances,values:group.values,
    mass:group.edges.reduce((sum,e)=>sum+e.p.midpoint,0),
    free:Array.from({length:maximum+1},(_,fp)=>group.balances[fp].find(b=>b.value===fp)?.bounds.midpoint??0),
    edges:group.edges.map(e=>({to:resolve(e.to),p:e.p.midpoint}))})));
  const active=nodes.flatMap((node,s)=>node.action&&!node.terminal?[s]:[]);
  const incoming=Array.from({length:maximum+1},()=>new Float64Array(n));const root=resolve(0);
  if(maximum>0&&!nodes[root].terminal){incoming[maximum][root]=1;entries.set(nodes[root].path,1);}
  let successMoment=0;
  for(let fp=maximum;fp>0;fp--){
    if(stop?.())throw new EvaluationInterruptedError('FP统计已取消');
    let wave=incoming[fp];const visits=new Float64Array(n);
    for(let iteration=0;iteration<256;iteration++){
      const next=new Float64Array(n);let mass=0;
      for(const s of active)if(wave[s]>0){
        visits[s]+=wave[s];for(const g of groups[s])for(const e of g.edges)if(!nodes[e.to].terminal){const w=wave[s]*g.free[fp]*e.p;next[e.to]+=w;mass+=w;}
      }
      if(mass<1e-14)break;wave=next;
      if(iteration===255)throw new EvaluationLimitError('FP免费回路统计未收敛');
    }
    for(const s of active)if(visits[s]>0){
      const path=nodes[s].path;
      for(const g of groups[s])for(const b of g.balances[fp]){
        const w=visits[s]*b.bounds.midpoint,spent=fp-b.value;
        costs.set(path,(costs.get(path)??0)+w*spent*g.mass);
        successMoment+=w*spent*g.values[b.value].midpoint;
        for(const e of g.edges)if(!nodes[e.to].terminal&&b.value>0){
          const amount=w*e.p;
          if(b.value<fp)incoming[b.value][e.to]+=amount;
          const to=nodes[e.to].path;if(to!==path)entries.set(to,(entries.get(to)??0)+amount);
        }
      }
    }
  }
  const total=[...costs.values()].reduce((a,b)=>a+b,0);
  if(total>maximum+1e-6)throw new EvaluationLimitError('实际FP消耗超过初始FP');
  const macros=Object.fromEntries([...new Set([...costs.keys(),...entries.keys()])].map(path=>{
    const entered=entries.get(path)??0,cost=costs.get(path)??0;return[path,{expectedEntries:entered,totalFpContribution:cost,expectedFp:entered?cost/entered:0}];
  }));
  return{initialFp:maximum,totalExpectedFp:total,successExpectedFp:probability>0?successMoment/probability:null,macros};
}
