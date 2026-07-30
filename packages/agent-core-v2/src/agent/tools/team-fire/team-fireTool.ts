/**
 * `tools` domain (L7) — `ITeamFireTool` implementation (the `TeamFire` tool).
 */

import { join } from 'pathe';
import fs from 'node:fs';

import { ILogService } from '#/_base/log/log';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import { ITeamFireTool, TeamFireInputSchema, TEAM_FIRE_DESCRIPTION, type TeamFireInput } from './team-fire';

/** Candidate profile file paths for the requested scope, first match wins. */
function candidateFilePaths(bootstrap: IBootstrapService, name: string, scope: 'user' | 'project'): string[] {
  if (scope === 'user') {
    return [
      join(bootstrap.homeDir, 'agents', `${name}.md`),
      join(bootstrap.osHomeDir, '.kimi-code/agents', `${name}.md`),
    ];
  }
  return [
    join(bootstrap.cwd, '.kimi-code/agents', `${name}.md`),
    join(bootstrap.cwd, '.agents/agents', `${name}.md`),
  ];
}

/** Scan known agent directories and return the set of discovered profile names. */
function scanAvailableProfileNames(bootstrap: IBootstrapService): Set<string> {
  const candidates = [
    join(bootstrap.homeDir, 'agents'),
    join(bootstrap.osHomeDir, '.kimi-code/agents'),
    join(bootstrap.cwd, '.kimi-code/agents'),
    join(bootstrap.cwd, '.agents/agents'),
  ];
  const names = new Set<string>();
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (/\.md$/.test(entry)) names.add(entry.slice(0, -3));
      }
    } catch { /* directory inaccessible */ }
  }
  return names;
}

export class TeamFireTool implements ITeamFireTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamFire';
  readonly description = TEAM_FIRE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamFireInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ILogService private readonly log: ILogService,
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

    const filePaths = candidateFilePaths(this.bootstrap, args.name, args.scope ?? 'user');
    return {
      accesses: filePaths.flatMap((p) => ToolAccesses.writeFile(p)),
      display: { kind: 'generic', summary: `fire "${args.name}"` },
      description: `Fire agent "${args.name}"`,
      approvalRule: this.name,
      execute: () => this.execution(args, filePaths),
    };
  }

  private async execution(args: TeamFireInput, filePaths: string[]): Promise<ExecutableToolResult> {
    let deletedPath: string | undefined;
    for (const p of filePaths) {
      if (!fs.existsSync(p)) continue;
      try {
        fs.unlinkSync(p);
        deletedPath = p;
        break;
      } catch (e) {
        return { isError: true, output: `Failed to delete ${p}: ${(unwrapErrorCause(e) as Error).message}` };
      }
    }

    if (deletedPath !== undefined) {
      return { output: `Fired "${args.name}".\nThe agent profile ${deletedPath} has been deleted and is no longer available for dispatch.` };
    }

    const allProfiles = scanAvailableProfileNames(this.bootstrap);
    const names = [...allProfiles].sort().join(', ') || '(none)';
    return {
      isError: true,
      output: `Agent "${args.name}" not found in any agents directory.\nAvailable profiles: ${names}`,
    };
  }
}

registerAgentToolService(ITeamFireTool, TeamFireTool, { name: 'TeamFire', domain: 'team' });
