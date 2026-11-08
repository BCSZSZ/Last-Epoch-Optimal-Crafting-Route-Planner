import type { CompactGraph, CompactState, CompactAction } from './finite-state';
import type { CompactSolution } from './finite-solver';
import { tierPermutations } from './probability';

export interface FinitePlanStep {
  readonly key: string;
  readonly id: number;
  readonly operation: string;
  readonly criterion: string;
  /** Actual48FP-policy cost per entry into this phase, including repeats until
   * acceptance, switching phase, or termination. Not a sampled FP difference. */
  readonly expectedFp: number;
  readonly expectedEntries: number;
  readonly totalFpContribution: number;
  readonly next: readonly number[];
}
export interface FiniteStepPlan {
  readonly steps: readonly FinitePlanStep[];
  readonly main: readonly number[];
  readonly costMeaning: 'ACTUAL48_PHASE_COST_PER_ENTRY';
  readonly totalExpectedFp: number;
}
const names = ['前缀1', '前缀2', '后缀1', '后缀2'];
function key(state: CompactState, action: CompactAction): string {
  if (action.kind === 'havoc') return state.roles.includes(1) && state.roles.includes(2) ? 'havoc:finish' :
    `havoc:${state.roles.join('')}:${[...state.tiers].sort().join('')}:${state.sealed}`;
  if (action.kind === 'redemption') return `redemption:${[1, 2].map(r => Number(state.roles.includes(r))).join('')}`;
  if (action.kind === 'removal') return 'removal';
  if (action.kind === 'add') return `add:${action.role}:${action.role === 3 ? action.slot! >> 1 : ''}`;
  return `${action.kind}:${action.slot}:${action.kind === 'upgrade' ? state.tiers[action.slot!] : ''}`;
}
const operation = (state: CompactState, action: CompactAction) => {
  if (action.kind === 'havoc') return '浩劫';
  if (action.kind === 'redemption') return '救赎';
  if (action.kind === 'removal') return '剥离';
  if (action.kind === 'add') return action.role === 3 ? '补占位词缀' : `添加目标${action.role === 1 ? 'A' : 'B'}`;
  if (action.kind === 'seal') return `封印${names[action.slot!]}`;
  if (action.kind === 'chaos') return `混沌重掷${names[action.slot!]}`;
  return `升级${names[action.slot!]}至T${state.tiers[action.slot!] + 1}`;
};

/** Find short, exact tier predicates within the phase's finite Havoc layouts.
 * A term is only accepted when it does not also match a continuing layout. */
function layoutCriterion(state: CompactState, exits: ReadonlySet<string>): string {
  const all = tierPermutations(state.tiers), wanted = all.filter(t => exits.has(t.join('')));
  if (!wanted.length) return '满足后续步骤的词缀条件';
  const remaining = new Set(wanted.map(t => t.join(''))), terms: string[] = [];
  const atoms: { mask: number; text: string }[] = [];
  for (let slot = 0; slot < 4; slot++) {
    const ts = [...new Set(all.map(t => t[slot]))].sort((a, b) => a - b);
    for (let subset = 1; subset < 2 ** ts.length - 1; subset++) {
      const selected = ts.filter((_, i) => subset & 2 ** i), mask = all.reduce((m, t, i) => selected.includes(t[slot]) ? m | 2 ** i : m, 0);
      atoms.push({ mask, text: !selected.includes(7) && selected.length === ts.length - 1 && ts.includes(7) ? `${names[slot]}不为T7` : `${names[slot]}为${selected.map(t => `T${t}`).join('或')}` });
    }
  }
  const allowedMask = all.reduce((m, t, i) => exits.has(t.join('')) ? m | 2 ** i : m, 0);
  while (remaining.size) {
    let best: { mask: number; text: string; coverage: number } | null = null;
    const consider = (mask: number, text: string) => {
      if (!mask || (mask & allowedMask) !== mask) return;
      const coverage = all.reduce((n, t, i) => n + Number(Boolean(mask & 2 ** i) && remaining.has(t.join(''))), 0);
      if (coverage && (!best || coverage > best.coverage)) best = { mask, text, coverage };
    };
    for (const a of atoms) consider(a.mask, a.text);
    if (!best) for (const a of atoms) for (const b of atoms) consider(a.mask & b.mask, `${a.text}且${b.text}`);
    const chosen = best as { mask: number; text: string } | null;
    if (chosen) { terms.push(chosen.text); all.forEach((t, i) => { if (chosen.mask & 2 ** i) remaining.delete(t.join('')); }); }
    else { const text = remaining.values().next().value!; remaining.delete(text); terms.push([...text].map((t, i) => `${names[i]}为T${t}`).join('、')); }
  }
  return terms.length === 1 ? terms[0] : terms.map(t => `（${t}）`).join('或');
}

/** Forward occupation measure of the submitted optimal policy. Each phase's
 * contribution includes every branch and re-entry. Same-FP free loops are a
 * convergent Neumann sum; no chosen success example supplies these costs. */
export function buildFiniteSteps(graph: CompactGraph, solution: CompactSolution, root: number): FiniteStepPlan {
  if (root < 2) return { steps: [], main: [], costMeaning: 'ACTUAL48_PHASE_COST_PER_ENTRY', totalExpectedFp: 0 };
  interface Phase { state: CompactState; action: CompactAction; entries: number; cost: number; exits: Set<string>; next: Map<number, number>; successNext: Map<number, number>; fpSensitive: boolean; layouts: Map<string, Set<boolean>> }
  const phases: Phase[] = [], ids = new Map<string, number>(), n = graph.states.length;
  const phaseIndex = Array.from({ length: 49 }, () => new Int16Array(n).fill(-2));
  const sameFp = solution.costs.map(() => new Float64Array(49));
  for (let k = 0; k < solution.costs.length; k++) for (let fp = 1; fp <= 48; fp++) sameFp[k][fp] = solution.costs[k][fp].find(b => b.fp === fp)?.p ?? 0;
  const phaseAt = (s: number, fp: number): number => {
    if (s < 2 || !fp) return -1;
    if (phaseIndex[fp][s] !== -2) return phaseIndex[fp][s];
    const a = solution.policies[fp][s]; if (a < 0) { phaseIndex[fp][s] = -1; return -1; }
    const state = graph.states[s]!, action = graph.actions[s][a].action, k = key(state, action); let id = ids.get(k);
    if (id === undefined) { id = phases.length; ids.set(k, id); phases.push({ state, action, entries: 0, cost: 0, exits: new Set(), next: new Map(), successNext: new Map(), fpSensitive: false, layouts: new Map() }); }
    phaseIndex[fp][s] = id; return id;
  };
  const first = phaseAt(root, 48); if (first < 0) return { steps: [], main: [], costMeaning: 'ACTUAL48_PHASE_COST_PER_ENTRY', totalExpectedFp: 0 };
  phases[first].entries = 1;
  const incoming = Array.from({ length: 49 }, () => new Float64Array(n)); incoming[48][root] = 1;
  for (let fp = 48; fp > 0; fp--) {
    let wave = incoming[fp]; const visits = new Float64Array(n);
    for (let iteration = 0; iteration < 128; iteration++) {
      const next = new Float64Array(n); let mass = 0;
      for (let s = 2; s < n; s++) if (wave[s] > 0) {
        const a = solution.policies[fp][s]; if (a < 0) continue; const w = wave[s]; visits[s] += w;
        for (const e of graph.actions[s][a].edges) if (e.to >= 2) {
          const free = sameFp[e.kernel][fp];
          const amount = w * e.p * free; next[e.to] += amount; mass += amount;
        }
      }
      if (mass < 1e-14) break; wave = next;
      if (iteration === 127) throw new Error('Step occupation measure did not converge');
    }
    for (let s = 2; s < n; s++) if (visits[s] > 0) {
      const a = solution.policies[fp][s]; if (a < 0) continue;
      const id = phaseAt(s, fp), phase = phases[id];
      for (const e of graph.actions[s][a].edges) if (e.p > 0) for (const b of solution.costs[e.kernel][fp]) if (b.p > 0) {
        const amount = visits[s] * e.p * b.p, to = phaseAt(e.to, b.fp);
        phase.cost += amount * (fp - b.fp);
        if (b.fp < fp && e.to >= 2 && b.fp > 0) incoming[b.fp][e.to] += amount;
        if (to >= 0 && to !== id) {
          phases[to].entries += amount; phase.next.set(to, (phase.next.get(to) ?? 0) + amount);
          const successMass = amount * solution.values[b.fp][e.to];
          phase.successNext.set(to, (phase.successNext.get(to) ?? 0) + successMass);
        }
        if (phase.action.kind === 'havoc' && e.to >= 2 && b.fp > 0 && solution.values[b.fp][e.to] > 0) {
          const layout = graph.states[e.to]!.tiers.join(''), exit = to >= 0 && to !== id;
          if (!phase.layouts.has(layout)) phase.layouts.set(layout, new Set()); phase.layouts.get(layout)!.add(exit);
          if (exit) phase.exits.add(layout);
        }
      }
    }
  }
  const criterion = (phase: Phase): string => {
    const { state, action } = phase, slot = action.slot!;
    if (action.kind === 'havoc') {
      if (state.roles.includes(1) && state.roles.includes(2)) return '目标A、目标B均为T7';
      const sensitive = [...phase.layouts.values()].some(values => values.size > 1);
      return layoutCriterion(state, phase.exits) + (sensitive ? '；剩余FP对应的分支见条件路线' : '');
    }
    if (action.kind === 'redemption') {
      const missing = [1, 2].filter(r => !state.roles.includes(r));
      return missing.length === 2 ? '至少一条目标成为T7' : `目标${missing[0] === 1 ? 'A' : 'B'}成为T7`;
    }
    if (action.kind === 'seal') return `${names[slot]}进入封印栏`;
    if (action.kind === 'removal') return '保留两条T7，并空出可补词缀的位置';
    if (action.kind === 'add') return action.role === 3 ? '对应空槽已补上占位词缀' : `目标${action.role === 1 ? 'A' : 'B'}已添加`;
    if (action.kind === 'chaos') return `${names[slot]}重掷为该侧缺失目标`;
    return `${names[slot]}达到T${state.tiers[slot] + 1}`;
  };
  const main: number[] = [], seen = new Set<number>(); let current: number | undefined = first;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current); main.push(current + 1);
    current = [...phases[current].successNext.entries()].filter(([to, mass]) => !seen.has(to) && mass > 1e-15).sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  const total = phases.reduce((sum, phase) => sum + phase.cost, 0);
  if (Math.abs(total - solution.actualCosts[48][root]) > 1e-7) throw new Error('Step costs do not sum to whole-policy FP');
  const order = [...main.map(id => id - 1), ...phases.map((_, id) => id).filter(id => !seen.has(id))];
  const remap = new Map(order.map((id, index) => [id, index + 1]));
  return { costMeaning: 'ACTUAL48_PHASE_COST_PER_ENTRY', main: main.map(id => remap.get(id - 1)!), totalExpectedFp: total, steps: order.map(id => {
    const phase = phases[id]; return {
      key: key(phase.state, phase.action), id: remap.get(id)!, operation: operation(phase.state, phase.action), criterion: criterion(phase), expectedFp: phase.entries > 0 ? phase.cost / phase.entries : 0,
      expectedEntries: phase.entries, totalFpContribution: phase.cost, next: [...phase.next.entries()].sort((a, b) => b[1] - a[1]).map(([to]) => remap.get(to)!),
    };
  }) };
}
