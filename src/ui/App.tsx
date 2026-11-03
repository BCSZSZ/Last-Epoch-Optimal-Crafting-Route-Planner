import { useEffect, useMemo, useRef, useState } from 'react';
import { Catalog, MODEL_ID } from '../core/catalog';
import { exampleRequest, examples } from '../core/examples';
import { parsePlanRequest } from '../core/request';
import type { PlanProgress, PlanReport } from '../core/planner';
import type { ActionKind, Affix, Macro, PlanRequest, Requirement, Slot } from '../core/types';
import { BrowserPlanner } from '../execution/browser';
import { ConsumptionChart, ProbabilityChart } from './charts';
import { actionNames, affixLabel, affixName, failureNames, fpNames, macroText, requirementText, slotNames, typeName } from './labels';

const catalog = new Catalog();
const middle = (value: { lower: number; upper: number }) => (value.lower + value.upper) / 2;
const number = (value: { lower: number; upper: number } | null | undefined) => !value ? '不适用' : value.upper - value.lower < 0.02 ? middle(value).toFixed(2) : `${value.lower.toFixed(1)}–${value.upper.toFixed(1)}`;
const percent = (value: { lower: number; upper: number }) => value.upper - value.lower < 1e-5 ? `${(middle(value) * 100).toFixed(2)}%` : `${(value.lower * 100).toFixed(1)}%–${(value.upper * 100).toFixed(1)}%`;
const STORAGE = 'le-crafting-input-v1';

function initialRequest(): PlanRequest {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) {
      const saved = JSON.parse(raw);
      // This released input schema shares the same audited game data; preserve edits while recomputing results.
      const value = saved?.modelId === 'le-1.5.3-iid-f58515921fd9cbcc' ? { ...saved, modelId: MODEL_ID } : saved;
      const parsed = parsePlanRequest(value, catalog); if (parsed.request) return parsed.request;
    }
  } catch { /* Storage is optional; an unavailable cache never prevents local planning. */ }
  return exampleRequest();
}

function AffixPicker({ value, pool, onChange, label }: { value: number; pool: readonly number[]; onChange: (id: number) => void; label: string }) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => pool.filter((id) => !query || `${id} ${affixName(catalog, id)} ${catalog.affix(id).name}`.toLowerCase().includes(query.toLowerCase())), [pool, query]);
  const options = [...new Set([value, ...visible])];
  return <div className="affix-picker"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选名称或ID" aria-label={`${label}筛选`} />
    <select value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label}>
      {options.map((id) => <option key={id} value={id}>{affixLabel(catalog, id)}</option>)}
    </select></div>;
}

function Download({ value, name, children }: { value: unknown; name: string; children: React.ReactNode }) {
  return <button type="button" className="text-button" onClick={() => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }}>{children}</button>;
}

function Results({ report }: { report: PlanReport }) {
  if (report.metric === 'INTRINSIC_V2') return <IntrinsicResults report={report} />;
  const primary = report.primary;
  if (!primary) return <section className="panel notice" aria-live="polite"><span className="eyebrow">计算报告</span>
    <h2>{report.status === 'INVALID_INPUT' ? '请修正输入' : '当前范围尚未找到路线'}</h2>
    {report.issues.length ? <ul>{report.issues.map((issue, i) => <li key={i}>{issue.message}{issue.path && <small>（{issue.path}）</small>}</li>)}</ul> :
      <p>已评价{report.search.evaluatedRoutes}条候选。{report.searchStatus === 'INCOMPLETE' ? '搜索未完成，不能据此判定装备不可达。可以增加搜索预算或调整明确的操作限制。' : '该结论只针对下方声明的候选语言和阶段范围。'}</p>}
    <p className="muted">搜索范围：{report.search.librarySize}类宏，最多{report.search.macroStages}阶段。</p>
  </section>;
  const estimated = primary.evaluationStatus === 'ESTIMATED';
  const domain = report.conventions.fpDomain;
  const uniform = report.conventions.weights.every((weight) => Math.abs(weight - 1 / domain.length) < 1e-12);
  return <div className="result-stack" aria-live="polite">
    <section className="panel result-hero">
      <div className="row between"><span className="eyebrow">{report.optimality === 'PROVEN_WITHIN_DECLARED_SCOPE' ? '范围内已证明最优' : '当前已找到的主推荐'}</span>
        <span className={`badge ${report.searchStatus === 'INCOMPLETE' ? 'amber' : ''}`}>{report.searchStatus === 'INCOMPLETE' ? '搜索未完成' : '声明范围已搜索完成'}</span></div>
      <div className="score">{(primary.scoreEstimate * 100).toFixed(2)}<span>%</span></div>
      <p className="score-caption">跨假设预算的加权成功率 J</p>
      <p className="muted">评分采用{domain[0]}–{domain.at(-1)}假设预算{uniform ? '各整数等权' : '自定义权重'}；不是玩家实际FP或自然掉落分布。</p>
      <div className="precision"><span className={`badge ${estimated ? 'amber' : 'mint'}`}>{estimated ? '直接采样估计' : '模型内区间计算'}</span>
        <span>{estimated ? `本次规划${(report.samplingGuarantee?.confidence ?? primary.sampling!.confidence) * 100}%联合统计区间：` : '算术区间：'}{percent(primary.score)}</span></div>
      {estimated && <p className="chart-note">{primary.sampling!.totalTrials.toLocaleString()}条完整路线采样；每次重抽均更新候选池。统计界已为本次规划的多候选比较分配置信度，不包含游戏机制模型与客户端的差异。</p>}
      <div className="stats"><div><span>总期望FP消耗</span><strong>{number(primary.expectedFp)}</strong></div><div><span>成功条件期望FP</span><strong>{number(primary.expectedFpGivenSuccess)}</strong></div>
        <div><span>宏阶段</span><strong>{primary.route.macros.length}</strong></div></div>
    </section>
    <section className="panel"><div className="row between"><h2>固定执行路线</h2><Download value={report} name="last-epoch-crafting-report.json">导出报告</Download></div>
      {primary.route.macros.length === 0 ? <p>起始装备已经满足全部目标，无需制作。</p> : <ol className="route-list">{primary.route.macros.map((macro, index) => {
        const text = macroText(macro, catalog);
        const stats = primary.macroStatistics[index];
        return <li key={index}><span className="step-number">{index + 1}</span><div><h3>{text.title}</h3><p>{text.condition}</p>
          <p className="macro-statistics">到达概率 {percent(stats.reachedProbability)} · 实际执行概率 {percent(stats.executedProbability)}<br />
            全路线平均贡献：{number(stats.expectedAttempts)} 次 · {number(stats.expectedFp)} FP</p>
          <details className="macro-conditional"><summary>到达本阶段后的平均</summary><p>尝试 {number(stats.expectedAttemptsGivenReached)} 次；净FP消耗 {number(stats.expectedFpGivenReached)}。</p></details>
        </div></li>;
      })}</ol>}
      {primary.route.macros.length > 0 && <p className="chart-note">以上按同一评分权重统计。到达包括零次跳过或因潜能不足停止；“全路线平均贡献”也包含未到达时的零消耗，各阶段FP贡献可相加为总期望消耗。</p>}
      <div className="stop-note">目标提前达成即停止；必要封印失败、剥离失手即终止。不要在途中重新选择路线，也不需要回填每次结果。</div>
    </section>
    <section className="panel"><h2>全预算成功率</h2><ProbabilityChart report={primary} /></section>
    <section className="panel"><h2>实际FP消耗</h2><ConsumptionChart report={primary} />
      <table><caption>评分权重下的消耗分位数</caption><thead><tr><th>路径</th><th>P50</th><th>P90</th><th>P95</th></tr></thead><tbody>
        <tr><th>全部</th><td>{number(primary.quantiles?.p50)}</td><td>{number(primary.quantiles?.p90)}</td><td>{number(primary.quantiles?.p95)}</td></tr>
        <tr><th>成功条件</th><td>{number(primary.successQuantiles?.p50)}</td><td>{number(primary.successQuantiles?.p90)}</td><td>{number(primary.successQuantiles?.p95)}</td></tr>
      </tbody></table>
      <p className="chart-note">失败路径的加权FP浪费：{number(primary.failedFpWaste)}。所有碎片、符文和雕文视为无限，不计材料代价。</p>
      <details><summary>失败原因</summary><ul className="reason-list">{primary.failureReasons.map((row) => <li key={row.reason}><span>{failureNames[row.reason] ?? '其他资格或停止条件'}</span><span>{percent(row.probability)}</span></li>)}</ul></details>
    </section>
    <section className="panel evidence"><h2>覆盖范围与证据</h2><p>评价{report.search.evaluatedRoutes}条候选，其中{report.search.exactRoutes}条区间计算、{report.search.estimatedRoutes}条采样；剪去{report.search.certifiedPrunedPrefixes}个有证上界低于已知推荐的前缀。</p>
      <p>有限宏语言v1包含{report.search.librarySize}类宏，最长{report.search.macroStages}阶段。耗时{(report.search.elapsedMilliseconds / 1000).toFixed(2)}秒。{report.optimality === 'NOT_PROVEN' && '尚未证明此路线全局最优。'}</p>
      <details><summary>模型与计算约定</summary><p>{report.qualification}</p><p>游戏版本{report.gameVersion} · 模型{report.modelId}。</p>
        {!uniform && <p>各预算归一化权重：{report.conventions.weights.map((weight, index) => `${domain[index]}:${weight.toPrecision(3)}`).join('，')}。</p>}
        <p>状态树和完整候选分布保留在计算模块内；此报告仅含主推荐与摘要。不同设备若在不同预算位置停止，未完成搜索的当前推荐可能不同。</p>
        <p><a href="https://github.com/BCSZSZ/Last-Epoch-Optimal-Crafting-Route-Planner/tree/codex/bootstrap/docs" target="_blank" rel="noreferrer">机制审计、数学模型与源代码</a></p></details>
    </section>
  </div>;
}

function MacroInstructions({ macro }: { macro: Macro }) {
  const text = macroText(macro, catalog);
  if (macro.kind !== 'conditional') return <><h3>{text.title}</h3><p>{text.condition}</p></>;
  return <><h3>{text.title}</h3>{[{ label: '条件成立', steps: macro.then }, { label: '条件不成立', steps: macro.otherwise ?? [] }].map((branch) =>
    <div className="macro-branch" key={branch.label}><p className="macro-branch-label">{branch.label}{branch.steps.length ? '：执行以下步骤' : '：跳过'}</p>
      {branch.steps.map((part, index) => <div className="macro-branch-step" key={index}><MacroInstructions macro={part} /></div>)}
    </div>)}</>;
}

function IntrinsicResults({ report }: { report: PlanReport }) {
  const primary = report.primary, structure = report.hierarchy?.structure;
  return <div className="result-stack" aria-live="polite">
    <section className="panel result-hero"><div className="row between"><span className="eyebrow">{structure ? `${structure.node.group} · 普通${structure.node.ordinaryCount}条 · 封印${structure.node.sealedCount}条` : '固定模板计算'}</span>
      <span className={`badge ${report.searchStatus === 'INCOMPLETE' ? 'amber' : 'mint'}`}>{report.searchStatus === 'INCOMPLETE' ? '搜索未完成' : '模板范围已完成'}</span></div>
      {primary ? <><div className="score">{(primary.scoreEstimate * 100).toFixed(2)}<span>%</span></div><p className="score-caption">操作成功率</p>
        <p className="muted">假设FP持续充足；误剥、必要封印失败即NG。100%操作成功率不保证实际剩余FP足够。</p>
        <div className="stats"><div><span>成功路径平均FP</span><strong>{number(primary.expectedFpGivenSuccess)}</strong></div><div><span>已放弃模板</span><strong>{report.abandoned?.length ?? 0}</strong></div><div><span>主路线阶段</span><strong>{primary.route.macros.length}</strong></div></div>
        <p className="chart-note">仅最终成功路径参与FP均值；保留成功率≥15%、平均FP≤100的路线。模型内成功率区间：{percent(primary.score)}。</p></> :
        <><h2>{report.abandoned?.length ? '当前已算模板均未通过门槛' : '当前范围尚未找到路线'}</h2><p>{report.searchStatus === 'INCOMPLETE' ? '仍有未完成或未覆盖候选，不能据此判定装备不可达。' : '此结论仅针对已声明的模板范围。'}</p></>}
    </section>
    {primary && <section className="panel"><div className="row between"><h2>固定执行路线</h2><Download value={report} name="last-epoch-crafting-report.json">导出报告</Download></div>
      {primary.route.macros.length ? <ol className="route-list">{primary.route.macros.map((macro, index) => <li key={index}><span className="step-number">{index + 1}</span><div><MacroInstructions macro={macro} /></div></li>)}</ol> : <p>两个目标已经达成，无需制作。</p>}
      <div className="stop-note">目标提前达成即停止；所有条件分支预先固定。必要封印失败、剥离失手后不执行后续步骤。</div>
    </section>}
    {!!report.abandoned?.length && <section className="panel"><h2>已放弃</h2><p className="chart-note">低于15%的过关概率上界，或高于100FP的成功条件成本下界，才会触发放弃。执行预算不足单独记为未完成。</p>
      {report.abandoned.map((row) => <details key={row.route.id}><summary>已放弃 · 已算至第{row.intrinsic.evaluatedThroughStage}阶段 · {row.route.description ?? row.route.id}</summary>
        <p>{row.intrinsic.probabilityMeaning === 'FULL_ROUTE' ? '整路操作成功率' : '截至该阶段的过关概率（整路成功率上界）'}：{percent(row.score)}</p>
        <p>{row.intrinsic.fpMeaning === 'LOWER_BOUND_GIVEN_FINAL_SUCCESS' ? '成功路径平均FP下界' : row.intrinsic.fpMeaning === 'PREFIX_GIVEN_PREFIX_SURVIVAL' ? '该前缀过关条件下的平均FP' : '成功路径平均FP'}：{row.intrinsic.successfulFpLowerBound !== null ? `≥${row.intrinsic.successfulFpLowerBound.toFixed(2)}` : number(row.expectedFpGivenSuccess)}</p>
        <p>{row.intrinsic.reason === 'ABOVE_MAXIMUM_SUCCESS_FP' ? '已证明成功路径平均FP超过100。' : row.intrinsic.reason === 'NO_SUCCESS_EXIT' ? '此模板没有可达成功出口。' : '已证明整路成功率低于15%。'}</p>
        <ol>{row.route.macros.slice(0, row.intrinsic.evaluatedThroughStage).map((macro, index) => <li key={index}>{macroText(macro, catalog).title}</li>)}</ol>
      </details>)}
    </section>}
    <section className="panel evidence"><h2>计算范围</h2><p>已评价{report.search.evaluatedRoutes}个固定模板，放弃{report.abandoned?.length ?? 0}个，未完成{report.unresolvedRoutes ?? 0}个。耗时{(report.search.elapsedMilliseconds / 1000).toFixed(2)}秒。</p>
      {report.hierarchy && <p>28个入口标签合并为23个上层节点；本装备生成{report.hierarchy.generatedTemplates}个可用模板，按结构或明确限制排除{report.hierarchy.structurallyRejected}个候选。</p>}
      <p>当前推荐尚未证明全游戏最优。所有碎片、符文和雕文无限，不计材料代价。</p>
      <details><summary>模型、精度与约定</summary><p>{report.qualification}</p><p>费用与装备变化联合计算；循环吸收核用数值残差界验证。新指标不使用初始FP预算轴，未另外计算有限FP曲线和分位数。</p><p>游戏{report.gameVersion} · 模型{report.modelId}</p></details>
    </section>
  </div>;
}

export function App() {
  const [request, setRequest] = useState<PlanRequest>(initialRequest);
  const [report, setReport] = useState<PlanReport | null>(null);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedExample, setSelectedExample] = useState('7710-direct');
  const [alternativeFor, setAlternativeFor] = useState<number | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const planner = useRef<BrowserPlanner | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  if (!planner.current) planner.current = new BrowserPlanner();
  useEffect(() => () => { generation.current++; planner.current?.dispose(); }, []);
  useEffect(() => { try { localStorage.setItem(STORAGE, JSON.stringify(request)); } catch { /* Optional preference storage. */ } }, [request]);

  const edit = (next: PlanRequest) => {
    generation.current++; controller.current?.abort(); controller.current = null;
    const ids = new Set(next.item.affixes.map((row) => row.id));
    const consistent = { ...next, constraints: { ...next.constraints, protected: next.constraints.protected?.filter((row) => ids.has(row.id)) } };
    setBusy(false); setReport(null); setProgress(null); setMessage(''); setRequest(consistent);
  };
  const updateAffix = (index: number, next: Partial<Affix>) => edit({ ...request, item: { ...request.item,
    affixes: request.item.affixes.map((row, i) => i === index ? { ...row, ...next } : row) }, constraints: { ...request.constraints,
      protected: request.constraints.protected?.map((row) => row.id === request.item.affixes[index].id && next.id !== undefined ? { ...row, id: next.id } : row) } });
  const updateTarget = (index: number, next: Partial<Requirement>) => edit({ ...request, target: { requirements: request.target.requirements.map((row, i) => i === index ? { ...row, ...next } : row) } });
  const pool = useMemo(() => catalog.model.affixes.filter((row) => row.side < 2 && [0, 1, 2].includes(row.special) && catalog.canRollOn(row.id, request.item.baseId)).map((row) => row.id), [request.item.baseId]);
  const types = [...new Set(catalog.model.bases.filter((row) => row.ordinaryEquipment).map((row) => row.baseType))];
  const base = catalog.base(request.item.baseId);
  const bases = catalog.model.bases.filter((row) => row.baseType === base.baseType);
  const addAffix = (slot: Slot) => {
    const ids = new Set(request.item.affixes.map((row) => row.id));
    const ordinary = request.item.affixes.filter((row) => row.slot === 'ordinary');
    const candidate = pool.find((id) => !ids.has(id) && catalog.affix(id).special === 0 &&
      (slot !== 'ordinary' || ordinary.filter((row) => catalog.side(row.id) === catalog.side(id)).length < 2));
    if (candidate === undefined) return;
    edit({ ...request, item: { ...request.item, affixes: [...request.item.affixes, { id: candidate, tier: slot === 'primordial' ? 8 : 1, slot, roll: null }] } });
  };
  const run = async () => {
    const parsed = parsePlanRequest(request, catalog);
    if (!parsed.request) { setReport(null); setMessage(parsed.issues.map((row) => row.message).join('；')); return; }
    controller.current?.abort();
    const id = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setReport(null); setMessage(''); setProgress(null);
    try {
      const result = await planner.current!.plan(parsed.request, { signal: abort.signal, onProgress: (value) => { if (id === generation.current) setProgress(value); } });
      if (id === generation.current && !abort.signal.aborted) setReport(result);
    } catch (error) {
      if (id === generation.current) setMessage(error instanceof Error && error.name === 'AbortError' ? '计算已取消。' : error instanceof Error ? error.message : '计算失败，请重试');
    } finally { if (id === generation.current) { setBusy(false); controller.current = null; } }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setMessage('输入JSON不得超过2MiB。'); return; }
    try {
      const parsed = parsePlanRequest(JSON.parse(await file.text()), catalog);
      if (!parsed.request) setMessage(parsed.issues.map((row) => row.message).join('；'));
      else edit(parsed.request);
    } catch { setMessage('无法读取输入JSON；原输入保持不变。'); }
  };

  return <><header className="site-header"><div className="brand-mark" aria-hidden="true">◇</div><div><span className="eyebrow">LAST EPOCH · CRAFTING ROUTE PLANNER</span><h1>制作路线规划</h1></div>
    <span className="version">游戏 {catalog.model.gameVersion}<br /><span>本地代码规则模型</span></span></header>
    <main className="workspace"><section className="editor-stack" aria-label="装备与目标编辑">
      <section className="intro"><h2>从这件装备，找到一条路线。</h2><p>填入起始装备和最终目标，自动比较固定宏路线。无需输入剩余FP，也无需逐步回填制作结果。</p>
        <div className="example-row"><select aria-label="常见打造样例" value={selectedExample} onChange={(event) => setSelectedExample(event.target.value)}>{examples.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
          <button type="button" onClick={() => edit(exampleRequest(selectedExample))}>载入样例</button></div>
      </section>
      <section className="panel"><div className="section-title"><span>01</span><h2>起始装备</h2></div>
        <div className="field-grid"><label>部位<select value={base.baseType} onChange={(event) => { const first = catalog.model.bases.find((row) => row.baseType === Number(event.target.value)); if (first) edit({ ...request, item: { ...request.item, baseId: first.id } }); }}>
          {types.map((id) => <option key={id} value={id}>{typeName(id, catalog.model.bases.find((row) => row.baseType === id)!.typeName)}</option>)}</select></label>
          <label>底材<select value={request.item.baseId} onChange={(event) => edit({ ...request, item: { ...request.item, baseId: event.target.value } })}>{bases.map((row) => <option key={row.id} value={row.id}>{row.name}{row.legacy || row.obsolete ? '（旧版）' : ''} · {row.id}</option>)}</select></label>
          <label>角色等级<input type="number" min="1" max="100" value={request.craftingContext.playerLevel} onChange={(event) => edit({ ...request, craftingContext: { playerLevel: Number(event.target.value) } })} /></label>
          <label>物品等级<input type="number" min="1" max="100" value={request.item.itemLevel} onChange={(event) => edit({ ...request, item: { ...request.item, itemLevel: Number(event.target.value) } })} /></label></div>
        <fieldset className="potential"><legend>潜能类型</legend>{(['NORMAL', 'ICE', 'BLOOD'] as const).map((type) => <label key={type} className={request.item.fpType === type ? 'selected' : ''}><input type="radio" name="fpType" checked={request.item.fpType === type} onChange={() => edit({ ...request, item: { ...request.item, fpType: type } })} />{fpNames[type]}</label>)}</fieldset>
        <div className="affix-list">{request.item.affixes.map((affix, index) => <div className={`affix-row ${affix.tier >= 6 ? 'exalted' : ''}`} key={index}>
          <div className="affix-meta"><span>{affix.slot === 'ordinary' ? catalog.side(affix.id) === 0 ? '前缀' : catalog.side(affix.id) === 1 ? '后缀' : '特殊' : slotNames[affix.slot]}</span><span>原生序 {index + 1}</span></div>
          <AffixPicker value={affix.id} pool={pool} label={`起始词缀${index + 1}`} onChange={(id) => updateAffix(index, { id })} />
          <div className="row affix-controls"><label>阶数<select value={affix.tier} onChange={(event) => updateAffix(index, { tier: Number(event.target.value) })}>{Array.from({ length: catalog.affix(affix.id).tiers.length }, (_, i) => i + 1).map((tier) => <option key={tier} value={tier}>T{tier}</option>)}</select></label>
            <label>槽位<select value={affix.slot} onChange={(event) => updateAffix(index, { slot: event.target.value as Slot })}>{Object.entries(slotNames).filter(([slot]) => slot !== 'any').map(([slot, name]) => <option key={slot} value={slot}>{name}</option>)}</select></label>
            <div className="row compact"><button type="button" title="上移原生顺序" aria-label={`上移词缀${index + 1}`} disabled={index === 0} onClick={() => { const rows = [...request.item.affixes]; [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]]; edit({ ...request, item: { ...request.item, affixes: rows } }); }}>↑</button>
              <button type="button" className="danger-quiet" aria-label={`删除词缀${index + 1}`} onClick={() => edit({ ...request, item: { ...request.item, affixes: request.item.affixes.filter((_, i) => i !== index) } })}>×</button></div></div>
        </div>)}</div>
        <div className="row wrap"><button type="button" onClick={() => addAffix('ordinary')} disabled={request.item.affixes.filter((row) => row.slot === 'ordinary').length >= 4}>＋ 普通词缀</button>
          <button type="button" onClick={() => addAffix('sealed')} disabled={request.item.affixes.some((row) => row.slot === 'sealed')}>＋ 封印槽</button>
          <button type="button" onClick={() => addAffix('primordial')} disabled={request.item.affixes.some((row) => row.slot === 'primordial')}>＋ 先古T8槽</button></div>
        <p className="chart-note">空栏直接留空。顺序会影响救赎结果；按装备实际顺序填写，勿仅按阶数排序。</p>
      </section>
      <section className="panel"><div className="section-title"><span>02</span><h2>最终目标</h2></div>
        <div className="target-list">{request.target.requirements.map((target, index) => <div className="target-row" key={index}>
          <div className="row between"><span className="small-label">目标 {index + 1}</span><button type="button" className="danger-quiet" aria-label={`删除目标${index + 1}`} onClick={() => edit({ ...request, target: { requirements: request.target.requirements.filter((_, i) => i !== index) } })}>×</button></div>
          <AffixPicker value={target.ids[0]} pool={pool} label={`目标词缀${index + 1}`} onChange={(id) => updateTarget(index, { ids: [id, ...target.ids.slice(1).filter((value) => value !== id)] })} />
          <div className="row target-controls"><label>阶数<select value={target.minTier} onChange={(event) => { const tier = Number(event.target.value); updateTarget(index, { minTier: tier, maxTier: target.maxTier === target.minTier ? tier : undefined }); }}>{Array.from({ length: 8 }, (_, i) => i + 1).map((tier) => <option key={tier} value={tier}>T{tier}</option>)}</select></label>
            <label>匹配<select value={target.maxTier === target.minTier ? 'exact' : 'minimum'} onChange={(event) => updateTarget(index, { maxTier: event.target.value === 'exact' ? target.minTier : undefined })}><option value="exact">恰好此阶</option><option value="minimum">至少此阶</option></select></label>
            <label>位置<select value={target.slot} onChange={(event) => updateTarget(index, { slot: event.target.value as Requirement['slot'] })}>{Object.entries(slotNames).map(([slot, name]) => <option key={slot} value={slot}>{name}</option>)}</select></label></div>
          <div className="row wrap"><label className="inline-check"><input type="checkbox" checked={target.optional ?? false} onChange={(event) => updateTarget(index, { optional: event.target.checked })} />可选目标</label>
            <button type="button" className="text-button" onClick={() => setAlternativeFor(alternativeFor === index ? null : index)}>添加可接受替代项</button></div>
          {target.ids.length > 1 && <div className="chips">{target.ids.slice(1).map((id) => <button key={id} type="button" onClick={() => updateTarget(index, { ids: target.ids.filter((value) => value !== id) })}>{affixName(catalog, id)} ×</button>)}</div>}
          {alternativeFor === index && <select aria-label={`目标${index + 1}的替代词缀`} value="" onChange={(event) => { if (event.target.value) updateTarget(index, { ids: [...target.ids, Number(event.target.value)] }); setAlternativeFor(null); }}><option value="">选择可接受的替代词缀</option>{pool.filter((id) => !target.ids.includes(id)).map((id) => <option key={id} value={id}>{affixLabel(catalog, id)}</option>)}</select>}
        </div>)}</div>
        <button type="button" disabled={request.target.requirements.length >= 7} onClick={() => { const candidate = pool.find((id) => !request.target.requirements.some((row) => row.ids.includes(id))) ?? pool[0]; if (candidate !== undefined) edit({ ...request, target: { requirements: [...request.target.requirements, { ids: [candidate], minTier: 1, slot: 'ordinary' }] } }); }}>＋ 添加目标</button>
        <details><summary>当前目标摘要</summary><ul>{request.target.requirements.map((row, i) => <li key={i}>{row.optional ? '可选：' : ''}{requirementText(row, catalog)}</li>)}</ul></details>
      </section>
      <section className="panel advanced"><details><summary>操作限制、保护与搜索设置</summary>
        <h3>允许的操作</h3><div className="checks">{Object.entries(actionNames).map(([kind, name]) => <label key={kind}><input type="checkbox" checked={!request.constraints.allowedActions || request.constraints.allowedActions.includes(kind as ActionKind)} onChange={(event) => { const current = request.constraints.allowedActions ?? Object.keys(actionNames) as ActionKind[]; edit({ ...request, constraints: { ...request.constraints, allowedActions: event.target.checked ? [...current, kind as ActionKind] : current.filter((value) => value !== kind) } }); }} />{name}</label>)}</div>
        <h3>保护已有词缀</h3>{request.item.affixes.map((affix) => <div className="protection-row" key={affix.id}><span>{affixName(catalog, affix.id)}</span>{(['identity', 'tier', 'roll'] as const).map((kind) => {
          const protection = request.constraints.protected?.find((row) => row.id === affix.id);
          return <label key={kind}><input type="checkbox" checked={kind === 'tier' ? protection?.minTier !== undefined : Boolean(protection?.[kind])} onChange={(event) => {
            const other = request.constraints.protected?.filter((row) => row.id !== affix.id) ?? [];
            const next = { ...protection, id: affix.id, ...(kind === 'tier' ? { minTier: event.target.checked ? affix.tier : undefined } : { [kind]: event.target.checked }) };
            edit({ ...request, constraints: { ...request.constraints, protected: [...other, next] } });
          }} />{kind === 'identity' ? '保留身份' : kind === 'tier' ? `阶数≥${protection?.minTier ?? affix.tier}` : '保持数值'}</label>;
        })}</div>)}
        <h3>原始roll与可选roll目标</h3><p className="chart-note">仅在需要数值目标或保护时填写0–255原始roll字节；不是面板显示的属性数值。未知旧值不会被假定为均匀分布。</p>
        <div className="field-grid">{request.item.affixes.map((affix, index) => <label key={index}>{affixName(catalog, affix.id)}<input type="number" min="0" max="255" placeholder="未知／不限制" value={affix.roll ?? ''} onChange={(event) => updateAffix(index, { roll: event.target.value === '' ? null : Number(event.target.value) })} /></label>)}</div>
        <div className="field-grid">{request.target.requirements.map((target, index) => <label key={index}>目标{index + 1}的roll下界<input type="number" min="0" max="255" placeholder="不限制" value={target.minRollByte ?? ''} onChange={(event) => updateTarget(index, { minRollByte: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>)}</div>
        <h3>计算预算</h3><div className="field-grid"><label>总时间上限（秒）<input type="number" min="1" max="600" value={request.search.milliseconds / 1000} onChange={(event) => edit({ ...request, search: { ...request.search, milliseconds: Number(event.target.value) * 1000 } })} /></label>
          <label>候选评价数量上限<input type="number" min="1" max="10000" value={request.search.maxRoutes} onChange={(event) => edit({ ...request, search: { ...request.search, maxRoutes: Number(event.target.value) } })} /></label>
          <label>宏阶段上限<input type="number" min="1" max="32" value={request.search.macroStages} onChange={(event) => edit({ ...request, search: { ...request.search, macroStages: Number(event.target.value) } })} /></label>
          <label>状态上限<input type="number" min="1" max="200000" value={request.search.maxStates} onChange={(event) => edit({ ...request, search: { ...request.search, maxStates: Number(event.target.value) } })} /></label></div>
        <p className="chart-note">计算预算不会改变游戏规则。达到上限时返回当前最佳候选并标明搜索未完成。</p>
        <p className="chart-note">主指标为操作成功率与成功路径平均FP，按15%／100FP门槛筛选；不使用起始FP权重。</p>
        <label className="inline-check"><input type="checkbox" checked={request.item.corrupted} onChange={(event) => edit({ ...request, item: { ...request.item, corrupted: event.target.checked } })} />装备已腐化</label>
      </details></section>
      <section className="planning-controls"><div className="row"><button type="button" className="primary-button" onClick={() => void run()} disabled={busy}>{busy ? '正在比较路线…' : '开始规划'}</button>
        {busy && <button type="button" onClick={() => controller.current?.abort()}>取消</button>}</div>
        <p className="chart-note">材料无限 · 操作成功率≥15% · 成功路径平均FP≤100 · 不输入实际剩余FP</p>
        {busy && <div role="status" className="progress"><span className="spinner" />{progress?.message ?? '正在加载计算模块…'}<small>已评价 {progress?.evaluatedRoutes ?? 0} 条</small></div>}
        {message && <div className="error-message" role="alert">{message}</div>}
        <div className="row wrap input-tools"><Download value={request} name="last-epoch-crafting-input.json">导出输入</Download><button type="button" className="text-button" onClick={() => fileInput.current?.click()}>导入输入JSON</button>
          <input ref={fileInput} type="file" hidden accept="application/json,.json" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
      </section>
    </section>
    <section className="results-column" aria-label="规划结果">{report ? <Results report={report} /> : <div className="empty-result panel"><div className="empty-symbol" aria-hidden="true">◇</div><span className="eyebrow">一件装备 · 一条固定路线</span><h2>把概率留给计算。</h2><p>准备、封印、补词和重复符文会共同计入整条路线。先填入目标，再开始比较。</p><div className="empty-features"><span>操作成功率</span><span>三类潜能</span><span>成功路径FP</span><span>版本化代码证据</span></div></div>}</section>
    </main><footer><span>基于 Last Epoch {catalog.model.gameVersion}／build {catalog.model.steamBuildId} 的本地代码研究。</span><span>独立随机参考模型，不是客户端实测频次。{MODEL_ID}</span></footer></>;
}
