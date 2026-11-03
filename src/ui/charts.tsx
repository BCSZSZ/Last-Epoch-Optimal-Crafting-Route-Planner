import { useState } from 'react';
import type { RouteReport } from '../core/evaluation';

const center = (value: { lower: number; upper: number }) => (value.lower + value.upper) / 2;
export function ProbabilityChart({ report }: { report: RouteReport }) {
  const [selected, setSelected] = useState(Math.min(30, report.curve.length - 1));
  const width = 640; const height = 230; const left = 42; const bottom = 30; const top = 12; const right = 14;
  const maximum = report.curve.length - 1;
  const x = (fp: number) => left + fp / Math.max(1, maximum) * (width - left - right);
  const y = (p: number) => top + (1 - p) * (height - top - bottom);
  const line = report.curve.map((point) => `${x(point.initialFp)},${y(point.successEstimate ?? center(point.successProbability))}`).join(' ');
  const band = [...report.curve.map((point) => `${x(point.initialFp)},${y(point.successProbability.upper)}`),
    ...[...report.curve].reverse().map((point) => `${x(point.initialFp)},${y(point.successProbability.lower)}`)].join(' ');
  const point = report.curve[Math.min(selected, maximum)];
  return <>
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="假设初始潜能预算与整路线成功率曲线">
      {[0, 0.25, 0.5, 0.75, 1].map((p) => <g key={p}><line x1={left} x2={width - right} y1={y(p)} y2={y(p)} className="gridline" /><text x={left - 8} y={y(p) + 4} textAnchor="end">{p * 100}%</text></g>)}
      {[0, Math.round(maximum / 3), Math.round(maximum * 2 / 3), maximum].map((fp) => <text key={fp} x={x(fp)} y={height - 8} textAnchor="middle">{fp}</text>)}
      <polygon points={band} className="probability-band" /><polyline points={line} className="probability-line" />
      <line x1={x(point.initialFp)} x2={x(point.initialFp)} y1={top} y2={height - bottom} className="cursorline" />
      <circle cx={x(point.initialFp)} cy={y(point.successEstimate ?? center(point.successProbability))} r="4" fill="var(--mint)" />
    </svg>
    <label className="curve-control">查看假设预算 F={point.initialFp}<input type="range" min="0" max={maximum} value={Math.min(selected, maximum)} onChange={(event) => setSelected(Number(event.target.value))} /></label>
    <p className="chart-note">此预算仅用于查看曲线，不是实际剩余FP。成功率 <strong>{((point.successEstimate ?? center(point.successProbability)) * 100).toFixed(2)}%</strong>
      {point.successProbability.upper - point.successProbability.lower > 1e-5 && `，区间 ${(point.successProbability.lower * 100).toFixed(1)}%–${(point.successProbability.upper * 100).toFixed(1)}%`}。</p>
  </>;
}

export function ConsumptionChart({ report }: { report: RouteReport }) {
  const maximum = report.curve.length - 1;
  const bins = report.consumption.slice(0, maximum + 1);
  const values = bins.map((row) => ({ success: row.successEstimate ?? center(row.success), failure: row.failureEstimate ?? center(row.failure) }));
  const max = Math.max(0.01, ...values.map((row) => row.success + row.failure));
  const width = 640; const height = 150; const left = 12; const bottom = 24; const top = 8;
  const step = (width - 2 * left) / bins.length;
  return <>
    <svg className="chart histogram" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="按评分权重混合的成功与失败实际FP消耗分布">
      {values.map((row, index) => {
        const success = row.success / max * (height - top - bottom);
        const failure = row.failure / max * (height - top - bottom);
        return <g key={index}><title>实际消耗{index}FP：成功质量{(row.success * 100).toFixed(2)}%，失败质量{(row.failure * 100).toFixed(2)}%</title>
          <rect x={left + step * index} y={height - bottom - success} width={Math.max(1, step - 2)} height={success} fill="var(--mint)" />
          <rect x={left + step * index} y={height - bottom - success - failure} width={Math.max(1, step - 2)} height={failure} fill="var(--rose)" opacity="0.8" /></g>;
      })}
      {[...new Set([0, Math.round(maximum / 3), Math.round(maximum * 2 / 3), maximum])].map((cost) => <text key={cost} x={left + step * cost} y={height - 6} textAnchor={cost === maximum ? 'end' : 'start'}>{cost} FP</text>)}
    </svg>
    <p className="chart-note"><span className="legend success" />成功路径 <span className="legend failure" />失败路径。混合假设预算的实际消耗，非掉落分布。</p>
  </>;
}
