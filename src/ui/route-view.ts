import type { Catalog } from '../core/catalog';
import type { Macro, PlanRequest, Selector } from '../core/types';
import { affixName, macroText, predicateText } from './labels';
import type { NameAliases } from './labels';

export interface RouteStep {
  readonly title: string;
  readonly condition: string;
  readonly branches?: readonly { readonly label: string; readonly steps: readonly RouteStep[] }[];
}
type Knowledge = Map<number, boolean | null>;
const sameSelector = (a: Selector, b: Selector) => JSON.stringify({ ...a, side: undefined }) === JSON.stringify({ ...b, side: undefined });

function minimumSealSteps(macro: Macro, expectedSide?: number): readonly RouteStep[] | null {
  if (macro.kind !== 'conditional' || macro.when.kind !== 'exists' || macro.when.selector.side !== undefined ||
    macro.when.selector.ids !== undefined || macro.when.selector.excludedIds !== undefined || macro.when.selector.sealable !== undefined || macro.when.selector.eligibleAction !== undefined ||
    macro.when.selector.minTier !== 1 || macro.when.selector.maxTier !== 1 || macro.then.length !== 2 || macro.otherwise?.length !== 2) return null;
  const branches = [macro.then, macro.otherwise];
  let firstSelector: Selector | undefined;
  for (let i = 0; i < branches.length; i++) {
    const [prepare, seal] = branches[i], tier = i + 1;
    if (prepare.kind !== 'repeat' || prepare.action.kind !== 'havoc' || prepare.until.kind !== 'exists' || seal.kind !== 'seal' ||
      prepare.until.selector.minTier !== tier || prepare.until.selector.maxTier !== tier ||
      JSON.stringify(prepare.until.selector) !== JSON.stringify(seal.selector) || expectedSide !== undefined && seal.selector.side !== expectedSide) return null;
    const structure = { ...seal.selector, minTier: undefined, maxTier: undefined };
    if (firstSelector && JSON.stringify(firstSelector) !== JSON.stringify(structure)) return null;
    firstSelector = structure;
  }
  return [{ title: '浩劫直至最低阶落在无关词缀', condition: '有T1时用T1；补词暴击后没有T1时改用T2。' },
    { title: '封印', condition: '封印该无关词缀。' }];
}

/** Present the two symmetric vacancy branches once; original controller data remains in the exported report. */
function vacancySteps(macro: Extract<Macro, { kind: 'conditional' }>, catalog: Catalog, aliases: NameAliases): readonly RouteStep[] | null {
  const yes = macro.then, no = macro.otherwise ?? [], first = yes[0], other = no[0], last = yes.at(-1), otherLast = no.at(-1);
  if (macro.when.kind !== 'count' || macro.when.minimum !== 2 || macro.when.selector.side === undefined ||
    Object.entries(macro.when.selector).some(([key, value]) => key !== 'side' && value !== undefined) || yes.length !== no.length || yes.length < 3 ||
    first?.kind !== 'once' || first.action.kind !== 'add' || other?.kind !== 'once' || other.action.kind !== 'add' ||
    last?.kind !== 'once' || last.action.kind !== 'add' || otherLast?.kind !== 'once' || otherLast.action.kind !== 'add' ||
    first.action.id !== otherLast.action.id || other.action.id !== last.action.id ||
    catalog.side(first.action.id) === macro.when.selector.side || catalog.side(other.action.id) !== macro.when.selector.side) return null;
  const steps: RouteStep[] = [{ title: '添加词缀', condition: '先补入剥离空槽对应的目标词缀。' }];
  for (let i = 1; i < yes.length - 1; i++) {
    const a = yes[i], b = no[i];
    if (a.kind === 'seal' && b.kind === 'seal' && a.selector.side === catalog.side(last.action.id) &&
      b.selector.side === catalog.side(otherLast.action.id) && sameSelector(a.selector, b.selector)) {
      steps.push({ title: '封印', condition: `剩余${macroText({ ...a, selector: { ...a.selector, side: undefined } }, catalog, aliases).condition}` });
    } else if (a.kind === 'repeat' && b.kind === 'repeat' && a.action.kind === 'havoc' && b.action.kind === 'havoc' &&
      a.until.kind === 'exists' && b.until.kind === 'exists' && a.until.selector.side === catalog.side(last.action.id) &&
      b.until.selector.side === catalog.side(otherLast.action.id) && sameSelector(a.until.selector, b.until.selector)) {
      steps.push(macroText({ ...a, until: { kind: 'exists', selector: { ...a.until.selector, side: undefined } } }, catalog, aliases));
    } else if (minimumSealSteps(a, catalog.side(last.action.id)) && minimumSealSteps(b, catalog.side(otherLast.action.id))) {
      steps.push(...minimumSealSteps(a, catalog.side(last.action.id))!);
    } else return null;
  }
  steps.push({ title: '添加词缀', condition: '补入另一条目标词缀。' });
  return steps;
}

/** Only identity facts guaranteed on continuing paths are used to remove redundant UI checks. */
export function routeSteps(macros: readonly Macro[], request: PlanRequest, catalog: Catalog, aliases: NameAliases = {}): readonly RouteStep[] {
  const ids = new Set(request.target.requirements.flatMap((row) => row.ids));
  const initial: Knowledge = new Map([...ids].map((id) => [id, request.item.affixes.some((row) => row.id === id && row.slot === 'ordinary')]));
  const walk = (values: readonly Macro[], known: Knowledge, count: { value: number | null }): RouteStep[] => {
    const steps: RouteStep[] = [];
    const unknown = () => { for (const id of ids) known.set(id, null); };
    for (const macro of values) {
      if (macro.kind === 'conditional') {
        const predicate = macro.when, requirement = predicate.kind === 'identity' ? predicate.requirement : null;
        const id = requirement?.ids.length === 1 ? requirement.ids[0] : undefined;
        const fact = id === undefined ? undefined : known.get(id);
        if (requirement && requirement.slot === 'ordinary' && requirement.minTier === 1 && (requirement.maxTier ?? 8) === 8 &&
          requirement.minRollByte === undefined && (fact === true || fact === false)) {
          steps.push(...walk(fact ? macro.then : macro.otherwise ?? [], known, count)); continue;
        }
        const left = new Map(known), right = new Map(known), leftCount = { value: count.value }, rightCount = { value: count.value };
        const yes = walk(macro.then, left, leftCount), no = walk(macro.otherwise ?? [], right, rightCount);
        for (const entry of ids) known.set(entry, left.get(entry) === right.get(entry) ? left.get(entry)! : null);
        count.value = leftCount.value === rightCount.value ? leftCount.value : null;
        const merged = minimumSealSteps(macro) ?? vacancySteps(macro, catalog, aliases);
        if (merged) steps.push(...merged);
        else steps.push({ title: requirement && id !== undefined ? macro.then.length === 0 ? `补齐${affixName(catalog, id, aliases)}` : '补齐剩余目标词缀' : '按词缀情况分支', condition: '',
          branches: [{ label: `${predicateText(macro.when, catalog, aliases)}时`, steps: yes }, { label: '否则', steps: no }] });
        continue;
      }
      if (macro.kind === 'fill' && count.value === 4) continue;
      const text = macroText(macro, catalog, aliases);
      if (macro.kind === 'repeat' && macro.action.kind === 'havoc' && macro.until.kind === 'target' &&
        request.target.requirements.length === 2 && request.target.requirements.every((row) => row.ids.length === 1 && row.minTier === 7 && row.maxTier === 7)) {
        steps.push({ ...text, title: '浩劫直至两项目标均为T7' });
      } else steps.push(text);
      if (macro.kind === 'once' && macro.action.kind === 'add') { known.set(macro.action.id, true); if (count.value !== null) count.value++; }
      else if (macro.kind === 'fill') { count.value = 4; for (const id of ids) if (known.get(id) === false && macro.ids.includes(id)) known.set(id, null); }
      else if (macro.kind === 'seal' || macro.kind === 'removal') {
        if (count.value !== null) count.value--;
        const selector = macro.kind === 'seal' ? macro.selector : macro.accepted;
        for (const id of ids) if (known.get(id) !== false && !selector.excludedIds?.includes(id) && (!selector.ids || selector.ids.includes(id))) known.set(id, null);
      } else if (macro.kind === 'once' && macro.action.kind === 'seal') { known.set(macro.action.id, false); if (count.value !== null) count.value--; }
      else if (macro.kind === 'once' && macro.action.kind === 'removal') { if (count.value !== null) count.value--; for (const id of macro.action.acceptedIds) if (known.get(id) !== false) known.set(id, null); }
      else if (macro.kind === 'chaos' || macro.kind === 'once' && macro.action.kind === 'chaos') unknown();
      else if ((macro.kind === 'once' || macro.kind === 'repeat') && macro.action.kind === 'redemption') {
        unknown();
        if (macro.kind === 'repeat') {
          const predicates = macro.until.kind === 'all' ? macro.until.predicates : [macro.until];
          for (const predicate of predicates) if (predicate.kind === 'identity' && predicate.requirement.ids.length === 1 &&
            predicate.requirement.slot === 'ordinary') known.set(predicate.requirement.ids[0], true);
        }
      }
    }
    return steps;
  };
  return walk(macros, initial, { value: request.item.affixes.filter((row) => row.slot === 'ordinary').length });
}
