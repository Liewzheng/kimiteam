/**
 * `subagent` domain (L6) — daily low-performer review reminder.
 *
 * Session-scoped helper owned by `SessionSubagentService`, mirroring the
 * `SubagentIdleReaper` / `SubagentWarmService` Disposable+timer shape. Once per
 * local calendar day, in team mode, when at least one member has a score, the
 * main agent (tech-lead) is nudged to review the lowest-scored member's
 * history and apply one optimization — model override, prompt fix, tool set
 * change, or a small trial dispatch.
 *
 * **Scheduling**: the timer is anchored to the *next local midnight* (not a
 * fixed 24h interval) so it never drifts across DST / wall-clock changes. It
 * re-arms itself after every fire. On cold resume (session restart) the
 * previous process's timer is gone; {@link reconcile} re-hangs it for the
 * next midnight — the restart day is therefore never re-reviewed, which is the
 * same-day dedupe that survives a process boundary (the in-memory
 * `lastReviewedDay` marker handles same-process duplicates).
 *
 * **Guards** (all silent): non-team mode, no scored member, main agent not
 * materialized, or an inject failure → skip. The day is marked as accounted
 * for regardless, so a skipped day does not re-fire later in the same day.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IAgentPerformanceService } from '#/app/agentPerformance/agentPerformance';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { resolveTeamMode } from './configSection';

/** Reminder origin name — non-user so it bypasses the UserPromptSubmit filter. */
export const DAILY_REVIEW_REMINDER_NAME = 'daily_low_performer_review';

/** Local calendar day key `YYYY-MM-DD`. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface ScoredMember {
  readonly profileName: string;
  readonly average: number;
  readonly count: number;
}

export class DailyReviewService extends Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Local calendar day the review last fired (in-memory). */
  private lastReviewedDay: string | undefined;

  constructor(
    private readonly lifecycle: IAgentLifecycleService,
    private readonly perf: IAgentPerformanceService,
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
    // Arm only in team mode: the midnight timer re-arms itself on every fire,
    // which an "advance all timers" fake-clock helper would otherwise chase
    // forever — a non-team session must not arm it at all.
    if (resolveTeamMode(this.config)) {
      this.scheduleNextMidnight();
    }
  }

  /** Cold resume: re-hang the midnight timer the previous process lost. */
  reconcile(): void {
    if (resolveTeamMode(this.config)) {
      this.scheduleNextMidnight();
    }
  }

  /**
   * Run the daily review if due. Public so tests (and a potential manual /
   * midnight trigger) can drive it; `onMidnight` wraps it with the re-arm.
   * Dedupe is by local calendar day.
   */
  async runDailyReview(): Promise<void> {
    const today = localDayKey(new Date());
    if (!resolveTeamMode(this.config)) return;
    if (this.lastReviewedDay === today) return; // already fired today
    this.lastReviewedDay = today; // account for the day even if the review is skipped below
    const mainHandle = this.lifecycle.get(MAIN_AGENT_ID);
    if (mainHandle === undefined) return; // main not materialized — skip silently
    const lowest = await this.lowestScoredMember();
    if (lowest === undefined) return; // no scored members — skip silently
    try {
      const promptService = mainHandle.accessor.get(IAgentPromptService);
      await promptService.inject(this.reviewMessage(lowest));
    } catch (error) {
      this.log.warn('daily low-performer review inject failed', { error });
    }
  }

  private scheduleNextMidnight(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const delay = Math.max(1, next.getTime() - now.getTime());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onMidnight();
    }, delay);
  }

  private onMidnight(): void {
    this.scheduleNextMidnight(); // re-arm first — a slow/failed review must not drop the schedule
    void this.runDailyReview();
  }

  /** Lowest average among scored members (count ≥ 1), or `undefined`. */
  private async lowestScoredMember(): Promise<ScoredMember | undefined> {
    let lowest: ScoredMember | undefined;
    for (const entry of await this.perf.list()) {
      const { average, count } = entry.summary;
      if (average === undefined || count < 1) continue;
      if (lowest === undefined || average < lowest.average) {
        lowest = { profileName: entry.profileName, average, count };
      }
    }
    return lowest;
  }

  private reviewMessage(lowest: ScoredMember): ContextMessage {
    return {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Daily review: the lowest-scored member is ${lowest.profileName} (avg ${lowest.average}, ${lowest.count} scores). Analyze why — model quality, prompt, tool limitations, or task mismatch — then apply one optimization (model override, prompt fix, tool set change, or a small trial dispatch) and record it.`,
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: DAILY_REVIEW_REMINDER_NAME },
    };
  }
}
