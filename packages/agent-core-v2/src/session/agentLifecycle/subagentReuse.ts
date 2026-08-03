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
 * The candidate scan is synchronous after a single metadata read, and the
 * claim (when `claimInto` is provided) happens in the same synchronous block.
 * With JavaScript's single-threaded semantics no two concurrent spawn
 * attempts can pick the same instance between the scan and the claim — the
 * batch's "no double-claim" guarantee. The caller must release the claim
 * (delete from `claimInto`) once the run has started or failed to start; from
 * then on the instance's own `running` loop state excludes it from reuse.
 */

import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { IAgentLifecycleService } from './agentLifecycle';
import { isSubagentMeta, subagentParentAgentId } from './subagentMetadata';

export interface FindIdleOwnedSubagentInput {
  readonly lifecycle: IAgentLifecycleService;
  readonly metadata: ISessionMetadata;
  readonly callerAgentId: string;
  readonly profileName: string;
  /** Instances already claimed for reuse within the current batch — skipped. */
  readonly claimInto?: Set<string>;
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
  const { lifecycle, metadata, callerAgentId, profileName, claimInto } = input;
  const agents = (await metadata.read()).agents ?? {};
  let best: string | undefined;
  let bestOrdinal = Number.NEGATIVE_INFINITY;
  for (const handle of lifecycle.list()) {
    if (claimInto?.has(handle.id) === true) continue;
    if (handle.accessor.get(IAgentLoopService).status().state === 'running') continue;
    const agentMeta = agents[handle.id];
    if (!isSubagentMeta(agentMeta)) continue;
    if (subagentParentAgentId(agentMeta) !== callerAgentId) continue;
    if (handle.accessor.get(IAgentProfileService).data().profileName !== profileName) continue;
    const ordinal = agentOrdinal(handle.id);
    if (ordinal > bestOrdinal) {
      best = handle.id;
      bestOrdinal = ordinal;
    }
  }
  if (best !== undefined) {
    // Atomic with the pick: no await between the scan and the claim, so two
    // concurrent spawn attempts can never both claim `best`.
    claimInto?.add(best);
  }
  return best;
}

/** Deterministic tie-break: the highest `agent-<n>` numeric suffix wins. */
function agentOrdinal(agentId: string): number {
  const match = /^agent-(\d+)$/.exec(agentId);
  return match === null ? -1 : Number(match[1]);
}
