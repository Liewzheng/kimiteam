/**
 * `tools` domain (L7) — `ITeamHireTool` implementation (the `TeamHire` tool).
 *
 * Fronts `IAgentProfileFileService`: name validation, path resolution,
 * frontmatter rendering, and the atomic write all live in the service — this
 * tool only applies the main-agent gate and maps the result to a tool message.
 * After writing, the watcher on `IUserFileAgentSource` fires which the session
 * catalog consumes so the new profile may be dispatched in the current
 * session.
 *
 * Registered via `registerAgentToolService(ITeamHireTool, TeamHireTool)` at the
 * module's bottom — same "import = register" pattern used by every agent tool.
 */

import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ILogService } from '#/_base/log/log';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  AgentProfileFileError,
  IAgentProfileFileService,
} from '#/workspace/agentProfileFile/agentProfileFile';
import '#/workspace/agentProfileFile/agentProfileFileService'; // registers the workspace-scoped service

import { ITeamHireTool, TEAM_HIRE_DESCRIPTION, TeamHireInputSchema, type TeamHireInput } from './team-hire';

export class TeamHireTool implements ITeamHireTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamHire';
  readonly description = TEAM_HIRE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamHireInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionAgentProfileCatalog private readonly _catalog: ISessionAgentProfileCatalog,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ILogService private readonly log: ILogService,
    @IAgentProfileFileService private readonly profileFile: IAgentProfileFileService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  async resolveExecution(args: TeamHireInput): Promise<ToolExecution> {
    // ── Gate: only the main agent may use this tool (check the caller's own
    // meta — not whether any subagent exists in the session).
    const meta = await this.sessionMetadata.read();
    if (isSubagentMeta(meta.agents?.[this.callerAgentId])) {
      return { isError: true, output: 'TeamHire is only available to the main agent.' };
    }

    return {
      accesses: ToolAccesses.writeFile(
        this.profileFile.resolveWritePath(args.name, args.scope ?? 'user'),
      ),
      display: { kind: 'generic', summary: `hire "${args.name}"` },
      description: `Hire agent "${args.name}"`,
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: TeamHireInput): Promise<ExecutableToolResult> {
    try {
      const result = await this.profileFile.create({
        name: args.name,
        description: args.description,
        prompt: args.prompt,
        role: args.role,
        whenToUse: args.when_to_use,
        modelPreference: args.model,
        tools: args.tools,
        disallowedTools: args.disallowed_tools,
        subagents: args.subagents,
        skills: args.skills,
        duty: args.duty,
        scope: args.scope ?? 'user',
      });
      // ── The watcher fires instantly; catalog reloads; profile is dispatchable this turn.
      return {
        output: `Hired "${args.name}" at ${result.path}.\nThe agent profile is now available in the current session and may be dispatched immediately via subagent_type.`,
      };
    } catch (error) {
      if (error instanceof AgentProfileFileError) {
        return { isError: true, output: error.message };
      }
      throw error;
    }
  }
}

registerAgentToolService(ITeamHireTool, TeamHireTool, { name: 'TeamHire', domain: 'team' });
