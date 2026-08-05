/**
 * `subagent` domain — `ISessionSubagentService` implementation.
 *
 * Owns the "drive a turn on another agent" operation (`run`) and the
 * requester-side announcement surface those runs share: the
 * `onWillStartAgentTask` hook slot and the `onDidStopAgentTask` event fired
 * around each mirrored run. The service resolves the target agent from the
 * lifecycle registry and picks its summary policy from the profile catalog;
 * turn driving itself is delegated to a pure helper. Bound at Session scope.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Error2, ErrorCodes } from '#/errors';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentPerformanceService, type PerformanceShift } from '#/app/agentPerformance/agentPerformance';
import { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ContextMessage, SystemTriggerOrigin } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IModelCatalog } from '#/kosong/model/catalog';

import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from './subagent';
import { ISubagentPoolService } from '../subagentPool/subagentPool';
import { resolveRecordedModelId, resolveSubagentIdleTtlMs, resolveTeamMode } from './configSection';
import { runAgentTurn } from './runAgentTurn';
import {
  SubagentIdleReaper,
  subagentRestExpiresAt,
} from './idleReaper';
import { SubagentWarmService } from './subagentWarmService';

export class SessionSubagentService extends Disposable implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  /**
   * Team-mode idle supervisor: arms an idle countdown per subagent after its
   * run settles (default 2 hours, configurable via `[subagent] idle_ttl_ms`)
   * and destroys the instance through the lifecycle when it is still idle at
   * expiry. Owned here because every subagent run — the Agent tool,
   * AgentSwarm, explicit resume, reuse claim — funnels through {@link run},
   * which is both the countdown's cancel point (run start) and its arm point
   * (run settle).
   */
  private readonly idleReaper: SubagentIdleReaper;
  /**
   * Docked-instance KV-cache warmer: arms a periodic zero-impact provider
   * request per resting instance after its run settles (default 30 min,
   * configurable via `[subagent] warm_interval_ms`) so a long-parked
   * instance's provider-side prompt cache does not expire before the next
   * dispatch. Owned here for the same reason as the reaper — every subagent
   * run funnels through {@link run}, which is both the warm's cancel point
   * (run start) and its arm point (run settle). Zero perturbation: the warm
   * request bypasses context/usage/loop/hooks entirely.
   */
  private readonly warmService: SubagentWarmService;

  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISubagentPoolService private readonly pool: ISubagentPoolService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentPerformanceService private readonly performance: IAgentPerformanceService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService log: ILogService,
    @IRuntimeStatusService private readonly runtimeStatus: IRuntimeStatusService,
  ) {
    super();
    this.idleReaper = this._register(
      new SubagentIdleReaper(this.agentLifecycle, this.runtimeStatus, log, this.config, this.catalog),
    );
    this.warmService = this._register(
      new SubagentWarmService(this.agentLifecycle, this.runtimeStatus, log, this.config, this.modelCatalog),
    );
    // Re-hang a resumed resting instance's idle countdown: cold materialization
    // (session resume) creates agents through `IAgentLifecycleService.create`,
    // whose `onDidRestore` fires once the handle is fully bootstrapped. The
    // reaper's in-process timers died with the previous process, so the resting
    // TTL is restored from the persisted runtime status here — or reaped
    // immediately when it already elapsed while we were down. The warmer's
    // periodic timer is re-hung the same way.
    this._register(
      this.agentLifecycle.onDidRestore((agentId) => {
        void this.idleReaper.reconcile(agentId);
        void this.warmService.reconcile(agentId);
      }),
    );
  }

  async run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }

    // Capture profile identity at call time; used for shift recording below.
    const profileData = handle.accessor.get(IAgentProfileService).data();
    const profileName = profileData.profileName;
    const modelAlias = profileData.modelAlias;
    // Resolve the model id to record on the shift: a subagent bound to the
    // synthesized derived secondary entry (`SECONDARY_DERIVED_MODEL_ID`)
    // records the real model the `[secondary_model]` recipe points at, not
    // the reserved derived id; any other alias is recorded as-is.
    const modelForShift = resolveRecordedModelId(this.config, this.flags, modelAlias);

    // Session-wide concurrency pool: wait for a slot before starting the turn,
    // release it when the run settles (or the start itself fails).
    const teamMode = resolveTeamMode(this.config);
    // Team-mode idle supervision: only named subagent profiles — never the
    // main agent — get the idle TTL (default 2h, configurable) and a profile
    // runtime-status entry. When team mode is off, or the profile is unknown,
    // this block is skipped and behavior is identical to a plain run.
    const supervised = teamMode && agentId !== MAIN_AGENT_ID && profileName !== undefined;
    if (supervised) {
      // A new run on this instance cancels any pending idle countdown and warm
      // timer before the pool wait, so a queued run can never be reaped or
      // warmed mid-dispatch; the panel sees the profile as working from
      // dispatch time. Cancelling the warm also aborts any in-flight warm for
      // the instance — its context snapshot is stale the moment the run starts.
      this.idleReaper.cancel(agentId);
      this.warmService.cancel(agentId);
      void this.runtimeStatus.markWorking(profileName!, agentId).catch(() => { /* swallow */ });
    }

    let slot: IDisposable;
    try {
      slot = await this.pool.acquire(opts.signal);
    } catch (error) {
      // Cancelled before a slot opened — the run never started. Restore idle
      // supervision so the parked instance still goes off duty on its TTL.
      if (supervised) this.onRunStartFailed(agentId, profileName!);
      throw error;
    }
    let run: AgentRunHandle;
    try {
      run = await runAgentTurn(handle, request, {
        summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(handle),
        signal: opts.signal,
        onReady: opts.onReady,
      });
    } catch (error) {
      slot.dispose();
      // The run never started — restore idle supervision so the parked
      // instance still goes off duty if nothing else arrives.
      if (supervised) this.onRunStartFailed(agentId, profileName!);
      throw error;
    }
    const release = () => slot.dispose();

    // Capture turn-start timestamp at the earliest point after the turn
    // started, before any completion callbacks are attached. Only used
    // when team mode is on and the profile is known (checked below).
    const recordShift = teamMode && profileName !== undefined;
    const startedAt = recordShift ? new Date() : undefined;
    const sid = recordShift ? this.sessionContext.sessionId : undefined;

    // Baseline TeamScore count for this dispatch, captured after the turn
    // started (so a score from a prior dispatch that settled during the pool
    // wait is already reflected and cannot suppress THIS dispatch's reminder).
    // Compared again at settle: unchanged means no score was recorded for this
    // dispatch, and the main agent is nudged to record one. Undefined when the
    // profile is not supervised (main agent / non-team) or the baseline read
    // failed — in both cases no reminder fires.
    let scoreCountAtStart: number | undefined;
    if (supervised) {
      try {
        scoreCountAtStart = (await this.performance.summary(profileName!)).count;
      } catch {
        scoreCountAtStart = undefined;
      }
    }

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
            model: modelForShift,
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
            model: modelForShift,
            concurrency: this.pool.state().active,
            agentId,
            sessionId: sid,
          } satisfies PerformanceShift).catch(() => { /* swallow */ });
        },
      ).catch(() => { /* swallow — outer .then handler error must not produce unhandled rejection */ });
    }

    // Team-mode idle supervision: once the run settles (success, failure, or
    // cancellation) start the idle countdown and mark the profile resting
    // with its expiry. The next run on this instance cancels it.
    if (supervised) {
      void run.completion.then(
        () => this.onRunSettled(agentId, profileName!, scoreCountAtStart),
        () => this.onRunSettled(agentId, profileName!, scoreCountAtStart),
      ).catch(() => { /* swallow — supervision must never block the run */ });
    }

    run.completion.then(release, release);
    return run;
  }

  /** Restore idle supervision after a run failed to start. */
  private onRunStartFailed(agentId: string, profileName: string): void {
    this.idleReaper.arm(agentId, profileName);
    this.warmService.arm(agentId, profileName);
    void this.runtimeStatus.markResting(
      profileName,
      agentId,
      subagentRestExpiresAt(Date.now(), resolveSubagentIdleTtlMs(this.config)),
    ).catch(
      () => { /* swallow — status write never blocks the run */ },
    );
  }

  /** A run settled: park the instance under the idle TTL and re-arm its warmer. */
  private onRunSettled(
    agentId: string,
    profileName: string,
    scoreCountAtStart: number | undefined,
  ): void {
    this.idleReaper.arm(agentId, profileName);
    this.warmService.arm(agentId, profileName);
    void this.runtimeStatus.markResting(
      profileName,
      agentId,
      subagentRestExpiresAt(Date.now(), resolveSubagentIdleTtlMs(this.config)),
    ).catch(
      () => { /* swallow — status write never blocks the run */ },
    );
    if (scoreCountAtStart !== undefined) {
      void this.remindToScoreIfUnscored(profileName, scoreCountAtStart);
    }
  }

  /**
   * Team-score reminder: when a supervised dispatch settles with no new score
   * recorded for the profile, nudge the main agent to score it. Injected as a
   * non-user `system_trigger` message so it bypasses the UserPromptSubmit
   * filter (same steer path as the cron fire messages). Fire-and-forget — a
   * failed reminder or perf read must never break idle supervision.
   */
  private async remindToScoreIfUnscored(
    profileName: string,
    scoreCountAtStart: number,
  ): Promise<void> {
    let countAtSettle: number;
    try {
      countAtSettle = (await this.performance.summary(profileName)).count;
    } catch {
      return; // perf unavailable — skip rather than false-positive
    }
    if (countAtSettle !== scoreCountAtStart) return; // a score landed — nothing to remind

    const mainHandle = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (mainHandle === undefined) return; // main not materialized — nothing to steer into
    const origin: SystemTriggerOrigin = {
      kind: 'system_trigger',
      name: 'team_score_reminder',
    };
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Member ${profileName} finished a dispatch but no TeamScore was recorded for it — review the delivery and score it with TeamScore (0-100, note, truthful model).`,
        },
      ],
      toolCalls: [],
      origin,
    };
    try {
      const promptService = mainHandle.accessor.get(IAgentPromptService);
      await promptService.inject(message);
    } catch {
      // swallow — a reminder must never break idle supervision
    }
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
