/**
 * `duty` domain — Session-scoped standby pool + LRU dispatch scheduler.
 *
 * Phase-1 (in-memory only): after a team-mode subagent run settles, the member
 * (the parked agent instance) enters the standby pool; the two spawn entries —
 * the `Agent` tool and `AgentSwarm`'s per-item spawns — pick the next member to
 * dispatch through {@link IDutySchedulerService.pick} instead of the raw
 * highest-ordinal scan. Picking ranks standby members by least-recently-picked
 * first, weighted by the member's per-model score (performance byModel) and
 * load (recent shift duration + pool occupancy), falling back to the existing
 * highest `agent-<n>` selection when no scoring data exists. Ownership is
 * preserved: only members owned by the calling parent are ever reused.
 *
 * Same-profile serialization: when an owned member of the profile is already
 * running (or reserved by a batch sibling), `pick` returns it as `busy` — the
 * caller waits on {@link IDutySchedulerService.waitForSettle} and then reuses
 * the SAME instance, so one profile has at most one active instance at a time
 * and dispatches queue behind it (context preserved). Different profiles stay
 * independent and run in parallel.
 *
 * Nothing is persisted in phase 1 — the pool is memory + settle events only.
 * Bound at Session scope; team mode gates every write and pick.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** A member instance parked idle after a run settled (standby). */
export interface StandbyEntry {
  readonly agentId: string;
  readonly profileName: string;
  readonly parentAgentId: string;
  /** Timestamp of the most recent dispatch of this member (LRU key). */
  lastPickedAt?: number;
}

export interface DutyPickInput {
  /** The parent agent requesting a dispatch — ownership scope of the pick. */
  readonly callerAgentId: string;
  /** Profile the member must match (spawn profile). */
  readonly profileName: string;
  /** Instances already claimed within the current batch — skipped (anti double-claim). */
  readonly claimInto?: Set<string>;
}

/**
 * Outcome of a duty dispatch pick. The caller branches on `kind`:
 * - `reuse` — an idle owned member of the profile is claimed and must be
 *   resumed (context preserved) instead of creating a fresh instance;
 * - `busy` — an owned member of the profile is already running (or reserved by
 *   a batch sibling and about to run). Same-profile serialization: the caller
 *   must NOT create a parallel instance; it waits for that member's current
 *   run to settle (see `IDutySchedulerService.waitForSettle`) and then reuses
 *   the SAME instance;
 * - `none` — no member exists — the caller falls through to a fresh spawn.
 */
export type DutyPickResult =
  | { readonly kind: 'reuse'; readonly agentId: string }
  | { readonly kind: 'busy'; readonly agentId: string }
  | { readonly kind: 'none' };

export interface IDutySchedulerService {
  readonly _serviceBrand: undefined;

  /**
   * Record a member as idle/standby (called when its run settles — success,
   * failure or cancellation). No-op when team mode is off.
   */
  enterStandby(args: {
    readonly agentId: string;
    readonly profileName: string;
    readonly parentAgentId: string;
  }): void;

  /**
   * Attach a settle hook to a run's completion promise: the member enters
   * standby once the run settles, whichever way it ended. No-op when team mode
   * is off (the pool stays empty).
   */
  observeSettle(
    agentId: string,
    profileName: string,
    parentAgentId: string,
    completion: Promise<unknown>,
  ): void;

  /**
   * Pick the member to dispatch for `callerAgentId` + `profileName`: LRU-first
   * among idle owned standby candidates, weighted by score/load, with the
   * highest-`agent-<n>` fallback when no data exists. Returns `busy` when an
   * owned member of the profile is already running (or claimed by this batch
   * for reuse) — the caller must wait for it rather than spawn a parallel
   * instance. The `reuse` id is claimed atomically into `claimInto` (if
   * provided); `none` when no member exists (caller falls through to a fresh
   * spawn). No-op when team mode is off.
   */
  pick(input: DutyPickInput): Promise<DutyPickResult>;

  /**
   * Resolve once the member's current run has settled AND the member is no
   * longer reserved for reuse by `claimInto` (a batch sibling about to run it).
   * Used by the `busy` branch of {@link pick}: the caller waits here, then
   * re-picks — the settled member is now an idle reuse candidate, so the same
   * profile's dispatches serialize on ONE instance. Handles success, failure
   * and cancellation alike (any settle frees the member). Resolves immediately
   * when the member is not running and not claimed; throws on `signal` abort.
   * No-op when team mode is off.
   */
  waitForSettle(agentId: string, signal: AbortSignal, claimInto?: ReadonlySet<string>): Promise<void>;
}

export const IDutySchedulerService: ServiceIdentifier<IDutySchedulerService> =
  createDecorator<IDutySchedulerService>('dutyScheduler');
