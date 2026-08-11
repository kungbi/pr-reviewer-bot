import { GracefulShutdown } from '../src/utils/graceful-shutdown';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('GracefulShutdown', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops accepting new work after draining begins', async () => {
    const shutdown = new GracefulShutdown();
    const first = deferred<string>();
    const startSecond = jest.fn(() => Promise.resolve('second'));

    const active = shutdown.run(() => first.promise);
    shutdown.beginDrain();

    expect(shutdown.run(startSecond)).toBeUndefined();
    expect(startSecond).not.toHaveBeenCalled();

    first.resolve('first');
    await expect(active).resolves.toBe('first');
  });

  it('waits for accepted work to settle before reporting drained', async () => {
    const shutdown = new GracefulShutdown();
    const task = deferred<void>();

    shutdown.run(() => task.promise);
    shutdown.beginDrain();
    const wait = shutdown.waitForIdle(1_000);

    expect(shutdown.activeCount).toBe(1);
    task.resolve();

    await expect(wait).resolves.toEqual({ drained: true, activeCount: 0 });
  });

  it('reports remaining work when the grace timeout expires', async () => {
    jest.useFakeTimers();
    const shutdown = new GracefulShutdown();
    const task = deferred<void>();

    shutdown.run(() => task.promise);
    shutdown.beginDrain();
    const wait = shutdown.waitForIdle(1_000);

    await jest.advanceTimersByTimeAsync(1_000);

    await expect(wait).resolves.toEqual({ drained: false, activeCount: 1 });
    task.resolve();
    await task.promise;
  });
});
