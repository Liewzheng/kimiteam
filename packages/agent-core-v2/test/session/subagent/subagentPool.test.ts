/**
 * `subagentPool` service — unit tests with stubbed config/log.
 *
 * Covers the unlimited default, config-driven limits, FIFO granting, runtime
 * overrides (raise drains, lower never preempts), env precedence, and abort
 * while queued. Run:
 * `npx vitest run test/session/subagent/subagentPool.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubagentPoolService } from '#/session/subagentPool/subagentPoolService';

const ENV_KEY = 'KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY';

function logStub(): unknown {
  const stub: Record<string, unknown> = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
    setLevel: () => {}, level: 'debug', flush: async () => {},
  };
  stub['child'] = () => stub;
  return stub;
}

function buildPool(maxConcurrency?: number): SubagentPoolService {
  const config = {
    get: () => (maxConcurrency === undefined ? undefined : { maxConcurrency }),
  };
  return new SubagentPoolService(config as never, logStub() as never);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SubagentPoolService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is unlimited by default (no env, no config)', async () => {
    const pool = buildPool();
    const slots = await Promise.all(
      Array.from({ length: 10 }, () => pool.acquire(new AbortController().signal)),
    );
    expect(slots).toHaveLength(10);
    expect(pool.state()).toEqual({ limit: undefined, limitSource: 'none', active: 10, queued: 0 });
  });

  it('caps at the configured limit and grants waiters FIFO on release', async () => {
    const pool = buildPool(2);
    const s1 = await pool.acquire(new AbortController().signal);
    const s2 = await pool.acquire(new AbortController().signal);

    const order: string[] = [];
    const w1 = pool.acquire(new AbortController().signal).then((s) => { order.push('w1'); return s; });
    const w2 = pool.acquire(new AbortController().signal).then((s) => { order.push('w2'); return s; });
    expect(pool.state()).toMatchObject({ limit: 2, limitSource: 'config', active: 2, queued: 2 });

    s1.dispose();
    const g1 = await w1;
    expect(order).toEqual(['w1']);
    expect(pool.state()).toMatchObject({ active: 2, queued: 1 });

    s2.dispose();
    await w2;
    expect(order).toEqual(['w1', 'w2']);
    g1.dispose();
    expect(pool.state()).toMatchObject({ active: 1, queued: 0 });
  });

  it('release is idempotent (double dispose does not over-free)', async () => {
    const pool = buildPool(1);
    const slot = await pool.acquire(new AbortController().signal);
    slot.dispose();
    slot.dispose();
    expect(pool.state().active).toBe(0);
  });

  it('raising the runtime limit drains queued waiters', async () => {
    const pool = buildPool(1);
    const s1 = await pool.acquire(new AbortController().signal);
    const waiting = pool.acquire(new AbortController().signal);
    expect(pool.state().queued).toBe(1);

    pool.setRuntimeLimit(2);
    const s2 = await waiting;
    expect(pool.state()).toMatchObject({ limit: 2, limitSource: 'runtime', active: 2, queued: 0 });
    s1.dispose();
    s2.dispose();
  });

  it('lowering the limit below active never preempts running holders', async () => {
    const pool = buildPool(3);
    const s1 = await pool.acquire(new AbortController().signal);
    const s2 = await pool.acquire(new AbortController().signal);
    pool.setRuntimeLimit(1);
    // Both keep running; a new acquire queues until active drops below 1.
    const waiting = pool.acquire(new AbortController().signal);
    expect(pool.state()).toMatchObject({ limit: 1, active: 2, queued: 1 });
    s1.dispose();
    expect(pool.state().queued).toBe(1); // still 1 active (s2) >= limit 1
    s2.dispose();
    await waiting;
    expect(pool.state().active).toBe(1);
  });

  it('clearing the runtime override falls back to config', async () => {
    const pool = buildPool(5);
    pool.setRuntimeLimit(1);
    expect(pool.state().limitSource).toBe('runtime');
    pool.setRuntimeLimit(undefined);
    expect(pool.state()).toMatchObject({ limit: 5, limitSource: 'config' });
  });

  it('env var wins over runtime override and config', async () => {
    vi.stubEnv(ENV_KEY, '1');
    const pool = buildPool(9);
    pool.setRuntimeLimit(7);
    expect(pool.state()).toMatchObject({ limit: 1, limitSource: 'env' });
  });

  it('invalid env var is ignored with a warning instead of breaking acquire', async () => {
    vi.stubEnv(ENV_KEY, 'not-a-number');
    const pool = buildPool(3);
    const slot = await pool.acquire(new AbortController().signal);
    expect(pool.state()).toMatchObject({ limit: 3, limitSource: 'config' });
    slot.dispose();
  });

  it('rejects invalid runtime limits', () => {
    const pool = buildPool();
    expect(() => pool.setRuntimeLimit(0)).toThrow(/positive integer/);
    expect(() => pool.setRuntimeLimit(1.5)).toThrow(/positive integer/);
  });

  it('aborting a queued acquire rejects and frees the queue spot', async () => {
    const pool = buildPool(1);
    const s1 = await pool.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);
    waiting.catch(() => {});
    expect(pool.state().queued).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(pool.state().queued).toBe(0);

    // The freed queue spot means a later waiter is granted on release.
    const w2 = pool.acquire(new AbortController().signal);
    s1.dispose();
    const s2 = await w2;
    s2.dispose();
  });

  it('acquiring with an already-aborted signal throws synchronously', async () => {
    const pool = buildPool();
    const controller = new AbortController();
    controller.abort();
    await expect(pool.acquire(controller.signal)).rejects.toBeDefined();
  });

  it('skips waiters whose signal aborted before they were granted', async () => {
    const pool = buildPool(1);
    const s1 = await pool.acquire(new AbortController().signal);
    const controller = new AbortController();
    const stale = pool.acquire(controller.signal);
    stale.catch(() => {});
    const live = deferred<void>();
    const w2 = pool.acquire(new AbortController().signal).then((s) => {
      live.resolve();
      return s;
    });
    controller.abort();
    s1.dispose();
    await expect(stale).rejects.toBeDefined();
    await live.promise;
    (await w2).dispose();
  });
});
