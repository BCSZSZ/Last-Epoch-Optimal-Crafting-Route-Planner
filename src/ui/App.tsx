import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MODEL_ID } from '../core/catalog';
import { compileDraft, DRAFT_SLOTS, draftAffixPool, emptyDraft, maximumGoalCount, ownedGoalCounts, readDraft, withDraftSlots } from '../core/draft';
import type { CompiledDraft, CraftingDraft, DraftScenario, DraftSlot, DraftSlots } from '../core/draft';
import { catalogForInputModel } from '../core/input-model';
import type { IntrinsicReport } from '../core/intrinsic';
import type { PlanProgress, PlanReport } from '../core/planner';
import { MAXIMUM_SUCCESS_FP } from '../core/policy';
import { REFERENCE_FP } from '../core/policy';
import type { CompletionReport } from '../core/completion';
import { completionPercent } from './completion-view';
import { BrowserPlanner } from '../execution/browser';
import { affixName, affixSearchText, fpNames, typeName } from './labels';
import { routeSteps } from './route-view';
import type { RouteStep } from './route-view';

const catalog = catalogForInputModel('FORGEABLE_WEIGHTED');
const STORAGE = 'le-crafting-draft-v2';
const parts = [...new Set(catalog.model.bases.filter((row) => row.ordinaryEquipment && !row.corrupted && !row.obsolete && !row.legacy).map((row) => row.baseType))].sort((a, b) => a - b);
const number = (value: { lower: number; upper: number } | null | undefined) => !value ? '—' : value.upper - value.lower < 0.02 ? ((value.lower + value.upper) / 2).toFixed(2) : `${value.lower.toFixed(1)}–${value.upper.toFixed(1)}`;
const percent = (value: { lower: number; upper: number }) => value.upper - value.lower < 1e-5 ? `${((value.lower + value.upper) * 50).toFixed(2)}%` : `${(value.lower * 100).toFixed(1)}–${(value.upper * 100).toFixed(1)}%`;

function initialDraft(): CraftingDraft {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) {
      const value = JSON.parse(raw), migrated = readDraft(value);
      if (migrated && value.version === 2 && !localStorage.getItem(`${STORAGE}.before-v3`)) localStorage.setItem(`${STORAGE}.before-v3`, raw);
      return migrated ?? emptyDraft();
    }
  }
  catch { /* Optional local preferences. */ }
  return emptyDraft();
}

function AffixDropdown({ value, pool, disabled, label, target, onChange }: {
  value: number | null; pool: readonly number[]; disabled: boolean; label: string; target: boolean; onChange: (id: number | null) => void;
}) {
  const id = useId(), root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? pool.filter(entry => affixSearchText(catalog, entry).includes(needle)) : pool;
  }, [pool, query]);
  const options: readonly (number | null)[] = [null, ...visible];
  const blank = target ? '任意词条' : '不指定词条';
  const choose = (entry: number | null) => { onChange(entry); setOpen(false); };
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, open, id]);
  return <div className="affix-dropdown" ref={root}>
    <button type="button" className={`affix-trigger ${value === null ? 'placeholder' : ''}`} role="combobox" aria-label={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} disabled={disabled}
      title={value === null ? undefined : `${catalog.affix(value).name} · #${value}`}
      onClick={() => { setOpen(!open); setQuery(''); setActive(0); }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setQuery(''); setActive(0); }
      }}><span>{value === null ? blank : affixName(catalog, value)}</span><span aria-hidden="true">⌄</span></button>
    {open && <div className="affix-popup">
      <input ref={search} type="search" placeholder="搜索词条" aria-label={`${label}搜索`} value={query} aria-controls={`${id}-list`}
        aria-activedescendant={`${id}-option-${active}`} onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); setOpen(false); root.current?.querySelector('button')?.focus(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(0, Math.min(options.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)))); }
          if (event.key === 'Enter') { event.preventDefault(); choose(options[active] ?? null); }
        }} />
      <div id={`${id}-list`} role="listbox" aria-label={`${label}候选`} className="affix-options">
        {options.map((entry, index) => <button type="button" role="option" id={`${id}-option-${index}`} key={entry ?? 'blank'}
          data-affix-id={entry === null ? undefined : entry} title={entry === null ? undefined : `${catalog.affix(entry).name} · #${entry}`}
          aria-selected={entry === value} className={index === active ? 'highlight' : ''} onPointerMove={() => setActive(index)} onClick={() => choose(entry)}>
          {entry === null ? blank : affixName(catalog, entry)}{entry === value && <span aria-hidden="true">✓</span>}
        </button>)}
        {!visible.length && <span className="no-options">没有匹配的词条</span>}
      </div>
    </div>}
  </div>;
}

function SlotEditor({ slots, part, target = false, markTargets = false, onChange }: {
  slots: DraftSlots; part: number | null; target?: boolean; markTargets?: boolean;
  onChange: (slots: DraftSlots, confirmedSide?: 0 | 1) => void;
}) {
  const update = (key: keyof DraftSlots, slot: DraftSlot, confirmedSide?: 0 | 1) => onChange({ ...slots, [key]: slot }, confirmedSide);
  return <div className="slots">{DRAFT_SLOTS.map((descriptor) => {
    const slot = slots[descriptor.key], label = `${target ? '目标' : '起始'}${descriptor.label}`;
    const pool = draftAffixPool(catalog, part, descriptor.side, slot.tier);
    return <div className={`slot-card ${descriptor.slot === 'sealed' ? 'sealed-slot' : ''}`} key={descriptor.key}>
      <div className="slot-heading"><span>{descriptor.label}</span>{markTargets && descriptor.side !== null ?
        <label className={`target-check ${!slot.tier ? 'disabled' : ''}`}><input type="checkbox" checked={Boolean(slot.isTarget)} disabled={!slot.tier}
          aria-label={`${label}已是目标词缀`} onChange={(event) => update(descriptor.key, { ...slot, isTarget: event.target.checked }, descriptor.side)} />已是目标词缀</label> :
        <small>{slot.tier || (target ? '不限制' : '空槽')}</small>}</div>
      <div className="tier-row" role="group" aria-label={`${label}T级`}>{Array.from({ length: 8 }, (_, tier) => <button type="button" key={tier}
        aria-label={`${label}${tier ? `T${tier}` : target ? '不限' : '空'}`} aria-pressed={slot.tier === tier}
        className={slot.tier === tier ? `selected ${tier === 7 ? 'tier-seven' : ''}` : ''}
        onClick={() => update(descriptor.key, { tier, id: tier && slot.id !== null && draftAffixPool(catalog, part, descriptor.side, tier).includes(slot.id) ? slot.id : null,
          isTarget: tier > 0 && Boolean(slot.isTarget) })}>{tier || (target ? '不限' : '空')}</button>)}</div>
      <AffixDropdown value={slot.id} pool={pool} disabled={!slot.tier} label={`${label}词条`} target={target}
        onChange={(id) => update(descriptor.key, { ...slot, id })} />
    </div>;
  })}</div>;
}

function CountButtons({ label, value, minimum = 0, maximum = 2, onChange }: { label: string; value: number; minimum?: number; maximum?: number; onChange: (n: number) => void }) {
  return <div className="count-row"><span>{label}</span><div role="group" aria-label={label} className="count-buttons">{[0, 1, 2].map((n) =>
    <button type="button" key={n} disabled={n < minimum || n > maximum && n >= value} aria-label={`${label}${n}`} aria-pressed={value === n} className={value === n ? 'selected' : ''} onClick={() => onChange(n)}>{n}</button>)}</div></div>;
}

function CountGoals({ draft, onChange }: { draft: CraftingDraft; onChange: (counts: CraftingDraft['counts']) => void }) {
  return <div className="count-goals">{([0, 1] as const).map((side) => {
    const name = side === 0 ? '前缀' : '后缀', row = ownedGoalCounts(draft, side);
    return <fieldset className="count-card" key={side}><legend>目标{name}</legend>
      <CountButtons label={`${name}目标T7数`} value={row.desired} minimum={row.owned} maximum={maximumGoalCount(draft, side)}
        onChange={(desired) => onChange(side === 0 ? [{ desired }, draft.counts[1]] : [draft.counts[0], { desired }])} />
      <div className="count-row"><span>{name}已有目标词条数</span><output className="readonly-count" aria-label={`${name}已有目标词条数`}>{row.owned}</output></div>
      <div className="count-row"><span>{name}已有目标T7数</span><output className="readonly-count" aria-label={`${name}已有目标T7数`}>{row.ownedT7}</output></div>
    </fieldset>;
  })}{!!draft.legacyOwnership?.length && <p className="helper migration-note" role="status">旧输入需在左侧确认已有目标的位置：{draft.legacyOwnership.map(row =>
    `${row.side === 0 ? '前缀' : '后缀'}已有${row.owned}条，其中T7为${row.ownedT7}条`).join('；')}。</p>}
    <p className="helper">目标T7合计不超过起始普通槽的T7数。已有数量由左侧勾选统计。</p></div>;
}

function StepInstructions({ step }: { step: RouteStep }) {
  return <><h3>{step.title}</h3>{step.condition && <p>{step.condition}</p>}{step.branches && <details className="branch-details"><summary>查看分支</summary>
    {step.branches.map((branch) => <div className="macro-branch" key={branch.label}><p>{branch.label}{branch.steps.length ? '' : '：跳过'}</p>
      {branch.steps.map((part, index) => <div className="branch-step" key={index}><StepInstructions step={part} /></div>)}</div>)}</details>}</>;
}

function RouteSteps({ row, scenario }: { row: IntrinsicReport; scenario: DraftScenario }) {
  const macros = row.route.macros.slice(0, row.intrinsic.evaluatedThroughStage);
  const steps = routeSteps(macros, scenario.request, catalogForInputModel(scenario.request.inputModel), scenario.aliases);
  return steps.length ? <ol className="route-list">{steps.map((step, index) => <li key={index}><div><StepInstructions step={step} /></div></li>)}</ol> : <p className="already-done">{row.intrinsic.decision === 'RETAINED' ? '目标已经达成，无需制作。' : '此模板未执行制作。'}</p>;
}

function RouteMetrics({ row, completion }: { row: IntrinsicReport; completion?: CompletionReport | null }) {
  return <div className="metrics"><div><span>{row.intrinsic.probabilityMeaning === 'FULL_ROUTE' ? '成功率' : '成功率上界'}</span><strong>{row.intrinsic.probabilityMeaning === 'FULL_ROUTE' ? percent(row.score) : `≤${(row.score.upper * 100).toFixed(2)}%`}</strong></div>
    <div><span>整件完成率（{completion?.initialFp ?? REFERENCE_FP} FP）</span><strong>{completion?.probability ? completionPercent(completion.probability) : completion?.status === 'INCOMPLETE' ? '未算完' : '—'}</strong></div>
    <div><span>{row.intrinsic.fpMeaning === 'PREFIX_GIVEN_PREFIX_SURVIVAL' ? '截至此步的过关平均 FP' : row.intrinsic.successfulFpLowerBound !== null ? '成功路径平均 FP 下界' : '成功路径平均 FP'}</span>
      <strong>{row.intrinsic.successfulFpLowerBound !== null ? `≥${row.intrinsic.successfulFpLowerBound.toFixed(2)}` : number(row.expectedFpGivenSuccess)}</strong></div></div>;
}

function saveJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ScenarioResult { readonly scenario: DraftScenario; readonly report: PlanReport }
function ScenarioResults({ scenario, report }: ScenarioResult) {
  const primary = report.primary as IntrinsicReport | null;
  const abandoned = [...report.abandoned ?? []].sort((a, b) => b.scoreEstimate - a.scoreEstimate || (a.expectedFpGivenSuccess?.lower ?? Infinity) - (b.expectedFpGivenSuccess?.lower ?? Infinity));
  const shown = primary ?? abandoned[0];
  const recommendation = report.completion?.recommendation;
  const badge = !primary ? shown ? '已放弃' : '未找到方案' : recommendation === 'RECOMMENDED' ? '推荐' :
    recommendation === 'NOT_RECOMMENDED' ? '不推荐' : report.completion?.status === 'INCOMPLETE' || recommendation === 'UNRESOLVED' ? '完成率待确定' : '当前方案';
  return <section className="result-card">
    <div className="result-heading"><h2>{scenario.condition || '规划方案'}</h2><span className={`badge ${!primary || recommendation === 'NOT_RECOMMENDED' ? 'amber' : recommendation !== 'RECOMMENDED' ? 'neutral' : ''}`}>{badge}</span></div>
    {report.issues.length > 0 && <ul className="error-message">{report.issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
    {shown && <><RouteMetrics row={shown} completion={primary ? report.completion : null} /><RouteSteps row={shown} scenario={scenario} />
      {!primary && <p className="abandon-note">已放弃 · 已算至第 {shown.intrinsic.evaluatedThroughStage} 步 · {shown.intrinsic.reason === 'ABOVE_MAXIMUM_SUCCESS_FP' ? `成功路径平均 FP 已超过 ${shown.intrinsic.maximumSuccessFp}` : shown.intrinsic.reason === 'NO_SUCCESS_EXIT' ? '该模板没有成功出口' : '成功率已低于 15%'}</p>}</>}
    {!shown && <p className="helper">当前计算范围尚未得到可用结果。</p>}
    <div className="result-tools"><button type="button" className="text-button" onClick={() => saveJson({ schemaVersion: 1, input: scenario.request, report }, 'last-epoch-crafting-report.json')}>导出报告</button>
      {abandoned.length > 0 && <details><summary>已放弃方案（{abandoned.length}）</summary><div className="abandoned-list">{abandoned.map((row, index) => <details key={row.route.id}><summary>已放弃 · 方案 {index + 1} · 已算至第 {row.intrinsic.evaluatedThroughStage} 阶段</summary><RouteMetrics row={row} /><RouteSteps row={row} scenario={scenario} /></details>)}</div></details>}
    </div>
    <details className="search-scope"><summary>计算说明</summary><p>已计算 {report.search.evaluatedRoutes} 个模板。{report.searchStatus === 'INCOMPLETE' ? '部分候选尚未完成，未证明最优。' : '本次模板范围已完成，不代表全局最优。'}</p>
      <p>成功率不计FP耗尽；整件完成率按起始{REFERENCE_FP}FP完整结算。整件完成率低于25%标不推荐，高于65%标推荐，等于门槛时不额外标记。</p>
      {report.completion?.reason && <p>{report.completion.reason}</p>}
      {report.hierarchy && <p>结构预排除 {report.hierarchy.structurallyRejected} 个候选；数值上界／下界预检与实际计算记录保留在导出报告。</p>}
      {!!report.hierarchy?.preExcluded?.length && <p>已放弃 {report.hierarchy.preExcluded.length} 个封印／剥离组合：成功率上界最高 {(Math.max(...report.hierarchy.preExcluded.map((row) => row.probabilityUpperBound)) * 100).toFixed(2)}%，无需展开后续计算。</p>}</details>
  </section>;
}

export function App() {
  const [draft, setDraft] = useState<CraftingDraft>(initialDraft), [compiled, setCompiled] = useState<CompiledDraft | null>(null);
  const [results, setResults] = useState<readonly ScenarioResult[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const planner = useRef<BrowserPlanner | null>(null), controller = useRef<AbortController | null>(null), generation = useRef(0);
  if (!planner.current) planner.current = new BrowserPlanner();
  useEffect(() => () => { generation.current++; planner.current?.dispose(); }, []);
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(draft)); } catch { /* Optional local preferences. */ } }, [draft]);
  const edit = (next: CraftingDraft) => {
    generation.current++; controller.current?.abort(); setBusy(false); setProgress(null); setResults([]); setCompiled(null); setMessage(''); setDraft(next);
  };
  const changePart = (part: number | null) => {
    const clean = (slots: DraftSlots): DraftSlots => Object.fromEntries(DRAFT_SLOTS.map(slot => [slot.key, { ...slots[slot.key],
      id: slots[slot.key].id !== null && draftAffixPool(catalog, part, slot.side, slots[slot.key].tier).includes(slots[slot.key].id!) ? slots[slot.key].id : null }])) as unknown as DraftSlots;
    edit({ ...draft, part, slots: clean(draft.slots), targetSlots: clean(draft.targetSlots) });
  };
  const run = async () => {
    controller.current?.abort(); const job = ++generation.current, abort = new AbortController(); controller.current = abort;
    const value = compileDraft(draft); setCompiled(value); setResults([]); setMessage(''); setProgress(null);
    if (value.issues.length) { setMessage(value.issues.map((issue) => issue.message).join(' ')); return; }
    setBusy(true);
    try {
      const completed: ScenarioResult[] = [];
      for (const scenario of value.scenarios) {
        const report = await planner.current!.plan(scenario.request, { signal: abort.signal,
          onProgress: (update) => { if (generation.current === job) setProgress(update); } });
        if (generation.current !== job) return;
        completed.push({ scenario, report }); setResults([...completed]);
      }
    } catch (error) { if (generation.current === job) setMessage(error instanceof Error && error.name === 'AbortError' ? '已取消规划。' : error instanceof Error ? error.message : '计算失败，请重试。'); }
    finally { if (generation.current === job) { setBusy(false); setProgress(null); } }
  };
  return <div className="app-shell">
    <header className="page-header"><span className="brand-mark" aria-hidden="true">◇</span><div><span className="brand-kicker">LAST EPOCH</span><h1>打造路线规划</h1></div></header>
    <main>
      <div className="editors">
        <section className="panel input-panel" aria-label="起始装备"><div className="panel-title"><span className="panel-index">01</span><h2>起始装备</h2></div>
          <fieldset className="part-field"><legend>装备部位</legend><div className="part-buttons" role="group" aria-label="装备部位">
            <button type="button" aria-pressed={draft.part === null} className={draft.part === null ? 'selected' : ''} onClick={() => changePart(null)}>任意</button>
            {parts.map(part => <button type="button" key={part} aria-pressed={draft.part === part} className={draft.part === part ? 'selected' : ''}
              onClick={() => changePart(part)}>{typeName(part, String(part))}</button>)}</div></fieldset>
          <div className="fp-row" role="group" aria-label="潜能类型">{(['NORMAL', 'ICE', 'BLOOD'] as const).map((fpType) => <button type="button" key={fpType} aria-pressed={draft.fpType === fpType} className={draft.fpType === fpType ? 'selected' : ''} onClick={() => edit({ ...draft, fpType })}>{fpNames[fpType]}</button>)}</div>
          <SlotEditor slots={draft.slots} part={draft.part} markTargets={draft.targetMode === 'COUNTS'}
            onChange={(slots, side) => edit(withDraftSlots(draft, slots, side))} />
        </section>
        <section className="panel target-panel" aria-label="目标装备"><div className="panel-title"><span className="panel-index">02</span><h2>目标装备</h2></div>
          <div className="mode-tabs" role="group" aria-label="目标填写方式">{([{ key: 'COUNTS', text: '简易目标' }, { key: 'SLOTS', text: '详细目标' }] as const).map((mode) => <button type="button" key={mode.key} aria-pressed={draft.targetMode === mode.key} className={draft.targetMode === mode.key ? 'selected' : ''} onClick={() => edit({ ...draft, targetMode: mode.key })}>{mode.text}</button>)}</div>
          {draft.targetMode === 'COUNTS' ? <CountGoals draft={draft} onChange={(counts) => edit({ ...draft, counts })} /> :
            <><p className="helper target-helper">留空的槽位不限制；只选 T 级表示至少达到该阶，不限具体词条。</p><SlotEditor slots={draft.targetSlots} part={draft.part} target onChange={(targetSlots) => edit({ ...draft, targetSlots })} /></>}
        </section>
      </div>
      <section className="planning-controls" aria-label="规划控制"><button type="button" className="plan-button" disabled={busy} onClick={() => void run()}>{busy ? '正在规划…' : '开始规划'}<span aria-hidden="true">↗</span></button>
        {busy && <div className="planning-status" role="status"><span className="spinner" /><span>{progress ? `正在比较路线，已计算 ${progress.evaluatedRoutes} 个方案…` : '正在加载计算模块…'}</span><button type="button" className="text-button" onClick={() => controller.current?.abort()}>取消</button></div>}
        {message && <p role="alert" className="error-message">{message}</p>}
      </section>
      {results.length > 0 && compiled && <section className="results" aria-label="规划结果" aria-live="polite">
        <div className="results-heading"><h2>规划结果</h2><span className="badge">{compiled.inputModel === 'FORGEABLE_ANY_EQUAL' ? '通用等权参考' : compiled.inputModel === 'FORGEABLE_EQUAL' ? '等权参考' : '实际词条权重 · 通用池'}</span></div>
        {results.map((result) => <ScenarioResults key={result.scenario.key} {...result} />)}
        <p className="result-conventions">成功率假设 FP 持续充足；整件完成率按起始 {REFERENCE_FP} FP。剥离失手或必要封印失败即停止。FP 均值只统计最终成功路线，超过 {MAXIMUM_SUCCESS_FP} FP 放弃。材料无限。</p>
        <details className="assumptions"><summary>计算假设</summary>{compiled.assumptions.map((assumption) => <p key={assumption}>{assumption}</p>)}<p>独立随机参考模型；已搜索的模板范围不代表全局最优。</p><p className="model-id">{MODEL_ID}</p></details>
      </section>}
    </main>
    <footer><span>Last Epoch {catalog.model.gameVersion}<br />默认希望雕文；封印用绝望，混沌用混沌。</span><a href="https://github.com/BCSZSZ/Last-Epoch-Optimal-Crafting-Route-Planner" target="_blank" rel="noreferrer">研究与源代码 ↗</a></footer>
  </div>;
}
