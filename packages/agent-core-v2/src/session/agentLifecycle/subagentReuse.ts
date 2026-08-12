/**
 * `agentLifecycle` domain (L6) — idle-subagent reuse helper.
 *
 * Shared by the `Agent` and `AgentSwarm` spawn paths. In team mode a spawn
 * that would otherwise create a fresh instance first looks for an
 * already-existing, idle subagent of the same profile owned by the caller and
 * reuses it (resume semantics — conversation context preserved) instead of
 * allocating a new one. Instances are parked in the lifecycle registry until
 * the session closes, so after a run finishes the instance is idle again and
 * becomes the next spawn target.
 *
 * The in-process candidate scan is synchronous after a single metadata read,
 * and the claim (when `claimInto` is provided) happens in the same synchronous
 * block. With JavaScript's single-threaded semantics no two concurrent spawn
 * attempts can pick the same instance between the scan and the claim — the
 * batch's "no double-claim" guarantee. The caller must release the claim
 * (delete from `claimInto`) once the run has started or failed to start; from
 * then on the instance's own `running` loop state excludes it from reuse.
 *
 * Same-profile serialization: `findBusyOwnedSubagent` surfaces an owned
 * same-profile instance that is running (or reserved for reuse by the batch)
 * so the duty pick can return it as `busy` — the caller waits for its run to
 * settle and reuses the SAME instance instead of creating a parallel one.
 *
 * After a process restart the registry no longer holds the session's parked
 * instances, so a cold fallback re-materializes a resting subagent from the
 * persisted session metadata + runtime-status table (`create` is create-or-get
 * for an explicit id, so concurrent materializations of the same instance join
 * instead of duplicating the scope — no lock needed).
 */

import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { IAgentScopeHandle } from '#/_base/di/scope';

import { IAgentLifecycleService } from './agentLifecycle';
import {
  isSubagentMeta,
  subagentParentAgentId,
  subagentProfileName,
} from './subagentMetadata';

export interface FindIdleOwnedSubagentInput {
  readonly lifecycle: IAgentLifecycleService;
  readonly metadata: ISessionMetadata;
  readonly runtimeStatus: IRuntimeStatusService;
  /** The session the reuse scan runs in — scopes the persisted status lookup. */
  readonly sessionId: string;
  readonly callerAgentId: string;
  readonly profileName: string;
  /** Instances already claimed for reuse within the current batch — skipped. */
  readonly claimInto?: Set<string>;
}

/** One parked, idle, owned subagent candidate for reuse. */
export interface IdleOwnedSubagentCandidate {
  readonly agentId: string;
  /** Deterministic tie-break: the `agent-<n>` numeric suffix. */
  readonly ordinal: number;
  /** The instance's bound model alias — used for per-model score weighting. */
  readonly model?: string;
}

/**
 * List every parked, idle, owned subagent of `profileName` (in-process
 * registry scan). Idle = the loop is not running; owned = the metadata parent
 * is `callerAgentId`. `claimInto` entries are skipped so a concurrent batch
 * cannot double-claim. The scan is synchronous after a single metadata read —
 * with JavaScript's single-threaded semantics the returned list is a stable
 * snapshot for the caller to rank and claim.
 */
export async function listIdleOwnedSubagents(
  input: FindIdleOwnedSubagentInput,
): Promise<IdleOwnedSubagentCandidate[]> {
  const { lifecycle, metadata, callerAgentId, profileName, claimInto } = input;
  const agents = (await metadata.read()).agents ?? {};
  const candidates: IdleOwnedSubagentCandidate[] = [];
  for (const handle of lifecycle.list()) {
    if (claimInto?.has(handle.id) === true) continue;
    if (handle.accessor.get(IAgentLoopService).status().state === 'running') continue;
    const agentMeta = agents[handle.id];
    if (!isSubagentMeta(agentMeta)) continue;
    if (subagentParentAgentId(agentMeta) !== callerAgentId) continue;
    const profile = handle.accessor.get(IAgentProfileService).data();
    if (profile.profileName !== profileName) continue;
    candidates.push({
      agentId: handle.id,
      ordinal: agentOrdinal(handle.id),
      model: profile.modelAlias,
    });
  }
  return candidates;
}

/**
 * Find an owned subagent of `profileName` that is currently busy: its loop is
 * running, or it is claimed into `claimInto` (a batch sibling is about to run
 * it). Returns the highest-`agent-<n>` busy instance, or `undefined` when the
 * profile has no in-flight instance (free to spawn fresh or reuse an idle
 * candidate). The caller of a `busy` result waits for the instance to settle
 * and then reuses the SAME instance — the same-profile serialization invariant.
 */
export async function findBusyOwnedSubagent(
  input: FindIdleOwnedSubagentInput,
): Promise<string | undefined> {
  const { lifecycle, metadata, callerAgentId, profileName, claimInto } = input;
  const agents = (await metadata.read()).agents ?? {};
  let best: string | undefined;
  let bestOrdinal = Number.NEGATIVE_INFINITY;
  for (const handle of lifecycle.list()) {
    const agentMeta = agents[handle.id];
    if (!isSubagentMeta(agentMeta)) continue;
    if (subagentParentAgentId(agentMeta) !== callerAgentId) continue;
    if (handle.accessor.get(IAgentProfileService).data().profileName !== profileName) continue;
    const busy =
      handle.accessor.get(IAgentLoopService).status().state === 'running' ||
      claimInto?.has(handle.id) === true;
    if (!busy) continue;
    const ordinal = agentOrdinal(handle.id);
    if (ordinal > bestOrdinal) {
      best = handle.id;
      bestOrdinal = ordinal;
    }
  }
  return best;
}

/**
 * Materialize an owned subagent by id — cold or hot. Validates the persisted
 * session metadata (the agent exists, is a subagent, and is owned by
 * `callerAgentId`) before creating the scope; `create` is create-or-get for an
 * explicit id, so an already-live instance is returned as-is and concurrent
 * materializations of the same instance join into a single scope. Returns
 * `undefined` when the metadata check fails (typo / another parent's agent /
 * the main agent), so callers never materialize an agent they do not own.
 */
export async function materializeOwnedSubagent(input: {
  readonly lifecycle: IAgentLifecycleService;
  readonly metadata: ISessionMetadata;
  readonly callerAgentId: string;
  readonly agentId: string;
}): Promise<IAgentScopeHandle | undefined> {
  const { lifecycle, metadata, callerAgentId, agentId } = input;
  const meta = (await metadata.read()).agents?.[agentId];
  if (!isSubagentMeta(meta)) return undefined;
  if (subagentParentAgentId(meta) !== callerAgentId) return undefined;
  return lifecycle.create({ agentId });
}

/**
 * Find the best parked, idle, owned subagent of `profileName` for reuse.
 *
 * Returns the agent id of the most recently allocated candidate (highest
 * `agent-<n>` numeric suffix — deterministic), or `undefined` when no such
 * instance exists. When `claimInto` is provided, the returned id is added to
 * it atomically with the pick so concurrent spawn attempts in the same batch
 * cannot claim the same instance.
 */
export async function findIdleOwnedSubagent(
  input: FindIdleOwnedSubagentInput,
): Promise<string | undefined> {
  const { lifecycle, metadata, runtimeStatus, callerAgentId, profileName, claimInto } = input;
  const candidates = await listIdleOwnedSubagents(input);
  const best = bestByOrdinal(candidates);
  if (best !== undefined) {
    // Atomic with the pick: no await between the scan and the claim, so two
    // concurrent spawn attempts can never both claim `best`.
    claimInto?.add(best.agentId);
    return best.agentId;
  }

  // 2) Cold fallback: after a process restart the registry no longer holds the
  // session's parked subagents, but a resting one is recoverable from the
  // persisted session metadata (parent + `profileName` labels) intersected
  // with the runtime-status table. Old sessions whose agent metadata predates
  // the `profileName` label never match here and fall through to a fresh
  // creation (degradation, never an error).
  let coldBest: IdleOwnedSubagentCandidate | undefined;
  const agents = (await metadata.read()).agents ?? {};
  const statuses = await runtimeStatus.listForSession(input.sessionId);
  for (const [agentId, agentMeta] of Object.entries(agents)) {
    if (claimInto?.has(agentId) === true) continue;
    if (!isSubagentMeta(agentMeta)) continue;
    if (subagentParentAgentId(agentMeta) !== callerAgentId) continue;
    if (subagentProfileName(agentMeta) !== profileName) continue;
    const entry = statuses[profileName];
    if (entry === undefined || entry.state !== 'resting' || entry.agentId !== agentId) continue;
    const candidate: IdleOwnedSubagentCandidate = { agentId, ordinal: agentOrdinal(agentId) };
    if (coldBest === undefined || candidate.ordinal > coldBest.ordinal) coldBest = candidate;
  }
  if (coldBest === undefined) return undefined;

  // Materialize the parked instance back into the live registry through the
  // shared owned-subagent helper (`create` is create-or-get for an explicit id,
  // so concurrent cold materializations of the same instance join into a single
  // scope — no lock needed here).
  const handle = await materializeOwnedSubagent({
    lifecycle,
    metadata,
    callerAgentId,
    agentId: coldBest.agentId,
  });
  if (handle === undefined) return undefined;
  // Re-check running: a concurrent path may have materialized and started the
  // instance while we were scanning; a running instance is not reusable.
  if (handle.accessor.get(IAgentLoopService).status().state === 'running') {
    return undefined;
  }
  claimInto?.add(coldBest.agentId);
  return coldBest.agentId;
}

function bestByOrdinal(
  candidates: readonly IdleOwnedSubagentCandidate[],
): IdleOwnedSubagentCandidate | undefined {
  let best: IdleOwnedSubagentCandidate | undefined;
  let bestOrdinal = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.ordinal > bestOrdinal) {
      best = candidate;
      bestOrdinal = candidate.ordinal;
    }
  }
  return best;
}

/** Deterministic tie-break: the highest `agent-<n>` numeric suffix wins. */
function agentOrdinal(agentId: string): number {
  const match = /^agent-(\d+)$/.exec(agentId);
  return match === null ? -1 : Number(match[1]);
}
