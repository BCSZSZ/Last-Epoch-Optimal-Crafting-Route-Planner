import { PlanningCancelledError } from '../core/planner';
import type { PlanProgress, PlanReport } from '../core/planner';
import type { PlanRequest } from '../core/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface WorkerTransport {
  send(request: WorkerRequest): void;
  listen(onMessage: (response: WorkerResponse) => void, onError: (error: Error) => void): void;
  terminate(): void;
}

function browserWorker(): WorkerTransport {
  const worker = new Worker(new URL('./planner.worker.ts', import.meta.url), { type: 'module' });
  return {
    send: (message) => worker.postMessage(message), terminate: () => worker.terminate(),
    listen: (onMessage, onError) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => onMessage(event.data);
      worker.onerror = (event) => onError(new Error(event.message || '无法加载计算模块，请刷新后重试'));
      worker.onmessageerror = () => onError(new Error('计算消息无法读取，请刷新后重试'));
    },
  };
}

interface Pending {
  readonly id: string;
  readonly resolve: (report: PlanReport) => void;
  readonly reject: (error: Error) => void;
  readonly progress?: (progress: PlanProgress) => void;
  readonly cleanup: () => void;
}

/** UI execution adapter. Cancellation terminates blocked synchronous work immediately. */
export class BrowserPlanner {
  #transport: WorkerTransport | null = null;
  #pending: Pending | null = null;
  #counter = 0;

  constructor(readonly transportFactory: () => WorkerTransport = browserWorker) {}

  plan(request: PlanRequest, options: { signal?: AbortSignal; onProgress?: (progress: PlanProgress) => void } = {}): Promise<PlanReport> {
    if (options.signal?.aborted) return Promise.reject(new PlanningCancelledError());
    if (this.#pending) this.#cancel();
    return new Promise((resolve, reject) => {
      const id = `plan-${++this.#counter}`;
      const abort = () => { if (this.#pending?.id === id) this.#cancel(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.#pending = { id, resolve, reject, progress: options.onProgress,
        cleanup: () => options.signal?.removeEventListener('abort', abort) };
      try {
        if (!this.#transport) {
          this.#transport = this.transportFactory();
          this.#transport.listen((message) => this.#message(message), (error) => this.#fail(error));
        }
        this.#transport.send({ kind: 'plan', jobId: id, request });
      } catch (error) { this.#fail(error instanceof Error ? error : new Error('无法启动计算模块')); }
    });
  }

  #message(message: WorkerResponse): void {
    const pending = this.#pending;
    if (!pending || message.jobId !== pending.id) return;
    if (message.kind === 'progress') { pending.progress?.(message.progress); return; }
    pending.cleanup();
    this.#pending = null;
    if (message.kind === 'result') pending.resolve(message.report);
    else { const error = new Error(message.error.message); error.name = message.error.name; pending.reject(error); }
  }

  #fail(error: Error): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.cleanup();
    this.#transport?.terminate(); this.#transport = null;
    pending?.reject(error);
  }

  #cancel(): void { this.#fail(new PlanningCancelledError()); }
  dispose(): void { this.#cancel(); }
}
