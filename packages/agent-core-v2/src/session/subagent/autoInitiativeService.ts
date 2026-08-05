/**
 * `subagent` domain (L6) — team auto-initiative (proactive management).
 *
 * Session-scoped helper owned by `SessionSubagentService`, mirroring the
 * `SubagentIdleReaper` / `DailyReviewService` Disposable+timer shape. When team
 * mode + `[subagent] team_auto` are on, and the main agent (tech-lead) has
 * been idle past `[subagent] auto_idle_ms` (default 5 min, `0` disables), the
 * engine injects a proactive "review the project and apply ONE bounded
 * improvement" prompt — strategy design, documentation, or process — turning
 * "management science proactive management" into a mechanical cadence.
 *
 * **Activity clock**: `lastActivityAt` refreshes whenever the main agent's
 * loop is `running` (a user turn, an injected prompt, a dispatch — any turn
 * marks activity). The periodic check (every 60s) reads the loop state; an
 * idle main past the threshold fires once. **Anti-spam**: after a fire,
 * `lastAutoAt` blocks another fire for 10 minutes even if still idle.
 *
 * **Arming**: the timer is only armed when `team_auto` is on (checked at
 * construction and on `[subagent]` config changes, plus cold-resume
 * `reconcile`) — a non-auto session never arms the self-re-arming timer, so
 * "advance all timers" fake-clock helpers are not chased into an infinite
 * loop. Guards are silent: non-team / auto off / threshold 0 / main not
 * materialized / inject failure → skip.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import {
  resolveTeamAuto,
  resolveTeamAutoIdleMs,
  resolveTeamMode,
  SUBAGENT_SECTION,
} from './configSection';

/** Reminder origin name — non-user so it bypasses the UserPromptSubmit filter. */
export const AUTO_INITIATIVE_REMINDER_NAME = 'team_auto_initiative';
/** How often the idle check runs. */
export const AUTO_CHECK_INTERVAL_MS = 60_000;
/** Minimum gap between two auto-initiative fires (anti-spam). */
export const AUTO_MIN_INTERVAL_MS = 10 * 60_000;

export class AutoInitiativeService extends Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Last moment the main agent was active (loop running / turn started). */
  private lastActivityAt: number | undefined;
  /** Last moment an auto-initiative fired (anti-spam window). */
  private lastAutoAt: number | undefined;

  constructor(
    private readonly lifecycle: IAgentLifecycleService,
    private readonly config: IConfigService,
    private readonly log: ILogService,
  ) {
    super();
    this._register({
      dispose: () => {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
      },
    });
    // Re-arm on a runtime `/team auto` toggle. The real config service always
    // exposes the event; guard so harness config stubs (which may omit it) are
    // safe and `_register` never receives `undefined`.
    const onSectionChange = this.config.onDidSectionChange;
    if (onSectionChange !== undefined) {
      this._register(
        onSectionChange((event) => {
          if (event.domain === SUBAGENT_SECTION) this.maybeArm();
        }),
      );
    }
    this.maybeArm();
  }

  /** Cold resume: re-arm the periodic timer the previous process lost. */
  reconcile(): void {
    this.maybeArm();
  }

  /**
   * Run the idle check if due. Public so tests can drive it; `onTick` wraps
   * it with the re-arm. Guards + anti-spam all silent.
   */
  async check(): Promise<void> {
    if (!resolveTeamMode(this.config) || !resolveTeamAuto(this.config)) return;
    const autoIdleMs = resolveTeamAutoIdleMs(this.config);
    if (autoIdleMs <= 0) return; // 0 = idle trigger off
    const mainHandle = this.lifecycle.get(MAIN_AGENT_ID);
    if (mainHandle === undefined) return; // main not materialized
    const now = Date.now();
    const state = mainHandle.accessor.get(IAgentLoopService).status().state;
    if (state === 'running') {
      this.lastActivityAt = now; // any turn (user / inject / dispatch) is activity
      return;
    }
    if (this.lastActivityAt === undefined) {
      this.lastActivityAt = now; // first idle observation — start the baseline
      return;
    }
    const idleMs = now - this.lastActivityAt;
    if (idleMs < autoIdleMs) return;
    if (this.lastAutoAt !== undefined && now - this.lastAutoAt < AUTO_MIN_INTERVAL_MS) return;
    this.lastAutoAt = now;
    const seconds = Math.round(idleMs / 1000);
    try {
      const promptService = mainHandle.accessor.get(IAgentPromptService);
      await promptService.inject(this.initiativeMessage(seconds));
    } catch (error) {
      this.log.warn('team auto initiative inject failed', { error });
    }
    // The inject opens a turn on the main agent — reset the idle clock.
    this.lastActivityAt = Date.now();
  }

  private maybeArm(): void {
    if (resolveTeamAuto(this.config)) {
      this.arm();
    } else {
      this.cancel();
    }
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onTick();
    }, AUTO_CHECK_INTERVAL_MS);
  }

  private cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private onTick(): void {
    this.arm(); // re-arm first — a slow/failed check must not drop the schedule
    void this.check();
  }

  private initiativeMessage(idleSeconds: number): ContextMessage {
    return {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Auto initiative (team auto): idle for ${idleSeconds}s. As the tech-lead, review the project — git status/log, open tasks, pipeline.md, docs, team performance — and apply ONE bounded improvement: strategy design, documentation, or process. Record what you did.`,
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: AUTO_INITIATIVE_REMINDER_NAME },
    };
  }
}
