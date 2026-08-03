/**
 * `subagent` domain (L6) — idle-subagent reaper (10-minute off-duty TTL).
 *
 * Session-scoped helper owned by `SessionSubagentService`. After a subagent's
 * run settles (success, failure, or cancellation) it starts a
 * `SUBAGENT_IDLE_TTL_MS` countdown; when the countdown expires while the
 * instance is still idle it is destroyed through
 * `IAgentLifecycleService.remove` — the instance goes off duty. The countdown
 * is cancelled the moment a new run starts on the instance (reuse claim,
 * explicit resume, and fresh spawns all funnel through
 * `SessionSubagentService.run`), so an instance with work is never reaped.
 * Turns woken outside `run` (e.g. a TeamMessage inject) are protected by the
 * final `state !== 'running'` re-check at reap time. The main agent is never
 * armed, hence never reaped. All timers are cleared on disposal (session
 * close) — the service follows the `Disposable` convention of its owner.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';

/** How long a parked subagent instance may stay idle before being reaped. */
export const SUBAGENT_IDLE_TTL_MS = 10 * 60_000;

/**
 * ISO expiry for `now + ttl` — the resting horizon written to the runtime
 * status file, mirroring the reaper's own `setTimeout` horizon so the panel
 * can show "off duty at <restExpiresAt>".
 */
export function subagentRestExpiresAt(
  now: number = Date.now(),
  ttl: number = SUBAGENT_IDLE_TTL_MS,
): string {
  return new Date(now + ttl).toISOString();
}

interface IdleTimerEntry {
  /** Profile the instance was armed under; used to drop the status entry on reap. */
  readonly profileName: string | undefined;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class SubagentIdleReaper extends Disposable {
  private readonly timers = new Map<string, IdleTimerEntry>();

  constructor(
    private readonly lifecycle: IAgentLifecycleService,
    private readonly status: IRuntimeStatusService,
    private readonly log: ILogService,
  ) {
    super();
    this._register({
      dispose: () => {
        for (const entry of this.timers.values()) clearTimeout(entry.timeout);
        this.timers.clear();
      },
    });
  }

  /**
   * Start (or restart) the idle countdown for `agentId` after its run settled.
   * The main agent is never armed. No-op when a countdown is already pending
   * for another reason — it is simply restarted.
   */
  arm(agentId: string, profileName: string | undefined): void {
    if (agentId === MAIN_AGENT_ID) return;
    this.cancel(agentId);
    const timeout = setTimeout(() => this.onTimerFired(agentId), SUBAGENT_IDLE_TTL_MS);
    this.timers.set(agentId, { profileName, timeout });
  }

  /** Cancel a pending countdown — a new run is starting on the instance. */
  cancel(agentId: string): void {
    const entry = this.timers.get(agentId);
    if (entry === undefined) return;
    clearTimeout(entry.timeout);
    this.timers.delete(agentId);
  }

  private onTimerFired(agentId: string): void {
    const entry = this.timers.get(agentId);
    this.timers.delete(agentId);
    void this.reap(agentId, entry?.profileName);
  }

  private async reap(agentId: string, profileName: string | undefined): Promise<void> {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) return; // already removed (e.g. session close)
    // Re-check right before destruction: a turn woken outside `run` (e.g. a
    // TeamMessage inject) between settle and now must not be cut down.
    if (handle.accessor.get(IAgentLoopService).status().state === 'running') {
      this.log.debug('subagent idle reap skipped — instance is running', { agentId });
      return;
    }
    try {
      await this.lifecycle.remove(agentId);
    } catch (error) {
      this.log.warn('subagent idle reap failed', { agentId, error });
      return;
    }
    this.log.info('subagent idle reap: instance went off duty', { agentId, profileName });
    if (profileName !== undefined) {
      void this.status.removeProfile(profileName).catch(() => { /* swallow */ });
    }
  }
}
