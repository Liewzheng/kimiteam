/**
 * `team-score` tool domain (L7) — ITeamScoreTool implementation.
 *
 * Writes a score entry via IAgentPerformanceService and returns an updated
 * summary text. When invoked by a subagent, returns an error. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ILogService } from '#/_base/log/log';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ExecutableToolContext, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { IAgentPerformanceService, type PerformanceEntry } from '#/app/agentPerformance/agentPerformance';

import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ITeamScoreTool, TeamScoreToolInputSchema, SUBAGENT_NOT_ALLOWED, type TeamScoreToolInput } from './team-score';

const TOOL_DESCRIPTION =
  'Give a subagent member a performance score (0-100) with a one-line comment. Score history is used for dispatch decisions when the main agent needs to pick which subagent is most capable. ' +
  'Consistently low scores indicate the current model is not suitable for this member. ' +
  'To switch within the same cost tier (offline↔offline, online↔online), you may autonomously update [subagent.model_overrides] or adjust dispatch parameters. ' +
  'An offline→online upgrade incurs new costs and requires AskUserQuestion to the user first (attach the member\'s score history and time-on-task evidence). ' +
  'The [subagent] allow_cost_upgrade = true config key indicates the user has pre-authorized such upgrades.';

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

    return {
      description: `Score ${args.profile} with ${args.score}: ${args.note}`,
      accesses: ToolAccesses.none(),
      display: { kind: 'generic', summary: `${args.profile}: ${args.score}/100` },
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
    await this.perf.record({
      profileName: args.profile,
      ts: new Date().toISOString(),
      score: args.score,
      note: args.note,
      model: args.model,
      agentId: args.agent_id,
    });

    const sum = await this.perf.summary(args.profile);
    if (sum.count === 0) {
      return { output: `[TeamScore] Scored "${args.profile}" — \`${args.score}/100\`. No scores yet.` };
    }

    const parts: string[] = [`[TeamScore] Scored "${args.profile}" — \`${args.score}/100\`.`];
    if (sum.last !== undefined) {
      parts.push(`Last score: ${sum.last}.`);
    }
    if (sum.average !== undefined) {
      parts.push(`Average: ${sum.average} (${sum.count} total).`);
    }
    return { output: parts.join(' ') };
  }
}


registerAgentToolService(ITeamScoreTool, TeamScoreTool, { name: 'TeamScore', domain: 'team' });
