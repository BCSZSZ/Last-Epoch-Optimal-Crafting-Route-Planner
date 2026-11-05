/** Research compiler: remove only slot/identity tests proved constant on continuing paths. */
import type { Catalog } from '../core/catalog';
import { ordinary } from '../core/catalog';
import type { Macro, PlanRequest, Predicate, Selector } from '../core/types';

interface Facts { p: number; s: number; targets: number; sealed: boolean }
type Truth = boolean | null;

export function compactProgram(macros: readonly Macro[], request: PlanRequest, catalog: Catalog): readonly Macro[] {
  const ids = request.target.requirements.flatMap(row => row.ids);
  const index = (id: number) => ids.indexOf(id);
  const admissible = (values: readonly Macro[]): boolean => values.every(macro => {
    if (macro.kind === 'conditional') return admissible(macro.then) && admissible(macro.otherwise ?? []);
    if (macro.kind === 'fill') return macro.ids.every(id => !ids.includes(id));
    if (macro.kind === 'once') return macro.action.kind === 'add' && ids.includes(macro.action.id);
    if (macro.kind === 'repeat') return macro.action.kind === 'havoc';
    return (macro.kind === 'seal' || macro.kind === 'removal') && ids.every(id =>
      (macro.kind === 'seal' ? macro.selector : macro.accepted).excludedIds?.includes(id));
  });
  if (!admissible(macros)) return macros;
  const truth = (predicate: Predicate, facts: Facts): Truth => {
    if (predicate.kind === 'identity') {
      const row = predicate.requirement;
      return row.ids.length === 1 && index(row.ids[0]) >= 0 && row.minTier === 1 && row.maxTier === 8 && row.slot === 'ordinary' &&
        row.minRollByte === undefined ? Boolean(facts.targets & 1 << index(row.ids[0])) : null;
    }
    if (predicate.kind === 'count' && predicate.selector.side !== undefined &&
      Object.entries(predicate.selector).every(([key, value]) => key === 'side' || value === undefined)) {
      return (predicate.selector.side === 0 ? facts.p : facts.s) >= predicate.minimum;
    }
    if (predicate.kind === 'all' || predicate.kind === 'any') {
      const values = predicate.predicates.map(row => truth(row, facts));
      if (predicate.kind === 'all') return values.includes(false) ? false : values.every(value => value === true) ? true : null;
      return values.includes(true) ? true : values.every(value => value === false) ? false : null;
    }
    return null;
  };
  const advance = (macro: Macro, facts: Facts): Facts[] => {
    if (macro.kind === 'fill') return [{ ...facts, p: 2, s: 2 }];
    if (macro.kind === 'repeat') return [facts]; // Havoc preserves identities and ordinary counts.
    if (macro.kind === 'once' && macro.action.kind === 'add') {
      const id = macro.action.id, side = catalog.side(id), count = side === 0 ? facts.p : facts.s;
      if (facts.targets & 1 << index(id) || count >= 2) return [];
      return [{ ...facts, p: facts.p + Number(side === 0), s: facts.s + Number(side === 1), targets: facts.targets | 1 << index(id) }];
    }
    if (macro.kind === 'seal' || macro.kind === 'removal') {
      if (macro.kind === 'seal' && facts.sealed) return [];
      const selector: Selector = macro.kind === 'seal' ? macro.selector : macro.accepted;
      return ([0, 1] as const).flatMap(side => {
        if (selector.side !== undefined && selector.side !== side) return [];
        const count = side === 0 ? facts.p : facts.s;
        const targets = ids.filter((id, i) => catalog.side(id) === side && facts.targets & 1 << i).length;
        // Tier/eligibility restrictions are deliberately over-approximated, never guessed.
        return count <= targets ? [] : [{ ...facts, p: facts.p - Number(side === 0), s: facts.s - Number(side === 1),
          sealed: facts.sealed || macro.kind === 'seal' }];
      });
    }
    return [facts];
  };
  const unique = (values: readonly Facts[]) => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  const walk = (values: readonly Macro[], input: readonly Facts[]): Macro[] => {
    const output: Macro[] = [];
    let facts = input;
    for (let at = 0; at < values.length; at++) {
      const macro = values[at];
      if (macro.kind === 'conditional') {
        const yes = facts.filter(value => truth(macro.when, value) !== false);
        const no = facts.filter(value => truth(macro.when, value) !== true);
        if (!yes.length) return [...output, ...walk([...(macro.otherwise ?? []), ...values.slice(at + 1)], no)];
        if (!no.length) return [...output, ...walk([...macro.then, ...values.slice(at + 1)], yes)];
        // Specialize the shared continuation inside each branch, then factor equal suffixes back out.
        const left = walk([...macro.then, ...values.slice(at + 1)], yes);
        const right = walk([...(macro.otherwise ?? []), ...values.slice(at + 1)], no);
        const tail: Macro[] = [];
        while (left.length && right.length && JSON.stringify(left.at(-1)) === JSON.stringify(right.at(-1))) {
          tail.unshift(left.pop()!); right.pop();
        }
        return [...output, ...(left.length || right.length ? [{ ...macro, then: left, otherwise: right }] : []), ...tail];
      }
      if (macro.kind === 'fill' && facts.every(value => value.p === 2 && value.s === 2)) continue;
      output.push(macro);
      facts = unique(facts.flatMap(value => advance(macro, value)));
      if (!facts.length) break; // Preserve the failing action; its unreachable continuation is removed.
    }
    return output;
  };
  const rows = ordinary(request.item);
  return walk(macros, [{ p: rows.filter(row => catalog.side(row.id) === 0).length,
    s: rows.filter(row => catalog.side(row.id) === 1).length,
    targets: ids.reduce((mask, id, i) => mask | (rows.some(row => row.id === id) ? 1 << i : 0), 0),
    sealed: request.item.affixes.some(row => row.slot === 'sealed') }]);
}
