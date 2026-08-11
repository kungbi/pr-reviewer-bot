export interface GracefulShutdownResult {
  drained: boolean;
  activeCount: number;
}

/**
 * Tracks asynchronous work during process shutdown. Once draining starts, new
 * work is rejected while already accepted work is allowed to finish.
 */
export class GracefulShutdown {
  private draining = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly idleWaiters = new Set<() => void>();

  get isDraining(): boolean {
    return this.draining;
  }

  get activeCount(): number {
    return this.active.size;
  }

  beginDrain(): void {
    this.draining = true;
  }

  run<T>(work: () => Promise<T>): Promise<T> | undefined {
    if (this.draining) return undefined;

    let task: Promise<T>;
    try {
      task = Promise.resolve(work());
    } catch (err) {
      return Promise.reject(err);
    }

    this.active.add(task);
    task.then(
      () => this.finish(task),
      () => this.finish(task),
    );
    return task;
  }

  waitForIdle(timeoutMs: number): Promise<GracefulShutdownResult> {
    if (this.active.size === 0) {
      return Promise.resolve({ drained: true, activeCount: 0 });
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: GracefulShutdownResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.idleWaiters.delete(onIdle);
        resolve(result);
      };
      const onIdle = (): void => {
        if (this.active.size === 0) {
          finish({ drained: true, activeCount: 0 });
        }
      };
      const timeout = setTimeout(() => {
        finish({ drained: false, activeCount: this.active.size });
      }, timeoutMs);

      this.idleWaiters.add(onIdle);
      onIdle();
    });
  }

  private finish(task: Promise<unknown>): void {
    this.active.delete(task);
    if (this.active.size === 0) {
      for (const waiter of this.idleWaiters) waiter();
    }
  }
}
