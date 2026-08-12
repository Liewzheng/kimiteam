/**
 * `duty` domain — DutySchedulerService unit tests.
 *
 * Covers the standby-pool pick: team-mode gating, LRU rotation (least
 * recently picked wins), per-model score weighting, no-data fallback to the
 * highest `agent-<n>` ordinal, claimInto anti double-claim, ownership/profile
 * filtering, and the enterStandby "keep lastPickedAt" guard. Constructs the
 * service directly with stub deps — no DI harness. Fake timers pin `Date.now`
 * so LRU recency ordering is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { IConfigService } from '#/app/config/config';
import type { IAgentPerformanceService } from '#/app/agentPerformance/agentPerformance';
import type { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISubagentPoolService } from '#/session/subagentPool/subagentPool';
import { DutySchedulerService } from '#/session/duty/dutyScheduler';

const T0 = new Date('2024-01-01T00:00:00.000Z');

function makeHandle(
  agentId: string,
  profileName: string,
  options: {
    readonly model?: string;
    readonly parentAgentId?: string;
    readonly running?: boolean;
    /** Mutable running state — the test flips it to simulate a run settling. */
    readonly runningRef?: { value: boolean };
  } = {},
): IAgentScopeHandle {
  const parentAgentId = options.parentAgentId ?? 'main';
  const handle = {
    id: agentId,
    parentAgentId,
    accessor: {
      get: (id: unknown) => {
        if (id === IAgentLoopService) {
          const state =
            options.runningRef !== undefined
              ? options.runningRef.value
              : options.running === true;
          return { status: () => ({ state: state ? 'running' : 'idle' }) };
        }
        if (id === IAgentProfileService) {
          return { data: () => ({ profileName, modelAlias: options.model }) };
        }
        throw new Error(`unexpected service id: ${String(id)}`);
      },
    },
  };
  return handle as unknown as IAgentScopeHandle & { readonly parentAgentId: string };
}

function makeScheduler(overrides: {
  readonly teamMode?: boolean;
  readonly candidates?: IAgentScopeHandle[];
  readonly perf?: Record<string, { count: number; average?: number; byModel?: Record<string, { count: number; average?: number }> }>;
  readonly poolActive?: number;
} = {}) {
  const teamMode = overrides.teamMode ?? true;
  const candidates = overrides.candidates ?? [];
  const lifecycle = {
    list: () => candidates,
    get: (id: string) => candidates.find((c) => c.id === id),
    create: async () => {
      throw new Error('cold create not expected in these tests');
    },
  } as unknown as IAgentLifecycleService;
  const metadata = {
    read: async () => ({
      agents: Object.fromEntries(
        candidates.map((c) => [
          c.id,
          { labels: { parentAgentId: (c as { parentAgentId?: string }).parentAgentId ?? 'main', profileName: 'coder' } },
        ]),
      ),
    }),
  } as unknown as ISessionMetadata;
  const runtimeStatus = { list: async () => ({}), listForSession: async () => ({}) } as unknown as IRuntimeStatusService;
  const performance = {
    summary: vi.fn(async (name: string) => overrides.perf?.[name] ?? { count: 0 }),
  } as unknown as IAgentPerformanceService;
  const pool = {
    state: () => ({ limit: 4, limitSource: 'config' as const, active: overrides.poolActive ?? 0, queued: 0 }),
  } as unknown as ISubagentPoolService;
  const config = {
    get: () => (teamMode ? { teamMode: true } : { teamMode: false }),
  } as unknown as IConfigService;
  const sessionContext = {
    _serviceBrand: undefined,
    sessionId: 'session-d',
  } as unknown as ISessionContext;
  const scheduler = new DutySchedulerService(lifecycle, metadata, sessionContext, runtimeStatus, performance, pool, config);
  return { scheduler, performance };
}

function coder(agentId: string, options?: Parameters<typeof makeHandle>[2]): IAgentScopeHandle {
  return makeHandle(agentId, 'coder', options);
}

describe('DutySchedulerService.pick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns none when team mode is off', async () => {
    const { scheduler } = makeScheduler({ teamMode: false, candidates: [coder('agent-1'), coder('agent-2')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({ kind: 'none' });
  });

  it('falls back to the highest agent-<n> ordinal when no data and nothing was picked yet', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2'), coder('agent-5')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-5',
    });
  });

  it('rotates LRU-first: a just-picked member loses to a never-picked one', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2')] });
    // First pick: both never picked → tie → highest ordinal.
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-2',
    });
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    // Second pick: agent-2 was just picked → agent-1 (never picked) wins.
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-1',
    });
  });

  it('prefers the least recently used member among previously picked ones', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2'), coder('agent-3')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-3',
    });
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-2',
    });
    vi.setSystemTime(new Date(T0.getTime() + 120_000));
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-1',
    });
    vi.setSystemTime(new Date(T0.getTime() + 180_000));
    // All picked once; the least recently used is agent-3 (picked at t0).
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-3',
    });
  });

  it('weights by the member model score when recency ties', async () => {
    const { scheduler } = makeScheduler({
      candidates: [
        coder('agent-1', { model: 'model-a' }),
        coder('agent-2', { model: 'model-b' }),
      ],
      perf: {
        coder: {
          count: 5,
          average: 70,
          byModel: {
            'model-a': { count: 3, average: 90 },
            'model-b': { count: 2, average: 50 },
          },
        },
      },
    });
    // Both never picked (recency tie): higher byModel score wins over ordinal.
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-1',
    });
  });

  it('claims the winner atomically into claimInto (anti double-claim)', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2')] });
    const claimInto = new Set<string>();
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder', claimInto })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-2',
    });
    expect(claimInto.has('agent-2')).toBe(true);
  });

  it('never returns a member owned by another parent', async () => {
    const { scheduler } = makeScheduler({
      candidates: [
        coder('agent-1', { parentAgentId: 'main' }),
        coder('agent-2', { parentAgentId: 'other' }),
      ],
    });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-1',
    });
  });

  it('never returns a member whose profile differs', async () => {
    const { scheduler } = makeScheduler({
      candidates: [makeHandle('agent-1', 'coder'), makeHandle('agent-2', 'explore')],
    });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-1',
    });
  });

  it('returns busy for a running same-profile instance instead of an idle candidate (serialization)', async () => {
    const { scheduler } = makeScheduler({
      candidates: [coder('agent-1', { running: true }), coder('agent-2')],
    });
    // The running member blocks the whole profile: the idle agent-2 must NOT
    // start while agent-1 is active (one active instance per profile).
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'busy',
      agentId: 'agent-1',
    });
  });

  it('returns busy for a claimed member (batch sibling about to run it)', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2')] });
    const claimInto = new Set<string>(['agent-1']);
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder', claimInto })).resolves.toEqual({
      kind: 'busy',
      agentId: 'agent-1',
    });
  });

  it('returns busy for a running member even when another profile instance is idle (serialization)', async () => {
    const { scheduler } = makeScheduler({
      candidates: [coder('agent-1', { running: true }), makeHandle('agent-2', 'explore')],
    });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'busy',
      agentId: 'agent-1',
    });
  });

  it('returns none when no member exists at all', async () => {
    const { scheduler } = makeScheduler({ candidates: [] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({ kind: 'none' });
  });

  it('enterStandby does not reset an existing lastPickedAt (LRU preserved)', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-2',
    });
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    // Re-settle agent-2 as standby — must NOT forget it was just picked.
    scheduler.enterStandby({ agentId: 'agent-2', profileName: 'coder', parentAgentId: 'main' });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toEqual({
      kind: 'reuse',
      agentId: 'agent-1',
    });
  });
});

describe('DutySchedulerService.waitForSettle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves immediately for an idle member', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1')] });
    await expect(
      scheduler.waitForSettle('agent-1', new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('resolves immediately for a member that no longer exists', async () => {
    const { scheduler } = makeScheduler({ candidates: [] });
    await expect(
      scheduler.waitForSettle('agent-gone', new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('resolves once the running member settles (success, failure or cancel alike)', async () => {
    const runningRef = { value: true };
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1', { runningRef })] });
    const completion = deferred<{ summary: string }>();
    scheduler.observeSettle('agent-1', 'coder', 'main', completion.promise);

    const waited = scheduler.waitForSettle('agent-1', new AbortController().signal);
    let settled = false;
    void waited.then(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(false)); // still waiting

    // The run settles: the loop state flips to idle and the settle promise
    // resolves — the waiter proceeds either way.
    runningRef.value = false;
    completion.resolve({ summary: 'done' });
    await expect(waited).resolves.toBeUndefined();
  });

  it('rejects on abort while waiting', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1', { running: true })] });
    const completion = new Promise<{ summary: string }>(() => {});
    scheduler.observeSettle('agent-1', 'coder', 'main', completion);
    const controller = new AbortController();
    const waited = scheduler.waitForSettle('agent-1', controller.signal);
    let settled = false;
    void waited.catch(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(false));
    controller.abort();
    await expect(waited).rejects.toBeDefined();
  });

  it('waits while a batch sibling holds the reuse claim, even if not running yet', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1')] });
    const claimInto = new Set<string>(['agent-1']);
    const waited = scheduler.waitForSettle('agent-1', new AbortController().signal, claimInto);
    let settled = false;
    void waited.then(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(false));
    claimInto.delete('agent-1'); // sibling released the claim at run start
    await expect(waited).resolves.toBeUndefined();
  });
});

function deferred<T>(): { readonly promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
