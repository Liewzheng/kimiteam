/**
 * `subagentService` — team-mode shift-recording tests.
 *
 * Exercises `SessionSubagentService.run()` shift recording against
 * `IAgentPerformanceService.recordShift`. The `runAgentTurn` helper is mocked;
 * all other collaborators are lightweight stubs. Run:
 * `npx vitest run test/session/subagent/subagentService.test.ts`.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentPerformanceService } from '#/app/agentPerformance/agentPerformance';
import type { IConfigService } from '#/app/config/config';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISubagentPoolService } from '#/session/subagentPool/subagentPool';

import { SessionSubagentService } from '#/session/subagent/subagentService';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import type { AgentRunHandle, AgentRunRequest, RunAgentOptions } from '#/session/subagent/subagent';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('#/session/subagent/runAgentTurn', () => ({
  runAgentTurn: vi.fn(),
}));

/** Typed reference to the mocked `runAgentTurn` for `mockResolvedValue` etc. */
const mockRunAgentTurn = runAgentTurn as unknown as Mock<
  (handle: IAgentScopeHandle, request: AgentRunRequest, opts: Record<string, unknown>) => Promise<AgentRunHandle>
>;

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const PROFILE_NAME = 'test-coder';
const MODEL_ALIAS = 'provider/model-x';
const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-abc-123';

function slotStub(): IDisposable {
  let disposed = false;
  return { dispose: () => { disposed = true; } };
}

function deferredCompletion(): {
  promise: Promise<{ summary: string }>;
  resolve: (v: { summary: string }) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: { summary: string }) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ summary: string }>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface ServiceStubs {
  agentLifecycle: IAgentLifecycleService;
  catalog: ISessionAgentProfileCatalog;
  pool: ISubagentPoolService;
  config: IConfigService;
  performance: IAgentPerformanceService;
  sessionContext: ISessionContext;
  agentHandle: IAgentScopeHandle;
}

function buildStubs(options: {
  teamMode?: boolean;
  profileName?: string;
  modelAlias?: string;
  poolActive?: number;
} = {}): ServiceStubs {
  const teamMode = options.teamMode ?? false;
  const profileName = 'profileName' in options ? options.profileName : PROFILE_NAME;
  const modelAlias = options.modelAlias ?? MODEL_ALIAS;
  const poolActive = options.poolActive ?? 1;

  const agentHandle = {
    id: AGENT_ID,
    kind: 'agent' as const,
    accessor: {
      get: (serviceId: unknown) => {
        if (serviceId === IAgentProfileService) {
          return {
            data: () => ({ profileName, modelAlias }),
          };
        }
        throw new Error(`Unexpected service: ${String(serviceId)}`);
      },
    },
    dispose: () => {},
  } as unknown as IAgentScopeHandle;

  const agentLifecycle = {
    _serviceBrand: undefined,
    get: (id: string) => (id === AGENT_ID ? agentHandle : undefined),
  } as unknown as IAgentLifecycleService;

  const catalog = {
    _serviceBrand: undefined,
    get: () => undefined,
  } as unknown as ISessionAgentProfileCatalog;

  const pool = {
    _serviceBrand: undefined,
    acquire: vi.fn().mockResolvedValue(slotStub()),
    state: vi.fn().mockReturnValue({ active: poolActive, queued: 0, limit: 1, limitSource: 'config' as const }),
    setRuntimeLimit: vi.fn(),
  } as unknown as ISubagentPoolService & { acquire: Mock; state: Mock };

  const config = {
    _serviceBrand: undefined,
    get: (section: string) =>
      section === 'subagent' ? { teamMode } : undefined,
  } as unknown as IConfigService;

  const performance = {
    _serviceBrand: undefined,
    recordShift: vi.fn().mockResolvedValue(undefined),
  } as unknown as IAgentPerformanceService & { recordShift: Mock };

  const sessionContext = {
    _serviceBrand: undefined,
    sessionId: SESSION_ID,
  } as unknown as ISessionContext;

  return { agentLifecycle, catalog, pool, config, performance, sessionContext, agentHandle };
}

function buildService(stubs: ServiceStubs): SessionSubagentService {
  return new SessionSubagentService(
    stubs.agentLifecycle,
    stubs.catalog,
    stubs.pool,
    stubs.config,
    stubs.performance,
    stubs.sessionContext,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionSubagentService — team-mode shift recording', () => {
  const defaultRequest: AgentRunRequest = { kind: 'prompt', prompt: 'do something' };
  const defaultOpts: RunAgentOptions = {
    signal: new AbortController().signal,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a shift on successful completion when team mode is on', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    const handle = await service.run(AGENT_ID, defaultRequest, defaultOpts);

    // Resolve the completion
    deferred.resolve({ summary: 'Task completed successfully' });
    await handle.completion;

    // Allow the microtask for recordShift to settle
    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });

    const calls = (stubs.performance.recordShift as Mock).mock.calls;
    const calledProfile = calls[0]?.[0];
    const shift = calls[0]?.[1];
    expect(calledProfile).toBe(PROFILE_NAME);
    expect(shift).toMatchObject({
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      durationMs: expect.any(Number),
      workSummary: 'Task completed successfully',
      model: MODEL_ALIAS,
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    expect(shift.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof shift.concurrency).toBe('number');
  });

  it('records a shift with "failed:" prefix on rejection when team mode is on', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    // Reject the completion
    deferred.reject(new Error('API rate limit exceeded'));
    await expect(deferred.promise).rejects.toThrow('API rate limit exceeded');

    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });

    const calls2 = (stubs.performance.recordShift as Mock).mock.calls;
    const shift2 = calls2[0]?.[1];
    expect(shift2.workSummary).toBe('failed: API rate limit exceeded');
  });

  it('records shift with truncated workSummary (200 chars) on completion', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    const longSummary = 'x'.repeat(300);
    deferred.resolve({ summary: longSummary });
    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });

    const calls3 = (stubs.performance.recordShift as Mock).mock.calls;
    const shift3 = calls3[0]?.[1];
    expect(shift3.workSummary).toBe('x'.repeat(200));
    expect(shift3.workSummary.length).toBe(200);
  });

  it('records shift with truncated "failed:" prefix (200 chars total) on rejection', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    const longMsg = 'x'.repeat(300);
    deferred.reject(new Error(longMsg));
    await expect(deferred.promise).rejects.toThrow();

    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });

    const calls4 = (stubs.performance.recordShift as Mock).mock.calls;
    const shift4 = calls4[0]?.[1];
    expect(shift4.workSummary).toBe(`failed: ${'x'.repeat(192)}`);
    expect(shift4.workSummary.length).toBe(200);
  });

  it('does NOT record a shift when team mode is off', async () => {
    const stubs = buildStubs({ teamMode: false });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    deferred.resolve({ summary: 'ok' });
    await vi.waitFor(() => {
      // Give microtasks time to settle; recordShift should never be called.
    });

    expect(stubs.performance.recordShift).not.toHaveBeenCalled();
  });

  it('does NOT record a shift when profileName is undefined (even with team mode on)', async () => {
    const stubs = buildStubs({ teamMode: true, profileName: undefined });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    deferred.resolve({ summary: 'ok' });
    await vi.waitFor(() => {
      // Give microtasks time to settle; recordShift should never be called.
    });

    expect(stubs.performance.recordShift).not.toHaveBeenCalled();
  });

  it('recording failure never propagates to the caller (swallows rejection)', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    // Make recordShift reject
    (stubs.performance.recordShift as Mock).mockRejectedValue(new Error('disk full'));

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    const handle = await service.run(AGENT_ID, defaultRequest, defaultOpts);

    deferred.resolve({ summary: 'good' });
    // The run completion itself must resolve cleanly despite the perf failure.
    await expect(handle.completion).resolves.toEqual({ summary: 'good' });

    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });
  });

  it('reads concurrency from pool.state().active before release decrements it', async () => {
    const stubs = buildStubs({ teamMode: true, poolActive: 3 });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    deferred.resolve({ summary: 'ok' });
    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });

    const calls5 = (stubs.performance.recordShift as Mock).mock.calls;
    const shift5 = calls5[0]?.[1];
    // The active count was 3 when state() was read (pool slot not yet released).
    expect(shift5.concurrency).toBe(3);
  });
});
