/**
 * `subagent` domain (L6) — `ISessionSubagentService` implementation.
 *
 * Owns the "drive a turn on another agent" operation (`run`) and the
 * requester-side announcement surface those runs share: the
 * `onWillStartAgentTask` hook slot and the `onDidStopAgentTask` event that
 * `mirrorAgentRun` fires and the Session-scope `externalHooks` adapter
 * translates into the `SubagentStart` / `SubagentStop` external hook
 * commands. Turn driving itself lives in the pure `runAgentTurn` helper; this
 * service only resolves the target agent from the lifecycle registry and
 * picks its summary policy from the profile catalog. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentPerformanceService, type PerformanceShift } from '#/app/agentPerformance/agentPerformance';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IConfigService } from '#/app/config/config';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from './subagent';
import { ISubagentPoolService } from '../subagentPool/subagentPool';
import { resolveTeamMode } from './configSection';
import { runAgentTurn } from './runAgentTurn';

export class SessionSubagentService extends Disposable implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );

  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISubagentPoolService private readonly pool: ISubagentPoolService,
    @IConfigService private readonly config: IConfigService,
    @IAgentPerformanceService private readonly performance: IAgentPerformanceService,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
  }

  async run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) throw new Error(`Agent "${agentId}" does not exist`);

    // Capture profile identity at call time; used for shift recording below.
    const profileData = handle.accessor.get(IAgentProfileService).data();
    const profileName = profileData.profileName;
    const modelAlias = profileData.modelAlias;

    // Session-wide concurrency pool: wait for a slot before starting the turn,
    // release it when the run settles (or the start itself fails).
    const teamMode = resolveTeamMode(this.config);
    const slot = await this.pool.acquire(opts.signal);
    let run: AgentRunHandle;
    try {
      run = await runAgentTurn(handle, request, {
        summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(handle),
        signal: opts.signal,
        onReady: opts.onReady,
      });
    } catch (error) {
      slot.dispose();
      throw error;
    }
    const release = () => slot.dispose();

    // Capture turn-start timestamp at the earliest point after the turn
    // started, before any completion callbacks are attached. Only used
    // when team mode is on and the profile is known (checked below).
    const recordShift = teamMode && profileName !== undefined;
    const startedAt = recordShift ? new Date() : undefined;
    const sid = recordShift ? this.sessionContext.sessionId : undefined;

    // Record a PerformanceShift when team mode is on and the profile is known.
    // Attached before `.then(release, release)` so the concurrency snapshot
    // (read inside the callback) still includes this run.
    if (recordShift) {
      // `profileName`, `startedAt`, and `sid` are all non-null here because
      // `recordShift` guarantees it; `!` assertions keep TypeScript happy.
      void run.completion.then(
        (result) => {
          const endedAt = new Date();
          void this.performance.recordShift(profileName!, {
            startedAt: startedAt!.toISOString(),
            endedAt: endedAt.toISOString(),
            durationMs: endedAt.getTime() - startedAt!.getTime(),
            workSummary: result.summary.slice(0, 200),
            model: modelAlias,
            concurrency: this.pool.state().active,
            agentId,
            sessionId: sid,
          } satisfies PerformanceShift).catch(() => { /* swallow — perf write never blocks the run */ });
        },
        (error) => {
          const endedAt = new Date();
          const msg = error instanceof Error ? error.message : String(error);
          void this.performance.recordShift(profileName!, {
            startedAt: startedAt!.toISOString(),
            endedAt: endedAt.toISOString(),
            durationMs: endedAt.getTime() - startedAt!.getTime(),
            workSummary: `failed: ${msg}`.slice(0, 200),
            model: modelAlias,
            concurrency: this.pool.state().active,
            agentId,
            sessionId: sid,
          } satisfies PerformanceShift).catch(() => { /* swallow */ });
        },
      ).catch(() => { /* swallow — outer .then handler error must not produce unhandled rejection */ });
    }

    run.completion.then(release, release);
    return run;
  }

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void {
    this.onDidStopAgentTaskEmitter.fire(context);
  }

  private summaryPolicyFor(handle: IAgentScopeHandle): AgentProfileSummaryPolicy | undefined {
    const profileName = handle.accessor.get(IAgentProfileService).data().profileName;
    if (profileName === undefined) return undefined;
    return this.catalog.get(profileName)?.summaryPolicy;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
