import { useMemo, useState } from 'react';
import type { DraftScenario } from '../core/draft';
import { fpRanges } from '../core/finite-policy';
import type { FiniteDecision, FiniteProfileResult, FiniteProfilesReport } from '../core/finite-policy';
import { catalogForInputModel } from '../core/input-model';
import { routeSteps } from './route-view';
import { affixName } from './labels';

function percentage(row: FiniteProfileResult): string {
  if (!row.probability) return '未算完';
  const { lower, upper } = row.probability;
  return upper - lower <= 1e-6 ? `${((lower + upper) * 50).toFixed(3)}%` : `${(100 * lower).toFixed(2)}–${(100 * upper).toFixed(2)}%`;
}
function mergeRows(rows: readonly FiniteDecision[]): FiniteDecision[] {
  const grouped = new Map<string, FiniteDecision>();
  for (const row of rows) {
    const key = JSON.stringify([row.tiers, row.targets, row.sealed, row.action, row.choice]), old = grouped.get(key);
    grouped.set(key, old ? { ...old, fp: [...new Set([...old.fp, ...row.fp])].sort((a, b) => a - b) } : row);
  }
  return [...grouped.values()];
}
function ProfileCard({ row, scenario }: { row: FiniteProfileResult; scenario: DraftScenario }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [fp, setFp] = useState(''), [sealed, setSealed] = useState('全部'), [limit, setLimit] = useState(100);
  const filtered = useMemo(() => {
    if (!open) return [];
    const code = query.replace(/\s/g, ''), wantedFp = fp === '' ? null : Number(fp);
    return mergeRows(row.decisions).filter(r => (!code || `${r.tiers}/${r.targets}`.includes(code)) &&
      (wantedFp === null || r.fp.includes(wantedFp)) && (sealed === '全部' || r.sealed === sealed));
  }, [open, row.decisions, query, fp, sealed]);
  const simple = row.decisions.length > 0 && row.decisions.every(r => r.targets.split('1').length - 1 === 1 ? r.action === '救赎＋希望' :
    r.targets.split('1').length - 1 === 2 && r.action === '浩劫＋希望');
  const badge = row.recommendation === 'RECOMMENDED' ? '推荐' : row.recommendation === 'NOT_RECOMMENDED' ? '不推荐' : '待确定';
  const steps = row.fixedRoute ? routeSteps(row.fixedRoute.macros, { ...scenario.request, item: { ...scenario.request.item, fpType: row.fpType } },
    catalogForInputModel(scenario.request.inputModel), scenario.aliases) : [];
  return <article className="finite-profile-card" data-fp-type={row.fpType}>
    <div className="finite-profile-heading"><h3>{row.label}</h3><span className={`badge ${row.recommendation === 'NOT_RECOMMENDED' ? 'amber' : row.recommendation === 'UNRESOLVED' ? 'neutral' : ''}`}>{badge}</span></div>
    <strong className="finite-probability">{percentage(row)}</strong>
    <p className="finite-metric-caption">48FP内完成目标</p>
    {row.status === 'INCOMPLETE' && <p className="helper">尚未全部算完；{row.probability ? '此数值对应已找到的路线。' : '结果保留待定，不记为0%。'}</p>}
    <p className="finite-first-action">起手：{row.firstAction}</p>
    {row.actualMeanFp !== null && <p className="helper">平均实际耗FP {row.actualMeanFp.toFixed(2)}{row.successActualMeanFp !== null && <> · 成功装备 {row.successActualMeanFp.toFixed(2)}</>}</p>}
    <details className="finite-route"><summary>查看这套做法</summary>
      {simple ? <ol><li>救赎＋希望，直到缺失目标成为T7；未命中且有FP就继续。</li><li>目标身份齐全后，浩劫＋希望，直到两条目标同时T7。</li><li>达标即停；未达标且FP耗尽则结束。</li></ol> : steps.length ?
        <ol>{steps.map((step, index) => <li key={index}>{step.title}{step.condition && <p>{step.condition}</p>}</li>)}</ol> :
        row.example.length ? <><p className="helper">一条合法成功结果示例；完整策略也包含失手、暴击及其他FP分支。</p><ol>{row.example.map((step, i) =>
          <li key={i}><code>{step.before}</code>，{step.fromFp}FP：{step.action}<p>→ {step.after}，剩{step.toFp}FP</p></li>)}</ol></> : <p>{row.firstAction}</p>}
    </details>
    {row.decisions.length > 0 && <details className="finite-decisions" onToggle={event => setOpen(event.currentTarget.open)}><summary>完整条件路线（{row.decisions.length}项）</summary>
      {open && <><p className="helper">有序T级／目标标记：前缀1、前缀2、后缀1、后缀2；1为目标身份。封印额外读取。</p>
        <div className="finite-policy-filters"><label>状态<input value={query} placeholder="如7171 / 0101" onChange={e => { setQuery(e.target.value); setLimit(100); }} /></label>
          <label>剩余FP<input type="number" min={1} max={48} value={fp} placeholder="全部" onChange={e => { setFp(e.target.value); setLimit(100); }} /></label>
          <label>封印<select value={sealed} onChange={e => setSealed(e.target.value)}>{['全部', '无', '前缀非目标', '后缀非目标'].map(x => <option key={x}>{x}</option>)}</select></label></div>
        <div className="finite-table-scroll"><table><thead><tr><th>状态</th><th>封印</th><th>剩余FP</th><th>下一步</th></tr></thead><tbody>{filtered.slice(0, limit).map((r, i) =>
          <tr key={i}><td><code>{r.tiers} / {r.targets}</code></td><td>{r.sealed}</td><td>{fpRanges(r.fp)}</td><td>{r.action}</td></tr>)}</tbody></table></div>
        <p className="helper">共{filtered.length}项符合条件。导出报告包含全部分支。</p>{filtered.length > limit && <button type="button" className="text-button" onClick={() => setLimit(limit + 200)}>显示更多</button>}</>}
    </details>}
    <details className="search-scope"><summary>计算范围</summary><p>{row.scope}</p>{row.note && <p>{row.note}</p>}
      <p>低于25%显示不推荐；达到25%显示推荐。没有概率或FP均值过滤。</p></details>
  </article>;
}

export function FiniteResults({ report, scenario, onExport }: { report: FiniteProfilesReport; scenario: DraftScenario; onExport: () => void }) {
  return <section className="result-card finite-results"><div className="result-heading"><h2>{scenario.condition || '三种条件，分别选路'}</h2><span className="badge neutral">初始48FP</span></div>
    <div className="finite-profile-grid">{report.profiles.map(row => <ProfileCard key={row.fpType} row={row} scenario={scenario} />)}</div>
    <p className="helper">{scenario.request.target.requirements.filter(row => !row.optional).map((goal, index) =>
      `目标${String.fromCharCode(65 + index)}：${goal.ids.length === 1 ? scenario.aliases[goal.ids[0]] ?? affixName(catalogForInputModel(scenario.request.inputModel), goal.ids[0]) : '所填候选范围'}`).join('；')}</p>
    <div className="result-tools"><button type="button" className="text-button" onClick={onExport}>导出三种条件的完整报告</button></div>
  </section>;
}
