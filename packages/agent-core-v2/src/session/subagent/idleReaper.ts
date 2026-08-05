/**
 * `subagent` domain (L6) — idle-subagent reaper (default 2-hour off-duty TTL,
 * configurable via `[subagent] idle_ttl_ms`).
 *
 * Session-scoped helper owned by `SessionSubagentService`. After a subagent's
 * run settles (success, failure, or cancellation) it starts an idle countdown
 * (the resolved `idle_ttl_ms`, defaulting to {@link SUBAGENT_IDLE_TTL_MS}); when
 * the countdown expires while the instance is still idle it is destroyed
 * through `IAgentLifecycleService.remove` — the instance goes off duty. The
 * countdown is cancelled the moment a new run starts on the instance (reuse
 * claim, explicit resume, and fresh spawns all funnel through
 * `SessionSubagentService.run`), so an instance with work is never reaped.
 * Turns woken outside `run` (e.g. a TeamMessage inject) are protected by the
 * final `state !== 'running'` re-check at reap time. The main agent is never
 * armed, hence never reaped. All timers are cleared on disposal (session
 * close) — the service follows the `Disposable` convention of its owner.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import {
  DEFAULT_SUBAGENT_IDLE_TTL_MS,
  resolveSubagentDutyIdleTtlMs,
  resolveSubagentIdleTtlMs,
} from './configSection';

/**
 * Default idle TTL for a parked subagent instance. When `[subagent]
 * idle_ttl_ms` is not configured the reaper falls back to this.
 */
export const SUBAGENT_IDLE_TTL_MS = DEFAULT_SUBAGENT_IDLE_TTL_MS;

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
  /** Profile the instance was armed under; used for the reap log line. */
  readonly profileName: string | undefined;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class SubagentIdleReaper extends Disposable {
  private readonly timers = new Map<string, IdleTimerEntry>();

  constructor(
    private readonly lifecycle: IAgentLifecycleService,
    private readonly status: IRuntimeStatusService,
    private readonly log: ILogService,
    private readonly config: IConfigService,
    private readonly catalog: ISessionAgentProfileCatalog,
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
   * The main agent is never armed. Duty members (`duty: true` in their agent
   * file) go off duty only through an explicit TaskStop — never through the
   * idle TTL: `[subagent] duty_idle_ttl_ms` (default `0`) decides, `0` meaning
   * the member is never armed hence never reaped, a non-zero value arming it
   * at that longer horizon instead of the normal idle TTL. No-op when a
   * countdown is already pending for another reason — it is simply restarted.
   * `ttlMs` defaults to the resolved `[subagent] idle_ttl_ms` (falling back to
   * the default idle TTL); callers that re-hang a partially-elapsed horizon
   * (see {@link reconcile}) pass the remaining time instead.
   */
  arm(agentId: string, profileName: string | undefined, ttlMs?: number): void {
    if (agentId === MAIN_AGENT_ID) return;
    if (this.isDutyProfile(profileName)) {
      const dutyTtlMs = resolveSubagentDutyIdleTtlMs(this.config);
      if (dutyTtlMs <= 0) return; // never reaped — duty member stays parked
      this.schedule(agentId, profileName, dutyTtlMs);
      return;
    }
    this.schedule(agentId, profileName, ttlMs ?? resolveSubagentIdleTtlMs(this.config));
  }

  private schedule(agentId: string, profileName: string | undefined, ttlMs: number): void {
    this.cancel(agentId);
    const timeout = setTimeout(() => this.onTimerFired(agentId), ttlMs);
    this.timers.set(agentId, { profileName, timeout });
  }

  /** Whether `profileName` names an on-duty member — same semantics as `isDutyProfile` in the Agent tool. */
  private isDutyProfile(profileName: string | undefined): boolean {
    if (profileName === undefined) return false;
    return this.catalog.get(profileName)?.duty === true;
  }

  /**
   * Re-arm a resting instance's countdown after a cold resume (session was
   * restarted, so this reaper's in-process timers were all lost).
   *
   * Reads the persisted runtime status: when a `resting` entry references
   * `agentId`, the countdown is restarted for the *remaining* TTL (the
   * `restExpiresAt` written before the process died), or — when that horizon
   * already passed while we were down — the entry is reaped immediately
   * (instance removed; the resting status entry is kept as a terminal
   * expired-resting record). Entries referencing other agents, `working`
   * entries, and the main agent are left untouched. Resolves once the entry
   * has been re-armed or fully reaped.
   */
  async reconcile(agentId: string): Promise<void> {
    if (agentId === MAIN_AGENT_ID) return;
    const raw = await this.status.list();
    for (const [profileName, entry] of Object.entries(raw)) {
      if (entry.state !== 'resting' || entry.agentId !== agentId) continue;
      if (this.isDutyProfile(profileName)) {
        // Duty members go off duty only via TaskStop. The persisted
        // `restExpiresAt` was written with the normal idle TTL and does not
        // apply to them — re-hang through arm() (duty_idle_ttl_ms policy,
        // default 0 = never armed hence never reaped).
        this.arm(agentId, profileName);
        return;
      }
      const remainingMs = Date.parse(entry.restExpiresAt ?? '') - Date.now();
      if (Number.isFinite(remainingMs) && remainingMs > 0) {
        this.arm(agentId, profileName, remainingMs);
      } else {
        // No `restExpiresAt` (malformed resting entry) or already elapsed —
        // the parked instance goes off duty now.
        await this.reap(agentId, profileName);
      }
      return;
    }
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
    // The runtime-status entry is deliberately KEPT — the parked member's
    // prior completion stays visible to the panel as a terminal
    // expired-resting record (restExpiresAt in the past), instead of
    // `removeProfile` erasing the state and degrading the member to a
    // stateless on-duty. A later spawn overwrites the entry via markWorking.
  }
}
