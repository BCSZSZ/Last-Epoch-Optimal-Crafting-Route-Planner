import { describe, expect, it } from 'vitest';
import { BrowserPlanner } from './browser';
import type { WorkerTransport } from './browser';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { exampleRequest } from '../core/examples';
import type { PlanReport } from '../core/planner';

class FakeWorker implements WorkerTransport {
  messages: WorkerRequest[] = [];
  stopped = false;
  receive: (message: WorkerResponse) => void = () => {};
  fail: (error: Error) => void = () => {};
  send(request: WorkerRequest) { this.messages.push(request); }
  listen(message: (response: WorkerResponse) => void, error: (error: Error) => void) { this.receive = message; this.fail = error; }
  terminate() { this.stopped = true; }
}
const report = { status: 'RECOMMENDATION' } as PlanReport;

describe('browser execution adapter', () => {
  it('terminates cancellation and ignores an old task result after replacement', async () => {
    const workers: FakeWorker[] = [];
    const planner = new BrowserPlanner(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    const first = planner.plan(exampleRequest());
    const caught = first.catch((error: Error) => error.name);
    const second = planner.plan(exampleRequest('7713-existing'));
    expect(await caught).toBe('AbortError');
    expect(workers[0].stopped).toBe(true);
    workers[0].receive({ kind: 'result', jobId: workers[0].messages[0].jobId, report });
    let finished = false;
    second.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    workers[1].receive({ kind: 'result', jobId: workers[1].messages[0].jobId, report });
    expect(await second).toBe(report);
    planner.dispose();
  });

  it('reuses a finished worker but kills synchronous work when its signal aborts', async () => {
    const worker = new FakeWorker();
    const planner = new BrowserPlanner(() => worker);
    const first = planner.plan(exampleRequest());
    worker.receive({ kind: 'result', jobId: worker.messages[0].jobId, report });
    await first;
    const signal = new AbortController();
    const second = planner.plan(exampleRequest(), { signal: signal.signal });
    expect(worker.messages).toHaveLength(2);
    const caught = second.catch((error: Error) => error.name);
    signal.abort();
    expect(await caught).toBe('AbortError');
    expect(worker.stopped).toBe(true);
  });

  it('rejects startup failure and already-cancelled input cleanly', async () => {
    const planner = new BrowserPlanner(() => { throw new Error('worker unavailable'); });
    await expect(planner.plan(exampleRequest())).rejects.toThrow('worker unavailable');
    const signal = new AbortController(); signal.abort();
    await expect(planner.plan(exampleRequest(), { signal: signal.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
