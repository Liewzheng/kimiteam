/**
 * `team-score` tool domain (L7) — ITeamScoreTool implementation.
 *
 * Writes a score entry via IAgentPerformanceService and returns an updated
 * summary text. When invoked by a subagent, returns an error. The `record`
 * action is gated by the TeamScore acceptance gate (`[subagent] score_gate`,
 * default `enforce`): unless disabled (`off`) or downgraded (`warn`), a
 * record requires a detectable acceptance action since the profile's latest
 * delivery completed — read of its output, a diff review, or a test rerun —
 * resolved through `IAcceptanceEvidenceService`. Shape detection only; it
 * blocks "scored with no acceptance at all", never "perfunctory acceptance".
 * `penalty` is always exempt. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ILogService } from '#/_base/log/log';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ExecutableToolContext, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { IAgentPerformanceService, type PerformanceEntry } from '#/app/agentPerformance/agentPerformance';
import { IConfigService } from '#/app/config/config';
import { resolveScoreGate, resolveTeamMode } from '#/session/subagent/configSection';

import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ITeamScoreTool, TeamScoreToolInputSchema, SUBAGENT_NOT_ALLOWED, type TeamScoreToolInput } from './team-score';
import { IAcceptanceEvidenceService } from './acceptanceEvidence';

const TOOL_DESCRIPTION =
  'Give a subagent member a performance score (0-100) with a one-line comment. Score history is used for dispatch decisions when the main agent needs to pick which subagent is most capable. ' +
  'Consistently low scores indicate the current model is not suitable for this member. ' +
  'To switch within the same cost tier (offline↔offline, online↔online), you may autonomously update [subagent.model_overrides] or adjust dispatch parameters. ' +
  'An offline→online upgrade incurs new costs and requires AskUserQuestion to the user first (attach the member\'s score history and time-on-task evidence). ' +
  'The [subagent] allow_cost_upgrade = true config key indicates the user has pre-authorized such upgrades.';

/**
 * Minimum sample size before a distribution is judged at all — a fresh member
 * with one or two scores is not inflation, it is a ramp-up.
 */
export const INFLATION_MIN_SAMPLE = 5;
/** A score at or above this is a "high" grade for inflation purposes. */
export const INFLATION_HIGH_SCORE = 75;
/** How many recent scores the inflation check considers (including the new one). */
export const INFLATION_WINDOW = 10;

/**
 * Detect score inflation for a profile from its recent raw scores (newest
 * last, already capped at {@link INFLATION_WINDOW}). Returns a neutral
 * calibration warning when the sample is large enough and the distribution is
 * skewed high — every score ≥ 75, or an average ≥ 75 — and `undefined`
 * otherwise. Advisory only: the caller decides whether to surface it; this
 * never rejects a score.
 */
export function detectScoreInflation(
  profileName: string,
  recentScores: readonly number[],
): string | undefined {
  const window = recentScores.slice(-INFLATION_WINDOW);
  if (window.length < INFLATION_MIN_SAMPLE) return undefined;
  const allHigh = window.every((score) => score >= INFLATION_HIGH_SCORE);
  const average = window.reduce((a, b) => a + b, 0) / window.length;
  if (!allHigh && average < INFLATION_HIGH_SCORE) return undefined;
  const n = window.length;
  return allHigh
    ? `Score inflation detected: the last ${n} scores for ${profileName} are all >= ${INFLATION_HIGH_SCORE}. Recalibrate against the rubric — 80 is the passing grade, 90+ reserved for exceptional work.`
    : `Score inflation detected: the average of the last ${n} scores for ${profileName} is >= ${INFLATION_HIGH_SCORE}. Recalibrate against the rubric — 80 is the passing grade, 90+ reserved for exceptional work.`;
}


export class TeamScoreTool implements ITeamScoreTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamScore';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamScoreToolInputSchema);
  private readonly callerAgentId: string;

  constructor(
    @ISessionMetadata private readonly sessionMeta: ISessionMetadata,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentPerformanceService private readonly perf: IAgentPerformanceService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IAcceptanceEvidenceService private readonly evidence: IAcceptanceEvidenceService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    return TOOL_DESCRIPTION;
  }

  async resolveExecution(args: TeamScoreToolInput): Promise<ToolExecution> {
    if (await this._isCallerSubagent()) {
      return { output: SUBAGENT_NOT_ALLOWED, isError: true };
    }

    const isPenalty = args.action === 'penalty';
    return {
      description: isPenalty
        ? `Penalize ${args.profile} with ${args.points} points: ${args.reason}`
        : `Score ${args.profile} with ${args.score}: ${args.note}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'generic',
        summary: isPenalty ? `${args.profile}: -${args.points} penalty` : `${args.profile}: ${args.score}/100`,
      },
      approvalRule: this.name,
      execute: async (ctx) => this._execute(args, ctx),
    };
  }

  private async _isCallerSubagent(): Promise<boolean> {
    const meta = (await this.sessionMeta.read()).agents?.[this.callerAgentId];
    return isSubagentMeta(meta);
  }

  private async _execute(
    args: TeamScoreToolInput,
    _ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (args.action === 'penalty') {
      return this.executePenalty(args);
    }
    // ── record (default) ── schema guarantees `score` / `note` are present.
    const score = args.score!;
    const note = args.note!;

    // Engine-level acceptance gate (record only; penalty exempt): the main
    // agent must have performed a detectable acceptance action since the
    // member's delivery completed — read of its output, a diff review, or a
    // test rerun. Shape detection only: blocks "scored with no acceptance at
    // all", never "perfunctory acceptance". `enforce` rejects; `warn` records
    // and appends a warning; `off` is unchanged. Active only in team mode.
    let gateWarning: string | undefined;
    if (resolveScoreGate(this.config) !== 'off' && resolveTeamMode(this.config)) {
      const gate = this.evidence.evaluateRecordGate(args.profile);
      if (!gate.ok) {
        if (resolveScoreGate(this.config) === 'enforce') {
          return {
            isError: true,
            output: `[TeamScore] Blocked by acceptance gate: ${gate.message}`,
          };
        }
        gateWarning = gate.message;
      }
    }

    await this.perf.record({
      profileName: args.profile,
      ts: new Date().toISOString(),
      score,
      note,
      model: args.model,
      agentId: args.agent_id,
      todoId: args.todo_id,
    });

    const sum = await this.perf.summary(args.profile);
    if (sum.count === 0) {
      const parts = [`[TeamScore] Scored "${args.profile}" — \`${score}/100\`. No scores yet.`];
      if (gateWarning !== undefined) parts.push(`[TeamScore] Warning: ${gateWarning}`);
      return { output: parts.join(' ') };
    }

    const parts: string[] = [`[TeamScore] Scored "${args.profile}" — \`${score}/100\`.`];
    if (sum.last !== undefined) {
      parts.push(`Last score: ${sum.last}.`);
    }
    if (sum.average !== undefined) {
      parts.push(`Average: ${sum.average} (${sum.count} total).`);
    }
    // Score-inflation calibration warning: advisory only — appended to the
    // normal result, never a rejection. Reads the profile's recent raw scores
    // (including the one just recorded) and flags a high-skew distribution.
    const recentScores = await this.perf.recentScores(args.profile, INFLATION_WINDOW);
    const inflationWarning = detectScoreInflation(args.profile, recentScores);
    if (inflationWarning !== undefined) {
      parts.push(inflationWarning);
    }
    // Acceptance-gate warning (`score_gate=warn`): recorded anyway, but the
    // main agent is told the evidence was missing.
    if (gateWarning !== undefined) {
      parts.push(`[TeamScore] Warning: ${gateWarning}`);
    }
    return { output: parts.join(' ') };
  }

  /**
   * Penalty: append a negative entry without rewriting history. The new score
   * is `max(0, round(currentAverage - points))`, the note carries the
   * `[penalty]` prefix (audit trail), and the entry counts into the average
   * and count like any other score — the average naturally drifts down.
   * Requires the profile to already have scored history and the caller to name
   * the member's actual execution model.
   */
  private async executePenalty(args: TeamScoreToolInput): Promise<ExecutableToolResult> {
    const points = args.points!;
    const before = await this.perf.summary(args.profile);
    if (before.count === 0 || before.average === undefined) {
      return {
        isError: true,
        output: `[TeamScore] Cannot penalize "${args.profile}" — it has no performance history to deduct from.`,
      };
    }
    const score = Math.max(0, Math.round(before.average - points));
    await this.perf.record({
      profileName: args.profile,
      ts: new Date().toISOString(),
      score,
      note: `[penalty] ${args.reason}`,
      model: args.model,
      agentId: args.agent_id,
      todoId: args.todo_id,
    });

    const parts: string[] = [
      `[TeamScore] Penalized "${args.profile}" — deducted ${points} points (recorded \`${score}/100\`).`,
    ];
    const after = await this.perf.summary(args.profile);
    if (after.average !== undefined) {
      parts.push(`Average: ${after.average} (${after.count} total).`);
    }
    // Low scores cannot trip the inflation warning, but keep the same advisory
    // check as record for symmetry.
    const recentScores = await this.perf.recentScores(args.profile, INFLATION_WINDOW);
    const inflationWarning = detectScoreInflation(args.profile, recentScores);
    if (inflationWarning !== undefined) {
      parts.push(inflationWarning);
    }
    return { output: parts.join(' ') };
  }
}


registerAgentToolService(ITeamScoreTool, TeamScoreTool, { name: 'TeamScore', domain: 'team' });
