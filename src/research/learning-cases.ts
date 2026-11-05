/** Expert demonstrations are evaluation targets, never inputs to the program generator. */
import { compileDraft, emptyDraft } from '../core/draft';
import { catalogForInputModel } from '../core/input-model';
import type { Macro, PlanRequest, Route, Selector } from '../core/types';

type Recipe = 'OPEN_AND_SEAL' | 'INTERLEAVED' | 'OWNED_UNION' | 'OWNED_T1' | 'READY';
export interface LearningCase {
  readonly id: string;
  readonly request: PlanRequest;
  readonly teacher: Route;
  readonly bestKnown: Route;
}
const final: Macro = { kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'target' } };
const add = (id: number): Macro => ({ kind: 'once', action: { kind: 'add', id, glyph: 'hope' } });

function demonstration(request: PlanRequest, recipe: Recipe, combined = false): Route {
  const catalog = catalogForInputModel(request.inputModel), ids = request.target.requirements.map(row => row.ids[0]);
  const missing = ids.filter(id => !request.item.affixes.some(row => row.slot === 'ordinary' && row.id === id));
  const selector = (side: 0 | 1, tiers: readonly number[]): Selector => ({ side, excludedIds: ids,
    minTier: Math.min(...tiers), maxTier: Math.max(...tiers), sealable: true });
  const prep = (select: Selector): Macro => ({ kind: 'repeat', action: { kind: 'havoc', glyph: 'hope' }, until: { kind: 'exists', selector: select } });
  let macros: readonly Macro[];
  if (recipe === 'OPEN_AND_SEAL') {
    if (missing.length !== 2 || catalog.side(missing[0]) !== catalog.side(missing[1])) throw new Error('Expected two missing same-side targets');
    const junk = selector(catalog.side(missing[0]) as 0 | 1, [1]);
    macros = [add(missing[0]), prep(junk), { kind: 'seal', selector: junk }, add(missing[1]), final];
  } else if (recipe === 'INTERLEAVED') {
    const [a, b] = ids;
    if (missing.length !== 2 || catalog.side(a) === catalog.side(b)) throw new Error('Expected two missing split-side targets');
    const afterRemoval = (first: number, last: number): readonly Macro[] => {
      const junk = selector(catalog.side(last) as 0 | 1, combined ? [1, 2] : [1, 2, 3, 4]);
      return [add(first), ...(combined ? [prep(junk)] : []), { kind: 'seal', selector: junk }, add(last)];
    };
    macros = [{ kind: 'removal', glyph: 'hope', accepted: { excludedIds: ids, minTier: 1, maxTier: 6, eligibleAction: 'removal' } },
      { kind: 'conditional', when: { kind: 'count', selector: { side: catalog.side(a) as 0 | 1 }, minimum: 2 },
        then: afterRemoval(b, a), otherwise: afterRemoval(a, b) }, final];
  } else if (recipe === 'READY') macros = [final];
  else {
    if (missing.length !== 1) throw new Error('Expected one missing target');
    const tiers = recipe === 'OWNED_T1' ? [1] : [...new Set(request.item.affixes.filter(row => row.slot === 'ordinary' && row.tier < 7).map(row => row.tier))];
    const junk = selector(catalog.side(missing[0]) as 0 | 1, tiers);
    macros = [prep(junk), { kind: 'seal', selector: junk }, add(missing[0]), final];
  }
  return { id: `expert-${recipe}-${combined ? 'combined' : 'original'}`, macros };
}

export function learningCase(id: string, tiers: readonly number[], marked: readonly number[], desired: readonly [number, number], recipe: Recipe,
  fpType: PlanRequest['item']['fpType'] = 'NORMAL', part: number | null = 1): LearningCase {
  const draft = emptyDraft(), keys = ['prefix1', 'prefix2', 'suffix1', 'suffix2'] as const;
  const slots = { ...draft.slots };
  keys.forEach((key, index) => { slots[key] = { tier: tiers[index], id: null, isTarget: marked.includes(index) }; });
  const compiled = compileDraft({ ...draft, part, fpType, slots, counts: [{ desired: desired[0] }, { desired: desired[1] }] });
  if (compiled.issues.length || compiled.scenarios.length !== 1) throw new Error(`Bad learning input ${id}: ${JSON.stringify(compiled.issues)}`);
  const input = compiled.scenarios[0].request;
  const request: PlanRequest = { ...input, constraints: { allowedActions: ['add', 'havoc', 'seal', 'removal'] },
    search: { milliseconds: 60000, maxRoutes: 100000, macroStages: 64, maxStates: 5000 } };
  const teacher = demonstration(request, recipe);
  return { id, request, teacher, bestKnown: recipe === 'INTERLEAVED' && tiers.includes(3) && tiers.includes(2) ? demonstration(request, recipe, true) : teacher };
}

export function trainingCases(fpType: PlanRequest['item']['fpType'] = 'NORMAL', part: number | null = 1): readonly LearningCase[] {
  return [learningCase('7710-new-prefixes', [1, 0, 7, 7], [], [2, 0], 'OPEN_AND_SEAL', fpType, part),
    learningCase('7732-new-split', [7, 3, 7, 2], [], [1, 1], 'INTERLEAVED', fpType, part),
    learningCase('7271-owned-prefix2', [7, 2, 7, 1], [1], [2, 0], 'OWNED_UNION', fpType, part)];
}

/** Held out from the round definitions: side/slot changes, tier changes, FP and catalog identities. */
export function validationCases(): readonly LearningCase[] {
  return [
    learningCase('7710-suffix-mirror', [7, 7, 1, 0], [], [0, 2], 'OPEN_AND_SEAL'),
    learningCase('7710-empty-first', [0, 1, 7, 7], [], [2, 0], 'OPEN_AND_SEAL'),
    learningCase('7732-low-tiers-swapped', [7, 2, 7, 3], [], [1, 1], 'INTERLEAVED'),
    learningCase('7732-native-order-swapped', [3, 7, 2, 7], [], [1, 1], 'INTERLEAVED'),
    learningCase('7722-both-missing', [7, 2, 7, 2], [], [1, 1], 'INTERLEAVED'),
    learningCase('7742-both-missing', [7, 4, 7, 2], [], [1, 1], 'INTERLEAVED'),
    learningCase('7721-owned-t7', [7, 2, 7, 1], [0], [1, 1], 'OWNED_T1'),
    learningCase('7172-owned-t7-mirror', [7, 1, 7, 2], [2], [1, 1], 'OWNED_T1'),
    learningCase('7271-owned-suffix2-mirror', [7, 1, 7, 2], [3], [0, 2], 'OWNED_UNION'),
    learningCase('7273-unseen-stop-window', [7, 2, 7, 3], [1], [2, 0], 'OWNED_UNION'),
    learningCase('7374-unseen-stop-window', [7, 3, 7, 4], [1], [2, 0], 'OWNED_UNION'),
    learningCase('202-identities-ready', [7, 1, 7, 2], [1, 3], [1, 1], 'READY'),
    ...(['ICE', 'BLOOD'] as const).flatMap(fp => trainingCases(fp).map(row => ({ ...row, id: `${row.id}-${fp}` }))),
    ...([4, null] as const).flatMap(part => trainingCases('NORMAL', part).map(row => ({ ...row, id: `${row.id}-${part === null ? 'ANY' : 'GLOVES'}` }))),
  ];
}
