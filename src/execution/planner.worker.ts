import { plan } from '../core/planner';
import type { WorkerRequest, WorkerResponse } from './protocol';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const send = (message: WorkerResponse) => scope.postMessage(message);
let busy = false;

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.kind !== 'plan') return;
  if (busy) {
    send({ kind: 'error', jobId: message.jobId, error: { name: 'WorkerBusy', message: '计算模块正在执行另一个任务' } });
    return;
  }
  busy = true;
  try {
    const report = await plan(message.request, {
      onProgress: (progress) => send({ kind: 'progress', jobId: message.jobId, progress }),
      yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    send({ kind: 'result', jobId: message.jobId, report });
  } catch (error) {
    send({ kind: 'error', jobId: message.jobId, error: { name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : '规划计算失败' } });
  } finally { busy = false; }
};
