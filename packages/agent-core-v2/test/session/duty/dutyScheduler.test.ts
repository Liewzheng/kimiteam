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
import type { ISubagentPoolService } from '#/session/subagentPool/subagentPool';
import { DutySchedulerService } from '#/session/duty/dutyScheduler';

const T0 = new Date('2024-01-01T00:00:00.000Z');

function makeHandle(
  agentId: string,
  profileName: string,
  options: { readonly model?: string; readonly parentAgentId?: string; readonly running?: boolean } = {},
): IAgentScopeHandle {
  const parentAgentId = options.parentAgentId ?? 'main';
  const handle = {
    id: agentId,
    parentAgentId,
    accessor: {
      get: (id: unknown) => {
        if (id === IAgentLoopService) {
          return { status: () => ({ state: options.running === true ? 'running' : 'idle' }) };
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
  const runtimeStatus = { list: async () => ({}) } as unknown as IRuntimeStatusService;
  const performance = {
    summary: vi.fn(async (name: string) => overrides.perf?.[name] ?? { count: 0 }),
  } as unknown as IAgentPerformanceService;
  const pool = {
    state: () => ({ limit: 4, limitSource: 'config' as const, active: overrides.poolActive ?? 0, queued: 0 }),
  } as unknown as ISubagentPoolService;
  const config = {
    get: () => (teamMode ? { teamMode: true } : { teamMode: false }),
  } as unknown as IConfigService;
  const scheduler = new DutySchedulerService(lifecycle, metadata, runtimeStatus, performance, pool, config);
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

  it('returns undefined when team mode is off', async () => {
    const { scheduler } = makeScheduler({ teamMode: false, candidates: [coder('agent-1'), coder('agent-2')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBeUndefined();
  });

  it('falls back to the highest agent-<n> ordinal when no data and nothing was picked yet', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2'), coder('agent-5')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-5');
  });

  it('rotates LRU-first: a just-picked member loses to a never-picked one', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2')] });
    // First pick: both never picked → tie → highest ordinal.
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-2');
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    // Second pick: agent-2 was just picked → agent-1 (never picked) wins.
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-1');
  });

  it('prefers the least recently used member among previously picked ones', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2'), coder('agent-3')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-3');
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-2');
    vi.setSystemTime(new Date(T0.getTime() + 120_000));
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-1');
    vi.setSystemTime(new Date(T0.getTime() + 180_000));
    // All picked once; the least recently used is agent-3 (picked at t0).
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-3');
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
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-1');
  });

  it('skips claimInto entries and claims the winner atomically', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2')] });
    const claimInto = new Set<string>(['agent-2']);
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder', claimInto })).resolves.toBe('agent-1');
    expect(claimInto.has('agent-1')).toBe(true);
  });

  it('never returns a member owned by another parent', async () => {
    const { scheduler } = makeScheduler({
      candidates: [
        coder('agent-1', { parentAgentId: 'main' }),
        coder('agent-2', { parentAgentId: 'other' }),
      ],
    });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-1');
  });

  it('never returns a member whose profile differs', async () => {
    const { scheduler } = makeScheduler({
      candidates: [makeHandle('agent-1', 'coder'), makeHandle('agent-2', 'explore')],
    });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-1');
  });

  it('never returns a running member', async () => {
    const { scheduler } = makeScheduler({
      candidates: [coder('agent-1', { running: true }), coder('agent-2')],
    });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-2');
  });

  it('enterStandby does not reset an existing lastPickedAt (LRU preserved)', async () => {
    const { scheduler } = makeScheduler({ candidates: [coder('agent-1'), coder('agent-2')] });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-2');
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    // Re-settle agent-2 as standby — must NOT forget it was just picked.
    scheduler.enterStandby({ agentId: 'agent-2', profileName: 'coder', parentAgentId: 'main' });
    await expect(scheduler.pick({ callerAgentId: 'main', profileName: 'coder' })).resolves.toBe('agent-1');
  });
});
