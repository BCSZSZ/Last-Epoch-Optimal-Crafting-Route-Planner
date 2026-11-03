import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MODEL_ID } from '../core/catalog';
import type { PlanProgress } from '../core/planner';
import { BrowserPlanner } from '../execution/browser';
import { benchmarkMatrix } from './cases';
import { deviceSummary } from './record';
import type { DeviceBenchmarkRecord, DeviceCaseRecord } from './record';
import './styles.css';

const fpNames = { NORMAL: '普通', ICE: '冰', BLOOD: '血' };
const qualification = '固定验收装备、默认12秒/48候选、F1–63等权，结果只在本机生成。矩阵完成表示已执行全部规划请求，不表示每例搜索穷尽或已证明最优。设备类别由测试者声明，物理设备身份及性能验收需另行审阅。此页不测Worker内存；内存证据使用独立的原生观测。';

function DeviceCheck() {
  const [mode, setMode] = useState<DeviceBenchmarkRecord['mode']>('FULL');
  const [label, setLabel] = useState('');
  const [deviceClass, setDeviceClass] = useState<DeviceBenchmarkRecord['declaredDeviceClass']>('UNSPECIFIED');
  const [record, setRecord] = useState<DeviceBenchmarkRecord | null>(null);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const planner = useRef<BrowserPlanner | null>(null);
  const generation = useRef(0);
  const started = useRef(0);
  const visibility = useRef<{ milliseconds: number; state: DocumentVisibilityState }[]>([]);
  const busy = record?.status === 'RUNNING';

  useEffect(() => {
    const changed = () => { if (controller.current) visibility.current.push({ milliseconds: performance.now() - started.current, state: document.visibilityState }); };
    document.addEventListener('visibilitychange', changed);
    return () => { generation.current++; controller.current?.abort(); planner.current?.dispose(); document.removeEventListener('visibilitychange', changed); };
  }, []);

  const run = async () => {
    controller.current?.abort(); planner.current?.dispose();
    const id = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    const executor = new BrowserPlanner(); planner.current = executor;
    const cases = benchmarkMatrix(mode);
    const entries: DeviceCaseRecord[] = [];
    started.current = performance.now();
    visibility.current = [{ milliseconds: 0, state: document.visibilityState }];
    const initial: DeviceBenchmarkRecord = { schemaVersion: 1, modelId: MODEL_ID, mode, status: 'RUNNING',
      startedAt: new Date().toISOString(), finishedAt: null, totalCases: cases.length, deviceLabel: label,
      declaredDeviceClass: deviceClass, environment: { userAgent: navigator.userAgent,
        reportedLogicalCpus: navigator.hardwareConcurrency,
        reportedDeviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
        viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight,
        pageOrigin: location.origin, pagePath: location.pathname }, visibility: [...visibility.current], entries: [], error: null, qualification };
    setRecord(initial); setProgress(null); setMessage('');
    try {
      for (const entry of cases) {
        if (abort.signal.aborted) throw new DOMException('已取消', 'AbortError');
        const begin = performance.now();
        const report = await executor.plan(entry.request, { signal: abort.signal,
          onProgress: (value) => { if (generation.current === id) setProgress(value); } });
        entries.push({ ...entry, adapterWallMilliseconds: performance.now() - begin, report });
        if (generation.current === id) setRecord({ ...initial, entries: [...entries], visibility: [...visibility.current] });
      }
      if (generation.current === id) setRecord({ ...initial, status: 'COMPLETE', finishedAt: new Date().toISOString(), entries: [...entries], visibility: [...visibility.current] });
    } catch (error) {
      if (generation.current === id) setRecord({ ...initial, status: abort.signal.aborted || (error instanceof Error && error.name === 'AbortError') ? 'CANCELLED' : 'ERROR',
        finishedAt: new Date().toISOString(), entries: [...entries], visibility: [...visibility.current],
        error: error instanceof Error ? error.message : '设备验证未完成' });
    } finally { if (generation.current === id) { controller.current = null; planner.current = null; setProgress(null); } executor.dispose(); }
  };

  const download = () => {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'last-epoch-device-validation.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const summary = record ? JSON.stringify(deviceSummary(record), null, 2) : '';
  const current = busy ? benchmarkMatrix(record.mode)[record.entries.length] : null;
  const title = record?.status === 'COMPLETE' ? '矩阵已完成' : record?.status === 'CANCELLED' ? '已取消，保留完成项' : record?.status === 'ERROR' ? '验证发生错误' : busy ? '正在验证' : '准备设备验证';
  return <main>
    <header><div><p className="eyebrow">LAST EPOCH · DEVICE VALIDATION</p><h1>设备性能与结果验证</h1></div><a href="../">返回制作路线规划</a></header>
    <section><h2>同一套规则，一键运行固定案例</h2><p>覆盖双T7重排、7710封印补词、7713准备、剥离补词和稀有救赎。完整模式运行三类潜能共15例；每例规划预算12秒，可随时取消并导出已完成记录。</p>
      <div className="fields"><label>设备型号（可选）<input value={label} maxLength={120} disabled={busy} onChange={(event) => setLabel(event.target.value)} placeholder="例如：旧笔记本或手机型号" /></label>
        <label>测试者声明的设备类别<select value={deviceClass} disabled={busy} onChange={(event) => setDeviceClass(event.target.value as DeviceBenchmarkRecord['declaredDeviceClass'])}><option value="UNSPECIFIED">尚未说明</option><option value="DESKTOP_BASELINE">普通电脑基线</option><option value="LOW_PERFORMANCE">低性能实机</option></select></label>
        <label>运行范围<select value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as DeviceBenchmarkRecord['mode'])}><option value="FULL">完整矩阵：五类 × 三种潜能</option><option value="NORMAL_ONLY">快速检查：五类普通潜能</option></select></label></div>
      <div className="actions"><button disabled={busy} onClick={run}>开始设备验证</button><button disabled={!busy} onClick={() => controller.current?.abort()}>取消验证</button><button disabled={!record} onClick={download}>下载完整记录</button></div>
      <p className="note">请保持此页在前台。后台切换会记入结果，便于识别计时环境变化。首例耗时包含Worker启动，后续复用同一Worker；每例同时保留规划器内部耗时。</p>
    </section>
    <section aria-label="设备验证结果" aria-live="polite"><div className="heading"><h2>{title}</h2><span>{record?.entries.length ?? 0} / {record?.totalCases ?? benchmarkMatrix(mode).length}</span></div>
      {current && <p>当前：{current.label} · {fpNames[current.fpType]}潜能{progress && `，已评价${progress.evaluatedRoutes}条候选`}</p>}
      {record?.error && <p className="warning">{record.error}</p>}
      {record && !record.visibility.every((entry) => entry.state === 'visible') && <p className="warning">记录包含后台时段，耗时需按该环境解释。</p>}
      <div className="table-wrap"><table><caption>已完成案例，搜索完成状态独立于矩阵进度</caption><thead><tr><th>案例</th><th>潜能</th><th>总耗时</th><th>内部耗时</th><th>候选</th><th>加权成功率</th><th>精度</th><th>搜索</th></tr></thead><tbody>
        {record?.entries.map((entry) => <tr key={`${entry.id}-${entry.fpType}`}><th>{entry.label}</th><td>{fpNames[entry.fpType]}</td><td>{(entry.adapterWallMilliseconds / 1000).toFixed(3)}s</td><td>{(entry.report.search.elapsedMilliseconds / 1000).toFixed(3)}s</td><td>{entry.report.search.evaluatedRoutes}</td><td>{entry.report.primary ? `${(entry.report.primary.scoreEstimate * 100).toFixed(2)}%` : '预算内未找到'}</td><td>{entry.report.primary?.evaluationStatus === 'ESTIMATED' ? '采样区间' : entry.report.primary ? '算术区间' : '无推荐'}</td><td>{entry.report.searchStatus === 'COMPLETE' ? '范围内完成' : '未完成'}</td></tr>)}
      </tbody></table></div>
      <p className="note">{qualification}</p>
    </section>
    {record && <section><div className="heading"><h2>可复制的简短摘要</h2><button onClick={async () => { try { await navigator.clipboard.writeText(summary); setMessage('摘要已复制。'); } catch { setMessage('可直接选中下方摘要复制。'); } }}>复制摘要</button></div><p role="status">{message}</p><textarea aria-label="设备验证简短摘要" readOnly value={summary} rows={12} /></section>}
    <footer>模型 {MODEL_ID}。所有案例使用公开假设FP域；无需提供实际剩余FP或逐步制作结果。</footer>
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('缺少设备验证容器');
createRoot(root).render(<DeviceCheck />);
