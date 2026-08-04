/**
 * `subagentService` — team-mode shift-recording tests.
 *
 * Exercises `SessionSubagentService.run()` shift recording against
 * `IAgentPerformanceService.recordShift`. The `runAgentTurn` helper is mocked;
 * all other collaborators are lightweight stubs. Run:
 * `npx vitest run test/session/subagent/subagentService.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { Emitter } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { IAgentPerformanceService } from '#/app/agentPerformance/agentPerformance';
import type { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import { SECONDARY_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { SECONDARY_DERIVED_MODEL_ID } from '#/app/kosongConfig/secondaryModelOverlay';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISubagentPoolService } from '#/session/subagentPool/subagentPool';

import { SessionSubagentService } from '#/session/subagent/subagentService';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import type { AgentRunHandle, AgentRunRequest, RunAgentOptions } from '#/session/subagent/subagent';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { SUBAGENT_IDLE_TTL_MS, subagentRestExpiresAt } from '#/session/subagent/idleReaper';
import { stubLog } from '../../_base/log/stubs';
import type { ILogService } from '#/_base/log/log';

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
  agentLifecycle: IAgentLifecycleService & { remove: Mock };
  /** Emitter backing `agentLifecycle.onDidRestore` — tests fire it to simulate a resume. */
  onDidRestore: Emitter<string>;
  catalog: ISessionAgentProfileCatalog;
  pool: ISubagentPoolService;
  config: IConfigService;
  flags: IFlagService;
  performance: IAgentPerformanceService;
  sessionContext: ISessionContext;
  log: ILogService;
  status: IRuntimeStatusService & {
    markWorking: Mock;
    markResting: Mock;
    removeProfile: Mock;
    list: Mock;
  };
  agentHandle: IAgentScopeHandle;
  /** Mutable loop state so tests can flip an instance to `running` mid-flight. */
  loopState: { state: 'idle' | 'running' };
  /** Main agent's prompt-service stub — its `inject` records score reminders. */
  mainPromptService: { inject: Mock };
}

function buildStubs(options: {
  teamMode?: boolean;
  profileName?: string;
  modelAlias?: string;
  poolActive?: number;
  /** The agent id the single handle is registered under (default AGENT_ID). */
  agentId?: string;
  /** `[subagent] idle_ttl_ms`, when set; drives the idle-reaper TTL. */
  idleTtlMs?: number;
  /** `[secondary_model]` config, when present; drives derived-secondary binding. */
  secondaryModel?: { model?: string; defaultEffort?: string };
  /** Whether the `secondary-model` experiment flag is enabled. */
  secondaryModelFlag?: boolean;
  /** Whether the main agent is materialized in the lifecycle (default false). */
  mainMaterialized?: boolean;
} = {}): ServiceStubs {
  const teamMode = options.teamMode ?? false;
  const idleTtlMs = options.idleTtlMs;
  const profileName = 'profileName' in options ? options.profileName : PROFILE_NAME;
  const modelAlias = options.modelAlias ?? MODEL_ALIAS;
  const poolActive = options.poolActive ?? 1;
  const agentId = options.agentId ?? AGENT_ID;
  const secondaryModel = options.secondaryModel;
  const secondaryModelFlag = options.secondaryModelFlag ?? true;
  const mainMaterialized = options.mainMaterialized ?? false;

  const loopState: { state: 'idle' | 'running' } = { state: 'idle' };
  const agentHandle = {
    id: agentId,
    kind: 'agent' as const,
    accessor: {
      get: (serviceId: unknown) => {
        if (serviceId === IAgentProfileService) {
          return {
            data: () => ({ profileName, modelAlias }),
          };
        }
        if (serviceId === IAgentLoopService) {
          return {
            status: () => ({
              state: loopState.state,
              pendingTurnIds: [],
              hasPendingRequests: false,
            }),
          };
        }
        throw new Error(`Unexpected service: ${String(serviceId)}`);
      },
    },
    dispose: () => {},
  } as unknown as IAgentScopeHandle;

  const onDidRestore = new Emitter<string>();
  const mainPromptService = {
    _serviceBrand: undefined,
    inject: vi.fn().mockResolvedValue(undefined),
  } as unknown as IAgentPromptService & { inject: Mock };
  const mainHandle = {
    id: MAIN_AGENT_ID,
    kind: 'agent' as const,
    accessor: {
      get: (serviceId: unknown) => {
        if (serviceId === IAgentPromptService) return mainPromptService;
        if (serviceId === IAgentProfileService) {
          return { data: () => ({ profileName: 'main', modelAlias: undefined }) };
        }
        if (serviceId === IAgentLoopService) {
          return {
            status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
          };
        }
        throw new Error(`Unexpected main service: ${String(serviceId)}`);
      },
    },
    dispose: () => {},
  } as unknown as IAgentScopeHandle;
  const agentLifecycle = {
    _serviceBrand: undefined,
    get: (id: string) => {
      // A handle explicitly registered under the run id wins; the materialized
      // main handle is only served for `main` lookups.
      if (id === agentId) return agentHandle;
      if (id === MAIN_AGENT_ID && mainMaterialized) return mainHandle;
      return undefined;
    },
    remove: vi.fn().mockResolvedValue(undefined),
    onDidRestore: onDidRestore.event,
  } as unknown as IAgentLifecycleService & { remove: Mock };

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
      section === 'subagent'
        ? {
            teamMode,
            ...(idleTtlMs !== undefined ? { idleTtlMs } : {}),
          }
        : section === SECONDARY_MODEL_SECTION
          ? secondaryModel
          : undefined,
  } as unknown as IConfigService;

  const flags = {
    _serviceBrand: undefined,
    enabled: vi.fn().mockReturnValue(secondaryModelFlag),
  } as unknown as IFlagService & { enabled: Mock };

  const performance = {
    _serviceBrand: undefined,
    recordShift: vi.fn().mockResolvedValue(undefined),
    summary: vi.fn().mockResolvedValue({ count: 0 }),
  } as unknown as IAgentPerformanceService & { recordShift: Mock; summary: Mock };

  const sessionContext = {
    _serviceBrand: undefined,
    sessionId: SESSION_ID,
  } as unknown as ISessionContext;

  const status = {
    _serviceBrand: undefined,
    markWorking: vi.fn().mockResolvedValue(undefined),
    markResting: vi.fn().mockResolvedValue(undefined),
    removeProfile: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({}),
  } as unknown as IRuntimeStatusService & {
    markWorking: Mock;
    markResting: Mock;
    removeProfile: Mock;
    list: Mock;
  };

  return {
    agentLifecycle,
    catalog,
    pool,
    config,
    flags,
    performance,
    sessionContext,
    log: stubLog(),
    status,
    agentHandle,
    loopState,
    onDidRestore,
    mainPromptService,
  };
}

/** Every service built so far — disposed after each test to clear reaper timers. */
const builtServices: SessionSubagentService[] = [];

function buildService(stubs: ServiceStubs): SessionSubagentService {
  const service = new SessionSubagentService(
    stubs.agentLifecycle,
    stubs.catalog,
    stubs.pool,
    stubs.config,
    stubs.flags,
    stubs.performance,
    stubs.sessionContext,
    stubs.log,
    stubs.status,
  );
  builtServices.push(service);
  return service;
}

// Dispose every built service after each test so the idle reaper's timers are
// always cleared — a team-mode settle arms a real (or faked) 10-minute timer.
afterEach(() => {
  for (const service of builtServices) service.dispose();
  builtServices.length = 0;
});

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

  it('records the real model id for a derived secondary binding (not __secondary__)', async () => {
    // A secondary recipe with patch fields binds the synthesized derived
    // entry; the shift must record the real model the recipe points at.
    const stubs = buildStubs({
      teamMode: true,
      modelAlias: SECONDARY_DERIVED_MODEL_ID,
      secondaryModel: { model: 'provider/real-model' },
    });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    deferred.resolve({ summary: 'done' });
    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });

    const callsDerived = (stubs.performance.recordShift as Mock).mock.calls;
    const shiftDerived = callsDerived[0]?.[1];
    expect(shiftDerived.model).toBe('provider/real-model');
    // byModel aggregation keys off shift.model, so the new record surfaces
    // under the real model id, never the reserved derived id.
    expect(shiftDerived.model).not.toBe(SECONDARY_DERIVED_MODEL_ID);
  });

  it('records the real model id for a derived secondary binding on rejection', async () => {
    const stubs = buildStubs({
      teamMode: true,
      modelAlias: SECONDARY_DERIVED_MODEL_ID,
      secondaryModel: { model: 'provider/real-model' },
    });
    const service = buildService(stubs);
    const deferred = deferredCompletion();

    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);

    deferred.reject(new Error('boom'));
    await expect(deferred.promise).rejects.toThrow('boom');

    await vi.waitFor(() => {
      expect(stubs.performance.recordShift).toHaveBeenCalledTimes(1);
    });

    const callsDerivedErr = (stubs.performance.recordShift as Mock).mock.calls;
    const shiftDerivedErr = callsDerivedErr[0]?.[1];
    expect(shiftDerivedErr.workSummary).toBe('failed: boom');
    expect(shiftDerivedErr.model).toBe('provider/real-model');
  });

  it('records the plain alias as-is even when a secondary model is configured', async () => {
    // Non-derived bindings (caller inheritance, explicit [models] id, or a
    // pointer-only secondary recipe) must keep their alias untouched.
    const stubs = buildStubs({
      teamMode: true,
      modelAlias: MODEL_ALIAS,
      secondaryModel: { model: 'provider/real-model' },
    });
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

    const callsPlain = (stubs.performance.recordShift as Mock).mock.calls;
    const shiftPlain = callsPlain[0]?.[1];
    expect(shiftPlain.model).toBe(MODEL_ALIAS);
  });

  it('falls back to the bound alias when the secondary config cannot be resolved', async () => {
    // Flag off mid-session: no secondary model resolves, so the recorded id
    // stays the bound derived id rather than becoming undefined.
    const stubs = buildStubs({
      teamMode: true,
      modelAlias: SECONDARY_DERIVED_MODEL_ID,
      secondaryModel: { model: 'provider/real-model' },
      secondaryModelFlag: false,
    });
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

    const callsFallback = (stubs.performance.recordShift as Mock).mock.calls;
    const shiftFallback = callsFallback[0]?.[1];
    expect(shiftFallback.model).toBe(SECONDARY_DERIVED_MODEL_ID);
  });
});

describe('SessionSubagentService — idle reaper & runtime status', () => {
  const defaultRequest: AgentRunRequest = { kind: 'prompt', prompt: 'do something' };
  const defaultOpts: RunAgentOptions = {
    signal: new AbortController().signal,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mockedRun(completion: Promise<{ summary: string }>, agentId: string = AGENT_ID) {
    mockRunAgentTurn.mockResolvedValue({
      agentId,
      turn: {} as never,
      completion,
    });
  }

  it('marks working on run start, resting on settle, and reaps after the TTL', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    expect(stubs.status.markWorking).toHaveBeenCalledWith(PROFILE_NAME, AGENT_ID);

    deferred.resolve({ summary: 'done' });
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.status.markResting).toHaveBeenCalledWith(
      PROFILE_NAME,
      AGENT_ID,
      expect.any(String),
    );

    // Not yet expired.
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS - 1);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();

    // Expiry while idle → the instance is destroyed and its profile entry dropped.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.removeProfile).toHaveBeenCalledWith(PROFILE_NAME);
  });

  it('parks a subagent for the default 2h idle TTL when idle_ttl_ms is unset', async () => {
    expect(SUBAGENT_IDLE_TTL_MS).toBe(2 * 60 * 60 * 1000);
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'done' });
    await vi.advanceTimersByTimeAsync(0); // settle → countdown armed with the default TTL

    // The 2h default horizon: not reaped just before it, reaped exactly at it.
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS - 1);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
  });

  it('honours a configured idle_ttl_ms instead of the default', async () => {
    const stubs = buildStubs({ teamMode: true, idleTtlMs: 3_000 });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → countdown armed with the 3s TTL

    await vi.advanceTimersByTimeAsync(2_999);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.removeProfile).toHaveBeenCalledWith(PROFILE_NAME);
  });

  it('writes the resting horizon from the configured idle TTL, not the default', async () => {
    const stubs = buildStubs({ teamMode: true, idleTtlMs: 3_000 });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → resting entry written

    const [, , restExpiresAt] = (stubs.status.markResting as Mock).mock.calls.at(-1)!;
    const remainingMs = Date.parse(String(restExpiresAt)) - Date.now();
    // The horizon mirrors the configured 3s TTL (a 2h default would be ~7.2e6).
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(3_000);
  });

  it('skips the reap when the instance is running at expiry', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → countdown armed

    // A TeamMessage-style wake puts a turn in flight without a new run().
    stubs.loopState.state = 'running';

    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
  });

  it('cancels the idle countdown when a new run starts', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const d1 = deferredCompletion();
    const d2 = deferredCompletion();
    mockRunAgentTurn
      .mockResolvedValueOnce({ agentId: AGENT_ID, turn: {} as never, completion: d1.promise })
      .mockResolvedValueOnce({ agentId: AGENT_ID, turn: {} as never, completion: d2.promise });

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    d1.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → countdown armed

    // The second run (reuse / resume / new dispatch all land here) cancels it.
    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    expect(stubs.status.markWorking).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
  });

  it('clears all timers on disposal (session close)', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // countdown armed

    service.dispose(); // session close → reaper disposed → timers cleared

    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS * 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
  });

  it('never supervises the main agent', async () => {
    const stubs = buildStubs({ teamMode: true, agentId: MAIN_AGENT_ID });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise, MAIN_AGENT_ID);

    await service.run(MAIN_AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(stubs.status.markWorking).not.toHaveBeenCalled();
    expect(stubs.status.markResting).not.toHaveBeenCalled();
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
  });

  it('arms nothing when team mode is off', async () => {
    const stubs = buildStubs({ teamMode: false });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(stubs.status.markWorking).not.toHaveBeenCalled();
    expect(stubs.status.markResting).not.toHaveBeenCalled();
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
  });

  it('re-arms the idle countdown when a run fails to start', async () => {
    const stubs = buildStubs({ teamMode: true });
    const service = buildService(stubs);
    const d1 = deferredCompletion();
    mockRunAgentTurn
      .mockResolvedValueOnce({ agentId: AGENT_ID, turn: {} as never, completion: d1.promise })
      .mockRejectedValueOnce(new Error('busy'));

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    d1.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → countdown armed

    await expect(service.run(AGENT_ID, defaultRequest, defaultOpts)).rejects.toThrow('busy');

    // The failed start restored idle supervision — the countdown is live again.
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.markResting).toHaveBeenCalledTimes(2);
  });

  it('swallows status-write failures — the run still completes', async () => {
    const stubs = buildStubs({ teamMode: true });
    (stubs.status.markWorking as Mock).mockRejectedValue(new Error('disk full'));
    const service = buildService(stubs);
    mockedRun(Promise.resolve({ summary: 'ok' }));

    const handle = await service.run(AGENT_ID, defaultRequest, defaultOpts);
    await expect(handle.completion).resolves.toEqual({ summary: 'ok' });
  });

  // --- resume reconcile (cross-process TTL restore) --------------------------

  it('reconcile re-arms a resumed resting instance with the remaining TTL', async () => {
    const stubs = buildStubs({ teamMode: true });
    buildService(stubs);
    // The instance was parked 5 minutes ago; 5 minutes of the TTL remain.
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    (stubs.status.list as Mock).mockResolvedValue({
      [PROFILE_NAME]: {
        state: 'resting',
        agentId: AGENT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        restExpiresAt: expiresAt,
      },
    });

    // Simulate the resume path: lifecycle.create() cold-materialized the agent
    // and fired onDidRestore → the reaper reconciles the resting entry.
    stubs.onDidRestore.fire(AGENT_ID);
    await vi.advanceTimersByTimeAsync(0); // reconcile reads status and arms

    // Remaining TTL (5 min), not the full TTL — the countdown must not restart.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.removeProfile).toHaveBeenCalledWith(PROFILE_NAME);
  });

  it('reconcile reaps an already-expired resting instance immediately and clears the entry', async () => {
    const stubs = buildStubs({ teamMode: true });
    buildService(stubs);
    (stubs.status.list as Mock).mockResolvedValue({
      [PROFILE_NAME]: {
        state: 'resting',
        agentId: AGENT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        restExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    });

    stubs.onDidRestore.fire(AGENT_ID);
    await vi.advanceTimersByTimeAsync(0); // reconcile reads status → expired → reap
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.removeProfile).toHaveBeenCalledWith(PROFILE_NAME);
  });

  it('reconcile leaves entries whose agentId does not match untouched', async () => {
    const stubs = buildStubs({ teamMode: true });
    buildService(stubs);
    (stubs.status.list as Mock).mockResolvedValue({
      [PROFILE_NAME]: {
        state: 'resting',
        agentId: 'agent-9',
        updatedAt: '2025-01-01T00:00:00.000Z',
        restExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    });

    stubs.onDidRestore.fire(AGENT_ID);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
  });

  it('reconcile never reads status for the main agent', async () => {
    const stubs = buildStubs({ teamMode: true });
    buildService(stubs);

    stubs.onDidRestore.fire(MAIN_AGENT_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.status.list).not.toHaveBeenCalled();
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
  });
});

describe('SessionSubagentService — TeamScore reminder', () => {
  const request: AgentRunRequest = { kind: 'prompt', prompt: 'do something' };
  const opts: RunAgentOptions = { signal: new AbortController().signal };

  function mockRun(completion: Promise<{ summary: string }>): Promise<{ summary: string }> {
    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion,
    });
    return completion;
  }

  it('injects a TeamScore reminder to the main agent when a dispatch settles unscored (team mode)', async () => {
    const stubs = buildStubs({ teamMode: true, mainMaterialized: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    const completion = mockRun(deferred.promise);
    // Baseline 3, settle 3 → unchanged → no score for this dispatch.
    (stubs.performance.summary as Mock)
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 3 });

    const handle = await service.run(AGENT_ID, request, opts);
    deferred.resolve({ summary: 'ok' });
    await handle.completion;
    await completion.catch(() => {});

    await vi.waitFor(() => {
      expect(stubs.mainPromptService.inject).toHaveBeenCalledTimes(1);
    });

    const message = (stubs.mainPromptService.inject as Mock).mock.calls[0]?.[0] as {
      content: readonly { readonly type: string; readonly text: string }[];
      origin?: { readonly kind: string; readonly name: string };
    };
    expect(message.content.some((part) => part.text.includes(PROFILE_NAME))).toBe(true);
    expect(message.content.some((part) => part.text.includes('TeamScore'))).toBe(true);
    expect(message.origin).toEqual({ kind: 'system_trigger', name: 'team_score_reminder' });
  });

  it('does not inject a reminder when a score was recorded for the dispatch (team mode)', async () => {
    const stubs = buildStubs({ teamMode: true, mainMaterialized: true });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    const completion = mockRun(deferred.promise);
    // Baseline 3, settle 4 → a score landed for this dispatch.
    (stubs.performance.summary as Mock)
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 4 });

    const handle = await service.run(AGENT_ID, request, opts);
    deferred.resolve({ summary: 'ok' });
    await handle.completion;
    await completion.catch(() => {});

    // The settle read ran (summary called twice) but the inject never fired.
    await vi.waitFor(() => {
      expect(stubs.performance.summary).toHaveBeenCalledTimes(2);
    });
    expect(stubs.mainPromptService.inject).not.toHaveBeenCalled();
  });

  it('does not inject a reminder outside team mode or for the main agent', async () => {
    // (a) non-team mode: no baseline is captured, no reminder.
    const nonTeam = buildStubs({ teamMode: false, mainMaterialized: true });
    const serviceA = buildService(nonTeam);
    const dA = deferredCompletion();
    mockRunAgentTurn.mockResolvedValue({ agentId: AGENT_ID, turn: {} as never, completion: dA.promise });
    const hA = await serviceA.run(AGENT_ID, request, opts);
    dA.resolve({ summary: 'ok' });
    await hA.completion;
    await Promise.resolve();
    expect(nonTeam.performance.summary).not.toHaveBeenCalled();
    expect(nonTeam.mainPromptService.inject).not.toHaveBeenCalled();

    // (b) the main agent itself: `supervised` excludes MAIN_AGENT_ID.
    const mainStubs = buildStubs({ teamMode: true, mainMaterialized: true });
    const serviceB = buildService(mainStubs);
    const dB = deferredCompletion();
    mockRunAgentTurn.mockResolvedValue({ agentId: MAIN_AGENT_ID, turn: {} as never, completion: dB.promise });
    const hB = await serviceB.run(MAIN_AGENT_ID, request, opts);
    dB.resolve({ summary: 'ok' });
    await hB.completion;
    await Promise.resolve();
    expect(mainStubs.performance.summary).not.toHaveBeenCalled();
    expect(mainStubs.mainPromptService.inject).not.toHaveBeenCalled();
  });

  it('skips the reminder safely when the main agent is not materialized', async () => {
    const stubs = buildStubs({ teamMode: true }); // mainMaterialized: false
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    const completion = mockRun(deferred.promise);
    // Unscored, but there is no main handle to steer into.
    (stubs.performance.summary as Mock)
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const handle = await service.run(AGENT_ID, request, opts);
    deferred.resolve({ summary: 'ok' });
    await handle.completion;
    await completion.catch(() => {});

    // Baseline + settle reads both ran (the reminder path executed) but the
    // missing main handle short-circuits the inject — and the run itself is
    // unaffected.
    await vi.waitFor(() => {
      expect(stubs.performance.summary).toHaveBeenCalledTimes(2);
    });
    expect(stubs.mainPromptService.inject).not.toHaveBeenCalled();
  });
});
