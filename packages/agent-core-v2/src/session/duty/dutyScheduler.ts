/**
 * `duty` domain — `IDutySchedulerService` implementation (standby pool + LRU
 * pick).
 *
 * Phase-1 in-memory pool of idle members (parked subagent instances) that the
 * two spawn entries dispatch through. A member enters standby when its run
 * settles (see {@link observeSettle}); the pool only records metadata — the
 * source of truth for "is this instance idle/owned/profile-matched" stays the
 * lifecycle registry + session metadata, re-validated on every pick, so stale
 * pool entries can never win a pick.
 *
 * Picking (team mode only):
 *  1. same-profile serialization: an owned instance that is running — or
 *     claimed by this batch for reuse — is returned as `busy`; the caller
 *     waits for its settle and reuses the SAME instance (one active instance
 *     per profile, dispatches queue behind it);
 *  2. enumerate idle owned candidates via `listIdleOwnedSubagents`;
 *  3. rank by a weighted score — LRU recency dominates (never-picked ranks
 *     highest, then oldest `lastPickedAt`), weighted by the member's per-model
 *     score (performance byModel) and load (recent shift duration + pool
 *     occupancy); ties fall back to the highest `agent-<n>` ordinal;
 *  4. when no in-registry candidate exists, fall back to the existing cold
 *     restart path (`findIdleOwnedSubagent` — best by ordinal, materialized
 *     from persisted metadata + runtime status);
 *  5. the winner is claimed atomically into `claimInto` (anti double-claim).
 * Bound at Session scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IAgentPerformanceService, type PerformanceSummary } from '#/app/agentPerformance/agentPerformance';
import { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLoopService } from '#/agent/loop/loop';
import { abortable } from '#/_base/utils/abort';
import {
  findBusyOwnedSubagent,
  findIdleOwnedSubagent,
  listIdleOwnedSubagents,
  type IdleOwnedSubagentCandidate,
} from '#/session/agentLifecycle/subagentReuse';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISubagentPoolService } from '#/session/subagentPool/subagentPool';
import { resolveTeamMode } from '#/session/subagent/configSection';
import { sleepForRetry } from '#/_base/utils/retry';

import {
  IDutySchedulerService,
  type DutyPickInput,
  type DutyPickResult,
  type StandbyEntry,
} from './duty';

/** Recency dominates the weighted score (LRU-first). */
const RECENCY_WEIGHT = 2;
/** Per-model score is the secondary signal. */
const SCORE_WEIGHT = 1;
/** Load (shift duration + pool occupancy) is a mild tie-break. */
const LOAD_WEIGHT = 0.5;
/** A busy pool slot contributes ~10 min of load (soft heuristic). */
const ACTIVE_SLOT_LOAD_MS = 10 * 60 * 1000;

/** Neutral score/load when no data exists — lets recency + ordinal decide. */
const NEUTRAL = 0.5;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export class DutySchedulerService implements IDutySchedulerService {
  declare readonly _serviceBrand: undefined;

  /** agentId → standby metadata (LRU key = lastPickedAt). */
  private readonly standby = new Map<string, StandbyEntry>();
  /**
   * agentId → settle promise of the CURRENT run (from {@link observeSettle}).
   * A run's settle — success, failure or cancellation — frees the member for
   * the next same-profile dispatch (serialization waiters await this).
   */
  private readonly settles = new Map<string, Promise<void>>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IRuntimeStatusService private readonly runtimeStatus: IRuntimeStatusService,
    @IAgentPerformanceService private readonly performance: IAgentPerformanceService,
    @ISubagentPoolService private readonly pool: ISubagentPoolService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  enterStandby(args: {
    readonly agentId: string;
    readonly profileName: string;
    readonly parentAgentId: string;
  }): void {
    if (!resolveTeamMode(this.config)) return;
    const { agentId, profileName, parentAgentId } = args;
    const existing = this.standby.get(agentId);
    // Keep the existing LRU timestamp on re-entry (a member can settle several
    // times); only record the entry when it is not already tracked.
    if (existing !== undefined) return;
    this.standby.set(agentId, { agentId, profileName, parentAgentId });
  }

  observeSettle(
    agentId: string,
    profileName: string,
    parentAgentId: string,
    completion: Promise<unknown>,
  ): void {
    if (!resolveTeamMode(this.config)) return;
    // Settle covers success, failure and cancellation alike — after any of
    // them the instance is idle again and becomes a dispatch candidate. The
    // settle promise also releases same-profile serialization waiters.
    const settle = completion.then(
      () => undefined,
      () => undefined,
    );
    this.settles.set(agentId, settle);
    void settle.then(
      () => this.enterStandby({ agentId, profileName, parentAgentId }),
      () => this.enterStandby({ agentId, profileName, parentAgentId }),
    );
  }

  async pick(input: DutyPickInput): Promise<DutyPickResult> {
    if (!resolveTeamMode(this.config)) return { kind: 'none' };
    const { callerAgentId, profileName, claimInto } = input;

    // 0) Same-profile serialization: if an owned instance of this profile is
    // already running — or claimed by this batch for reuse (about to run) —
    // the profile is busy. Return it so the caller waits for its settle and
    // then reuses the SAME instance instead of creating a parallel one. This
    // check runs FIRST: an idle candidate of the same profile must not start
    // while another instance is running (one active instance per profile).
    const busyId = await findBusyOwnedSubagent({
      lifecycle: this.lifecycle,
      metadata: this.metadata,
      runtimeStatus: this.runtimeStatus,
      sessionId: this.sessionContext.sessionId,
      callerAgentId,
      profileName,
      claimInto,
    });
    if (busyId !== undefined) return { kind: 'busy', agentId: busyId };

    // 1) In-registry idle owned candidates, ranked by LRU + score/load.
    const candidates = await listIdleOwnedSubagents({
      lifecycle: this.lifecycle,
      metadata: this.metadata,
      runtimeStatus: this.runtimeStatus,
      sessionId: this.sessionContext.sessionId,
      callerAgentId,
      profileName,
      claimInto,
    });
    if (candidates.length > 0) {
      const winner = await this.rankBest(candidates, profileName, claimInto);
      if (winner !== undefined) {
        claimInto?.add(winner.agentId);
        this.touch(winner.agentId, callerAgentId, profileName);
        return { kind: 'reuse', agentId: winner.agentId };
      }
    }

    // 2) Cold restart fallback — best by ordinal (existing behavior).
    const coldId = await findIdleOwnedSubagent({
      lifecycle: this.lifecycle,
      metadata: this.metadata,
      runtimeStatus: this.runtimeStatus,
      sessionId: this.sessionContext.sessionId,
      callerAgentId,
      profileName,
      claimInto,
    });
    if (coldId !== undefined) this.touch(coldId, callerAgentId, profileName);
    return coldId === undefined ? { kind: 'none' } : { kind: 'reuse', agentId: coldId };
  }

  async waitForSettle(
    agentId: string,
    signal: AbortSignal,
    claimInto?: ReadonlySet<string>,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      // A batch sibling holds the reuse claim but has not started the run yet
      // (it is between pick and `subagents.run`). Back off and re-check — the
      // claim is released at run start, and only one item may run the member.
      if (claimInto?.has(agentId) === true) {
        await sleepForRetry(25, signal);
        continue;
      }
      const handle = this.lifecycle.get(agentId);
      if (handle === undefined) return; // member gone — nothing to wait for
      if (handle.accessor.get(IAgentLoopService).status().state !== 'running') return;
      const settle = this.settles.get(agentId);
      if (settle === undefined) {
        // Run just started — the settle registration (`observeSettle`) lands in
        // the same tick as the run start; back off briefly and re-check.
        await sleepForRetry(10, signal);
        continue;
      }
      // Wait for the current run to settle (abortably), then loop back: the
      // member may have been re-run by another waiter, in which case we wait
      // for the new run.
      await abortable(settle, signal);
    }
  }

  private async rankBest(
    candidates: readonly IdleOwnedSubagentCandidate[],
    profileName: string,
    claimInto: Set<string> | undefined,
  ): Promise<IdleOwnedSubagentCandidate | undefined> {
    const now = Date.now();
    const perf = await this.performanceSummary(profileName);
    const poolActive = this.pool.state().active;
    let best: IdleOwnedSubagentCandidate | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestOrdinal = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      if (claimInto?.has(candidate.agentId) === true) continue;
      const score = this.score(candidate, perf, poolActive, now);
      if (score > bestScore || (score === bestScore && candidate.ordinal > bestOrdinal)) {
        best = candidate;
        bestScore = score;
        bestOrdinal = candidate.ordinal;
      }
    }
    return best;
  }

  /**
   * Weighted eligibility of one candidate. Recency dominates (never-picked =
   * 1, then older lastPickedAt → higher); per-model score and load are
   * secondary. When no score/load data exists both sit at a neutral 0.5, so
   * the pick degrades to LRU-then-highest-ordinal — the existing behavior.
   */
  private score(
    candidate: IdleOwnedSubagentCandidate,
    perf: PerformanceSummary | undefined,
    poolActive: number,
    now: number,
  ): number {
    const entry = this.standby.get(candidate.agentId);
    const lastPickedAt = entry?.lastPickedAt;
    // LRU-first: never-picked ranks highest (1), then the longer since a member
    // was last picked, the higher its recency (0 right after a pick → ~1 as it
    // ages). The schedule is monotonic so a just-picked member always loses to
    // a never-picked one, and older picks beat newer ones.
    const recency =
      lastPickedAt === undefined
        ? 1
        : Math.max(0, now - lastPickedAt) / (3_600_000 + Math.max(0, now - lastPickedAt));

    let score = NEUTRAL;
    if (perf !== undefined) {
      const byModel = candidate.model === undefined ? undefined : perf.byModel?.[candidate.model];
      const average = byModel?.average ?? perf.average;
      if (average !== undefined) score = clamp01(average / 100);
    }

    const loadMs = (perf?.avgDurationMs ?? 0) + poolActive * ACTIVE_SLOT_LOAD_MS;
    const loadScore = 1 / (1 + loadMs / 3_600_000);

    return RECENCY_WEIGHT * recency + SCORE_WEIGHT * score + LOAD_WEIGHT * loadScore;
  }

  private async performanceSummary(profileName: string): Promise<PerformanceSummary | undefined> {
    try {
      return await this.performance.summary(profileName);
    } catch {
      return undefined; // scoring must never block a dispatch
    }
  }

  private touch(agentId: string, parentAgentId: string, profileName: string): void {
    this.standby.set(agentId, {
      agentId,
      profileName,
      parentAgentId,
      lastPickedAt: Date.now(),
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  IDutySchedulerService,
  DutySchedulerService,
  ScopeActivation.OnScopeCreated,
  'dutyScheduler',
);
