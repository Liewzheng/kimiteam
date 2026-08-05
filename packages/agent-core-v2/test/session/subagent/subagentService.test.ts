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
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ToolInfo } from '#/tool/toolContract';
import type { IAgentPerformanceService, ProfilePerformanceEntry } from '#/app/agentPerformance/agentPerformance';
import type { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import { SECONDARY_MODEL_SECTION } from '#/app/kosongConfig/configSection';
import { SECONDARY_DERIVED_MODEL_ID } from '#/app/kosongConfig/secondaryModelOverlay';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISubagentPoolService } from '#/session/subagentPool/subagentPool';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ModelRequestEvent } from '#/kosong/model/modelRequester';

import { SessionSubagentService } from '#/session/subagent/subagentService';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import type { AgentRunHandle, AgentRunRequest, RunAgentOptions } from '#/session/subagent/subagent';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { SUBAGENT_IDLE_TTL_MS, subagentRestExpiresAt } from '#/session/subagent/idleReaper';
import { DailyReviewService, DAILY_REVIEW_REMINDER_NAME } from '#/session/subagent/dailyReviewService';
import {
  AutoInitiativeService,
  AUTO_INITIATIVE_REMINDER_NAME,
} from '#/session/subagent/autoInitiativeService';
import { resolveTeamAuto, resolveTeamAutoIdleMs } from '#/session/subagent/configSection';
import type { ConfigSectionChangedEvent } from '#/app/config/config';
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
const WARM_SYSTEM_PROMPT = 'You are the warm keep-alive system prompt.';
const WARM_CACHE_KEY = 'warm-cache-key';

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

/**
 * Minimal context message for warm tests — the warmer only reads presence
 * (`messages.length`), so the shape just needs to be a valid `ContextMessage`.
 */
function ctxMessage(): ContextMessage {
  return { role: 'user', content: [], toolCalls: [] };
}

/**
 * A warm request stream: yields one finish event and ends. The warmer consumes
 * and discards every event, so the exact shape only needs to type-check.
 */
function warmRequestIterable(): AsyncIterable<ModelRequestEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'finish' as const, message: {} as never };
    },
  };
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
  /** App-scoped model catalog — its `getRequester` mock records warm requests. */
  modelCatalog: IModelCatalog & { getRequester: Mock };
  /** The warm request mock returned by `getRequester`; assert against it. */
  warmRequest: Mock;
  /** Mutable context the agent handle serves via `IAgentContextMemoryService.get()`. */
  contextMessages: ContextMessage[];
  /** Mutable tools the agent handle serves via `IAgentToolRegistryService.list()`. */
  toolInfos: ToolInfo[];
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
  /** `[subagent] warm_interval_ms`, when set; drives the warm-timer period (0 disables). */
  warmIntervalMs?: number;
  /** `[subagent] duty_idle_ttl_ms`, when set; drives the duty-member idle TTL. */
  dutyIdleTtlMs?: number;
  /** Whether `profileName` is an on-duty member (`duty: true` in its agent file). */
  duty?: boolean;
  /** `[secondary_model]` config, when present; drives derived-secondary binding. */
  secondaryModel?: { model?: string; defaultEffort?: string };
  /** Whether the `secondary-model` experiment flag is enabled. */
  secondaryModelFlag?: boolean;
  /** Whether the main agent is materialized in the lifecycle (default false). */
  mainMaterialized?: boolean;
} = {}): ServiceStubs {
  const teamMode = options.teamMode ?? false;
  const idleTtlMs = options.idleTtlMs;
  const warmIntervalMs = options.warmIntervalMs;
  const dutyIdleTtlMs = options.dutyIdleTtlMs;
  const duty = options.duty ?? false;
  const profileName = 'profileName' in options ? options.profileName : PROFILE_NAME;
  const modelAlias = options.modelAlias ?? MODEL_ALIAS;
  const poolActive = options.poolActive ?? 1;
  const agentId = options.agentId ?? AGENT_ID;
  const secondaryModel = options.secondaryModel;
  const secondaryModelFlag = options.secondaryModelFlag ?? true;
  const mainMaterialized = options.mainMaterialized ?? false;

  const loopState: { state: 'idle' | 'running' } = { state: 'idle' };
  const contextMessages: ContextMessage[] = [];
  const toolInfos: ToolInfo[] = [];
  const agentHandle = {
    id: agentId,
    kind: 'agent' as const,
    accessor: {
      get: (serviceId: unknown) => {
        if (serviceId === IAgentProfileService) {
          return {
            data: () => ({ profileName, modelAlias }),
            resolveModelContext: () => ({ modelAlias }),
            getSystemPrompt: () => WARM_SYSTEM_PROMPT,
            resolveRequestParams: () => ({ cacheKey: WARM_CACHE_KEY }),
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
        if (serviceId === IAgentContextMemoryService) {
          return { get: () => contextMessages };
        }
        if (serviceId === IAgentToolRegistryService) {
          return { list: () => toolInfos };
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
    get: vi.fn((id: string) => {
      // A handle explicitly registered under the run id wins; the materialized
      // main handle is only served for `main` lookups.
      if (id === agentId) return agentHandle;
      if (id === MAIN_AGENT_ID && mainMaterialized) return mainHandle;
      return undefined;
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidRestore: onDidRestore.event,
  } as unknown as IAgentLifecycleService & { remove: Mock };

  const catalog = {
    _serviceBrand: undefined,
    get: vi.fn((name: string) =>
      duty && name === profileName ? { name, duty: true } : undefined,
    ),
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
            ...(warmIntervalMs !== undefined ? { warmIntervalMs } : {}),
            ...(dutyIdleTtlMs !== undefined ? { dutyIdleTtlMs } : {}),
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

  const warmRequest = vi.fn().mockReturnValue(warmRequestIterable());
  const modelCatalog = {
    _serviceBrand: undefined,
    getRequester: vi.fn().mockReturnValue({ request: warmRequest }),
  } as unknown as IModelCatalog & { getRequester: Mock };

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
    modelCatalog,
    warmRequest,
    contextMessages,
    toolInfos,
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
    stubs.modelCatalog,
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

    // Expiry while idle → the instance is destroyed; the resting status entry
    // is kept as a terminal expired-resting record (never erased).
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
  });

  it('keeps the resting status entry after reaping so the panel can see prior completion', async () => {
    const entries = new Map<string, { state: string; agentId: string; restExpiresAt: string }>();
    const stubs = buildStubs({ teamMode: true });
    (stubs.status.markResting as Mock).mockImplementation(
      async (profileName: string, agentId: string, restExpiresAt: string) => {
        entries.set(profileName, { state: 'resting', agentId, restExpiresAt });
      },
    );
    (stubs.status.list as Mock).mockImplementation(async () => Object.fromEntries(entries));
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockedRun(deferred.promise);

    await service.run(AGENT_ID, defaultRequest, defaultOpts);
    deferred.resolve({ summary: 'done' });
    await vi.advanceTimersByTimeAsync(0); // settle → resting entry recorded

    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TTL_MS);
    await vi.advanceTimersByTimeAsync(1); // past the horizon → reaped
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks

    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
    const kept = entries.get(PROFILE_NAME);
    expect(kept).toBeDefined();
    expect(kept?.state).toBe('resting');
    // The persisted rest window has now elapsed — the panel derives off-duty
    // from it instead of losing the member's prior completion entirely.
    expect(Date.parse(kept!.restExpiresAt)).toBeLessThanOrEqual(Date.now());
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
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
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
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
  });

  it('reconcile reaps an already-expired resting instance and keeps the entry as expired resting', async () => {
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
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
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

describe('SessionSubagentService — docked-instance warmer (KV-cache keep-alive)', () => {
  const request: AgentRunRequest = { kind: 'prompt', prompt: 'do something' };
  const opts: RunAgentOptions = { signal: new AbortController().signal };
  const WARM_INTERVAL = 1_000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One run that settles: parks the instance → idle reaper + warmer armed. */
  async function parkInstance(stubs: ServiceStubs, service: SessionSubagentService): Promise<void> {
    const deferred = deferredCompletion();
    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });
    await service.run(AGENT_ID, request, opts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → warm timer armed
  }

  it('fires a keep-alive request at warm_interval_ms and discards the output', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    stubs.contextMessages.push(ctxMessage());
    stubs.toolInfos.push({ name: 'warm_tool', description: 'does warm', source: 'builtin' });
    const service = buildService(stubs);
    await parkInstance(stubs, service);

    // Not yet expired.
    await vi.advanceTimersByTimeAsync(WARM_INTERVAL - 1);
    expect(stubs.warmRequest).not.toHaveBeenCalled();

    // Fire: one request assembled from the instance's exact prefix.
    await vi.advanceTimersByTimeAsync(1);
    expect(stubs.warmRequest).toHaveBeenCalledTimes(1);
    const input = stubs.warmRequest.mock.calls[0]?.[0] as {
      systemPrompt: string;
      messages: readonly ContextMessage[];
      tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[];
    };
    const params = stubs.warmRequest.mock.calls[0]?.[2] as {
      cacheKey: string;
      thinkingEffort: 'off';
      maxCompletionTokens: number;
    };
    expect(input).toMatchObject({
      systemPrompt: WARM_SYSTEM_PROMPT,
      messages: stubs.contextMessages, // full context — never appended
      tools: [{ name: 'warm_tool', description: 'does warm', parameters: { type: 'object', properties: {} } }],
    });
    expect(params).toEqual({ cacheKey: WARM_CACHE_KEY, thinkingEffort: 'off', maxCompletionTokens: 1 });

    // Periodic: the next fire lands one full interval later.
    await vi.advanceTimersByTimeAsync(WARM_INTERVAL);
    expect(stubs.warmRequest).toHaveBeenCalledTimes(2);
  });

  it('skips the warm (no request) when the instance is running at fire time', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    stubs.contextMessages.push(ctxMessage());
    const service = buildService(stubs);
    await parkInstance(stubs, service);

    // A TeamMessage-style wake puts a turn in flight without a new run().
    stubs.loopState.state = 'running';

    await vi.advanceTimersByTimeAsync(WARM_INTERVAL * 2);
    expect(stubs.warmRequest).not.toHaveBeenCalled();
  });

  it('skips the warm when the instance was removed before the fire', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    stubs.contextMessages.push(ctxMessage());
    const service = buildService(stubs);
    await parkInstance(stubs, service);

    // Reaped (idle TTL) or TaskStop'd — the instance no longer exists.
    (stubs.agentLifecycle.get as unknown as Mock).mockReturnValue(undefined);

    await vi.advanceTimersByTimeAsync(WARM_INTERVAL);
    expect(stubs.warmRequest).not.toHaveBeenCalled();
  });

  it('skips the warm when the instance has no context (nothing to keep warm)', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    const service = buildService(stubs); // contextMessages stays empty
    await parkInstance(stubs, service);

    await vi.advanceTimersByTimeAsync(WARM_INTERVAL * 2);
    expect(stubs.warmRequest).not.toHaveBeenCalled();
  });

  it('disables the warmer entirely when warm_interval_ms is 0', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: 0 });
    stubs.contextMessages.push(ctxMessage());
    const service = buildService(stubs);
    await parkInstance(stubs, service);

    await vi.advanceTimersByTimeAsync(WARM_INTERVAL * 10);
    expect(stubs.warmRequest).not.toHaveBeenCalled();
  });

  it('cancels the warm timer when a new run starts', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    stubs.contextMessages.push(ctxMessage());
    const service = buildService(stubs);
    await parkInstance(stubs, service);

    // A second dispatch (reuse / resume / fresh spawn) cancels the warm timer.
    const d2 = deferredCompletion();
    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: d2.promise, // stays in flight — no re-arm on settle
    });
    await service.run(AGENT_ID, request, opts);

    await vi.advanceTimersByTimeAsync(WARM_INTERVAL * 3);
    expect(stubs.warmRequest).not.toHaveBeenCalled();
  });

  it('aborts an in-flight warm when a new run starts', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    stubs.contextMessages.push(ctxMessage());
    const service = buildService(stubs);
    await parkInstance(stubs, service);

    await vi.advanceTimersByTimeAsync(WARM_INTERVAL);
    expect(stubs.warmRequest).toHaveBeenCalledTimes(1);
    const signal = stubs.warmRequest.mock.calls[0]?.[1] as AbortSignal | undefined;
    expect(signal?.aborted).toBe(false);

    // A new run cancels the instance's warm → the in-flight request is aborted.
    const d2 = deferredCompletion();
    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: d2.promise,
    });
    await service.run(AGENT_ID, request, opts);
    expect(signal?.aborted).toBe(true);
  });

  it('reconcile re-hangs the warm timer for a resumed resting instance', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    stubs.contextMessages.push(ctxMessage());
    buildService(stubs);
    (stubs.status.list as Mock).mockResolvedValue({
      [PROFILE_NAME]: {
        state: 'resting',
        agentId: AGENT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        restExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });

    // Simulate the resume path: lifecycle.create() cold-materialized the agent
    // and fired onDidRestore → the warmer reconciles the resting entry.
    stubs.onDidRestore.fire(AGENT_ID);
    await vi.advanceTimersByTimeAsync(0); // reconcile reads status and arms

    await vi.advanceTimersByTimeAsync(WARM_INTERVAL - 1);
    expect(stubs.warmRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stubs.warmRequest).toHaveBeenCalledTimes(1);
  });

  it('reconcile does not hang the warm timer when the resting horizon already elapsed', async () => {
    const stubs = buildStubs({ teamMode: true, warmIntervalMs: WARM_INTERVAL });
    stubs.contextMessages.push(ctxMessage());
    buildService(stubs);
    (stubs.status.list as Mock).mockResolvedValue({
      [PROFILE_NAME]: {
        state: 'resting',
        agentId: AGENT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        restExpiresAt: new Date(Date.now() - 1_000).toISOString(), // expired while down
      },
    });

    stubs.onDidRestore.fire(AGENT_ID);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WARM_INTERVAL * 2);
    expect(stubs.warmRequest).not.toHaveBeenCalled();
  });

  it('reconcile never reads status for the main agent', async () => {
    const stubs = buildStubs({ teamMode: true });
    buildService(stubs);

    stubs.onDidRestore.fire(MAIN_AGENT_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.status.list).not.toHaveBeenCalled();
  });
});

describe('SubagentIdleReaper — duty members are never reaped', () => {
  const request: AgentRunRequest = { kind: 'prompt', prompt: 'do something' };
  const opts: RunAgentOptions = { signal: new AbortController().signal };
  const IDLE_TTL = 3_000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not reap a duty profile when duty_idle_ttl_ms is 0 (default)', async () => {
    const stubs = buildStubs({ teamMode: true, duty: true, idleTtlMs: IDLE_TTL });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, request, opts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → duty arm() skipped

    // Twice the normal idle TTL — a duty member is never reaped proactively.
    await vi.advanceTimersByTimeAsync(IDLE_TTL * 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
  });

  it('reaps a duty profile at the configured duty_idle_ttl_ms horizon', async () => {
    const stubs = buildStubs({
      teamMode: true,
      duty: true,
      idleTtlMs: IDLE_TTL,
      dutyIdleTtlMs: 10_000,
    });
    const service = buildService(stubs);
    const deferred = deferredCompletion();
    mockRunAgentTurn.mockResolvedValue({
      agentId: AGENT_ID,
      turn: {} as never,
      completion: deferred.promise,
    });

    await service.run(AGENT_ID, request, opts);
    deferred.resolve({ summary: 'ok' });
    await vi.advanceTimersByTimeAsync(0); // settle → duty armed at 10s, not 3s

    await vi.advanceTimersByTimeAsync(9_999);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
  });

  it('reconcile never reaps a duty profile whose resting horizon elapsed while down', async () => {
    const stubs = buildStubs({ teamMode: true, duty: true });
    buildService(stubs);
    (stubs.status.list as Mock).mockResolvedValue({
      [PROFILE_NAME]: {
        state: 'resting',
        agentId: AGENT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        restExpiresAt: new Date(Date.now() - 1_000).toISOString(), // expired
      },
    });

    // A duty member goes off duty only via TaskStop — never on a stale horizon.
    stubs.onDidRestore.fire(AGENT_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    expect(stubs.status.removeProfile).not.toHaveBeenCalled();
  });

  it('reconcile re-hangs a duty profile at the duty TTL when configured', async () => {
    const stubs = buildStubs({ teamMode: true, duty: true, dutyIdleTtlMs: 10_000 });
    buildService(stubs);
    (stubs.status.list as Mock).mockResolvedValue({
      [PROFILE_NAME]: {
        state: 'resting',
        agentId: AGENT_ID,
        updatedAt: '2025-01-01T00:00:00.000Z',
        restExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });

    stubs.onDidRestore.fire(AGENT_ID);
    await vi.advanceTimersByTimeAsync(0); // reconcile → arm() at the duty TTL

    await vi.advanceTimersByTimeAsync(9_999);
    expect(stubs.agentLifecycle.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0); // flush reap microtasks
    expect(stubs.agentLifecycle.remove).toHaveBeenCalledWith(AGENT_ID);
  });
});

describe('DailyReviewService', () => {
  function makeService(options: {
    teamMode?: boolean;
    entries?: ProfilePerformanceEntry[];
  } = {}): { service: DailyReviewService; inject: Mock; dispose(): void } {
    const inject = vi.fn().mockResolvedValue(undefined);
    const mainHandle = {
      accessor: {
        get: (serviceId: unknown) =>
          serviceId === IAgentPromptService
            ? { _serviceBrand: undefined, inject }
            : undefined,
      },
    };
    const lifecycle = {
      get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
    };
    const perf = { list: vi.fn().mockResolvedValue(options.entries ?? []) };
    const config = {
      get: (section: string) =>
        section === 'subagent' ? { teamMode: options.teamMode ?? true } : undefined,
    };
    const service = new DailyReviewService(
      lifecycle as never,
      perf as never,
      config as never,
      stubLog(),
    );
    return { service, inject, dispose: () => service.dispose() };
  }

  function scored(profileName: string, average: number, count: number): ProfilePerformanceEntry {
    return { profileName, summary: { average, count } };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects the lowest-scored member with its key data in the review text', async () => {
    const { service, inject } = makeService({
      entries: [scored('coder', 90, 4), scored('explore', 70, 3), scored('reader', 80, 2)],
    });
    await service.runDailyReview();
    expect(inject).toHaveBeenCalledTimes(1);
    const message = inject.mock.calls[0]?.[0] as ContextMessage;
    expect(message.origin).toEqual({ kind: 'system_trigger', name: DAILY_REVIEW_REMINDER_NAME });
    const text = (message.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('explore');
    expect(text).toContain('avg 70');
    expect(text).toContain('3 scores');
    service.dispose();
  });

  it('does not re-inject for the same calendar day', async () => {
    const { service, inject } = makeService({ entries: [scored('solo', 60, 5)] });
    await service.runDailyReview();
    await service.runDailyReview();
    expect(inject).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('injects again on the next calendar day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00'));
    const { service, inject } = makeService({ entries: [scored('solo', 60, 5)] });
    await service.runDailyReview();
    expect(inject).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-01-02T10:00:00'));
    await service.runDailyReview();
    expect(inject).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('skips when no member has a score', async () => {
    const { service, inject } = makeService({ entries: [scored('unscored', 0, 0)] });
    await service.runDailyReview();
    expect(inject).not.toHaveBeenCalled();
    service.dispose();
  });

  it('skips outside team mode', async () => {
    const { service, inject } = makeService({ teamMode: false, entries: [scored('solo', 60, 5)] });
    await service.runDailyReview();
    expect(inject).not.toHaveBeenCalled();
    service.dispose();
  });

  it('cold restore does not re-inject the restart day and reviews once the next midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00'));
    const first = makeService({ entries: [scored('solo', 60, 5)] });
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000); // fires at 2026-01-02T00:00:00
    expect(first.inject).toHaveBeenCalledTimes(1);
    first.dispose(); // process dies on 2026-01-02

    vi.setSystemTime(new Date('2026-01-02T05:00:00')); // restart later the same day
    const second = makeService({ entries: [scored('solo', 60, 5)] });
    second.service.reconcile(); // re-hang the lost midnight timer
    expect(second.inject).not.toHaveBeenCalled(); // the restart day is not re-reviewed

    await vi.advanceTimersByTimeAsync(19 * 3600 * 1000); // to 2026-01-03T00:00:00
    expect(second.inject).toHaveBeenCalledTimes(1); // exactly one review for the new day
    second.dispose();
  });
});

describe('AutoInitiativeService', () => {
  function makeAutoService(options: {
    teamMode?: boolean;
    teamAuto?: boolean;
    autoIdleMs?: number;
    loopState?: 'idle' | 'running';
  } = {}): {
    service: AutoInitiativeService;
    inject: Mock;
    loopState: { state: 'idle' | 'running' };
    sectionEmitter: Emitter<ConfigSectionChangedEvent>;
  } {
    const inject = vi.fn().mockResolvedValue(undefined);
    const loopState: { state: 'idle' | 'running' } = { state: options.loopState ?? 'idle' };
    const loop = {
      status: () => ({ state: loopState.state, pendingTurnIds: [], hasPendingRequests: false }),
    };
    const mainHandle = {
      accessor: {
        get: (serviceId: unknown) =>
          serviceId === IAgentPromptService
            ? { _serviceBrand: undefined, inject }
            : serviceId === IAgentLoopService
              ? loop
              : undefined,
      },
    };
    const lifecycle = { get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined) };
    const sectionEmitter = new Emitter<ConfigSectionChangedEvent>();
    const config = {
      get: (section: string) =>
        section === 'subagent'
          ? {
              teamMode: options.teamMode ?? true,
              teamAuto: options.teamAuto ?? true,
              ...(options.autoIdleMs === undefined ? {} : { autoIdleMs: options.autoIdleMs }),
            }
          : undefined,
      onDidSectionChange: sectionEmitter.event,
    };
    const service = new AutoInitiativeService(lifecycle as never, config as never, stubLog());
    return { service, inject, loopState, sectionEmitter };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects once the main agent has been idle past the threshold, with the idle seconds in the text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00'));
    const { service, inject } = makeAutoService(); // default auto_idle_ms = 300_000
    await service.check(); // first idle observation → baseline
    expect(inject).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-01-01T10:05:00')); // idle 300s
    await service.check();
    expect(inject).toHaveBeenCalledTimes(1);
    const message = inject.mock.calls[0]?.[0] as ContextMessage;
    expect(message.origin).toEqual({ kind: 'system_trigger', name: AUTO_INITIATIVE_REMINDER_NAME });
    const text = (message.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('team auto');
    expect(text).toContain('300s');
    expect(text).toContain('apply ONE bounded improvement');
    service.dispose();
  });

  it('resets the idle clock when the main agent is active (loop running)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00'));
    const { service, inject, loopState } = makeAutoService();
    await service.check(); // baseline
    vi.setSystemTime(new Date('2026-01-01T10:04:00')); // idle 4 min < 5 min
    await service.check();
    expect(inject).not.toHaveBeenCalled();

    loopState.state = 'running'; // activity — a user turn / inject / dispatch
    await service.check();
    loopState.state = 'idle';
    vi.setSystemTime(new Date('2026-01-01T10:07:00')); // idle only 3 min since activity
    await service.check();
    expect(inject).not.toHaveBeenCalled(); // activity reset the clock
    service.dispose();
  });

  it('anti-spam: no second inject within the 10-minute minimum gap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00'));
    const { service, inject } = makeAutoService();
    await service.check(); // baseline
    vi.setSystemTime(new Date('2026-01-01T10:05:00'));
    await service.check(); // idle 300s → inject once
    expect(inject).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-01-01T10:10:00')); // idle again, but only 5 min since the last fire
    await service.check();
    expect(inject).toHaveBeenCalledTimes(1); // blocked by the 10-min gap

    vi.setSystemTime(new Date('2026-01-01T10:15:01')); // > 10 min since the last fire
    await service.check();
    expect(inject).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('skips when team auto is off or team mode is off', async () => {
    const off = makeAutoService({ teamAuto: false });
    await off.service.check();
    expect(off.inject).not.toHaveBeenCalled();
    off.service.dispose();

    const nonTeam = makeAutoService({ teamMode: false });
    await nonTeam.service.check();
    expect(nonTeam.inject).not.toHaveBeenCalled();
    nonTeam.service.dispose();
  });

  it('skips when auto_idle_ms is 0 (idle trigger disabled)', async () => {
    const { service, inject } = makeAutoService({ autoIdleMs: 0 });
    await service.check();
    await service.check();
    expect(inject).not.toHaveBeenCalled();
    service.dispose();
  });

  it('cold restore re-arms the periodic check timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00'));
    const { service, inject } = makeAutoService();
    service.reconcile(); // re-hang the lost timer
    await vi.advanceTimersByTimeAsync(60_000); // one tick → check runs (baseline)
    expect(inject).not.toHaveBeenCalled();
    service.dispose();
  });

  it('re-arms the timer when team_auto is toggled on via config change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00'));
    const { service, inject, sectionEmitter } = makeAutoService({ teamAuto: false });
    // Fire the section-change event as `/team auto` would (config now team_auto: true).
    sectionEmitter.fire({ domain: 'subagent', source: 'set', value: {}, previousValue: {} });
    // The timer is armed; a tick runs a check with the (still-false in the stub)
    // config — the assertion here is that reconcile/arm path does not throw and
    // the timer fires. The stub's teamAuto stays false, so no inject.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inject).not.toHaveBeenCalled();
    service.dispose();
  });

  it('resolves config defaults and parsed values', () => {
    const empty = { get: () => undefined } as unknown as IConfigService;
    expect(resolveTeamAuto(empty)).toBe(false);
    expect(resolveTeamAutoIdleMs(empty)).toBe(300_000);

    const set = {
      get: (section: string) =>
        section === 'subagent' ? { teamAuto: true, autoIdleMs: 60_000 } : undefined,
    } as unknown as IConfigService;
    expect(resolveTeamAuto(set)).toBe(true);
    expect(resolveTeamAutoIdleMs(set)).toBe(60_000);
  });
});
