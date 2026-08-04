/**
 * `tools` domain (L7) — `ITeamFireTool` implementation (the `TeamFire` tool).
 *
 * Fronts `IAgentProfileFileService`: candidate-path resolution, deletion, and
 * the available-profile listing all live in the service — this tool only
 * applies the main-agent gate and maps the result to a tool message. The
 * not-found case keeps its existing error semantics (lists available profiles).
 */

import { ILogService } from '#/_base/log/log';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  AgentProfileFileError,
  IAgentProfileFileService,
} from '#/workspace/agentProfileFile/agentProfileFile';
import '#/workspace/agentProfileFile/agentProfileFileService'; // registers the workspace-scoped service

import { ITeamFireTool, TeamFireInputSchema, TEAM_FIRE_DESCRIPTION, type TeamFireInput } from './team-fire';

export class TeamFireTool implements ITeamFireTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamFire';
  readonly description = TEAM_FIRE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamFireInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ILogService private readonly log: ILogService,
    @IAgentProfileFileService private readonly profileFile: IAgentProfileFileService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  async resolveExecution(args: TeamFireInput): Promise<ToolExecution> {
    // ── Gate: only the main agent may use this tool (check the caller's own
    // meta — not whether any subagent exists in the session).
    const meta = await this.sessionMetadata.read();
    if (isSubagentMeta(meta.agents?.[this.callerAgentId])) {
      return { isError: true, output: 'TeamFire is only available to the main agent.' };
    }

    const filePaths = this.profileFile.resolveCandidatePaths(args.name, args.scope ?? 'user');
    return {
      accesses: filePaths.flatMap((p) => ToolAccesses.writeFile(p)),
      display: { kind: 'generic', summary: `fire "${args.name}"` },
      description: `Fire agent "${args.name}"`,
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: TeamFireInput): Promise<ExecutableToolResult> {
    try {
      const result = await this.profileFile.remove(args.name, args.scope ?? 'user');
      if (result.removed === true) {
        return { output: `Fired "${args.name}".\nThe agent profile ${result.path} has been deleted and is no longer available for dispatch.` };
      }
    } catch (error) {
      if (error instanceof AgentProfileFileError) {
        return { isError: true, output: error.message };
      }
      throw error;
    }

    const names = (await this.profileFile.list()).join(', ') || '(none)';
    return {
      isError: true,
      output: `Agent "${args.name}" not found in any agents directory.\nAvailable profiles: ${names}`,
    };
  }
}

registerAgentToolService(ITeamFireTool, TeamFireTool, { name: 'TeamFire', domain: 'team' });
