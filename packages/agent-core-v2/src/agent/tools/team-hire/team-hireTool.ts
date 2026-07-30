/**
 * `tools` domain (L7) — `ITeamHireTool` implementation (the `TeamHire` tool).
 *
 * Writes a single agent profile `<name>.md` into the user-level or project-level
 * agents root (`~/.kimi-code/agents/` or `<workDir>/.agents/` / `.kimi-code/agents/`).
 * The input validation enforces kebab-case name, required description/prompt.
 * Caller gate: only available to the main agent (not a subagent).
 * After writing, the watcher on `IUserFileAgentSource` fires which the session
 * catalog consumes so the new profile may be dispatched in the current session.
 *
 * Registered via `registerAgentToolService(ITeamHireTool, TeamHireTool)` at the
 * module's bottom — same "import = register" pattern used by every agent tool.
 */

import { dirname, join } from 'pathe';
import fs from 'node:fs';

import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ILogService } from '#/_base/log/log';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import { ITeamHireTool, TEAM_HIRE_DESCRIPTION, TeamHireInputSchema, type TeamHireInput } from './team-hire';

// kebab-case name validation — mirrored from agentFile.ts so we stay in sync.
const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------
// Frontmatter serialiser (simple, YAML-parseable by js-yaml).
// Scalar values are single-quoted when they contain yaml-special chars;
// array/list fields use proper YAML list syntax.
// ---------------------------------------------------------------------

/** Escape a scalar for single-quoting in YAML (single-quote delims double up). */
function quoteScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Serialize an array field to YAML list lines (no leading key prefix). */
function serializeList(items: readonly string[]): string {
  return items.map((i) => `  - ${quoteScalar(i)}`).join('\n');
}

/** Full frontmatter block for an agent file. */
function renderFrontmatter(input: TeamHireInput): string {
  const fields: string[] = [];

  // Always present
  fields.push(`name: ${input.name}`);
  fields.push(`description: ${quoteScalar(input.description)}`);

  // Optional scalars
  if (input.when_to_use !== undefined) {
    fields.push(`whenToUse: ${quoteScalar(input.when_to_use)}`);
  }
  if (input.role !== undefined) {
    fields.push(`role: ${quoteScalar(input.role)}`);
  }
  if (input.model !== undefined) {
    fields.push(`model_preference: ${quoteScalar(input.model)}`);
  }
  if (input.duty !== undefined) {
    fields.push(`duty: ${input.duty}`);
  }

  // Optional list fields — YAML list form always used for reliability.
  if (input.tools !== undefined && input.tools.length > 0) {
    fields.push('tools:\n' + serializeList(input.tools));
  }
  if (input.disallowed_tools !== undefined && input.disallowed_tools.length > 0) {
    fields.push('disallowedTools:\n' + serializeList(input.disallowed_tools));
  }
  if (input.subagents !== undefined && input.subagents.length > 0) {
    fields.push('subagents:\n' + serializeList(input.subagents));
  }

  return ['---', ...fields, '---'].join('\n');
}

// ------------------------------------------------------------------
// TeamHireTool
// ------------------------------------------------------------------

export class TeamHireTool implements ITeamHireTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamHire';
  readonly description = TEAM_HIRE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamHireInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionAgentProfileCatalog private readonly _catalog: ISessionAgentProfileCatalog,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ILogService private readonly log: ILogService,
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
      accesses: ToolAccesses.writeFile(this.targetFilePath(args)),
      display: { kind: 'generic', summary: `hire "${args.name}"` },
      description: `Hire agent "${args.name}"`,
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private targetFilePath(args: TeamHireInput): string {
    const scope = args.scope ?? 'user';
    return scope === 'user'
      ? join(this.bootstrap.homeDir, 'agents', `${args.name}.md`)
      : join(this.bootstrap.cwd, '.kimi-code', 'agents', `${args.name}.md`);
  }

  private async execution(args: TeamHireInput): Promise<ExecutableToolResult> {
    // ── Validate name against the same kebab-case constraint used by the parser.
    if (!AGENT_NAME_PATTERN.test(args.name)) {
      return {
        isError: true,
        output: `Invalid agent name "${args.name}": must be kebab-case (e.g. "code-reviewer") — lowercase letters, digits and hyphens only; no underscores or capitals`,
      };
    }

    // ── Resolve target scope path.
    const filePath = this.targetFilePath(args);

    // ── Check for existing file (don't overwrite).
    if (fs.existsSync(filePath)) {
      return {
        isError: true,
        output: `Agent "${args.name}" already exists at ${filePath} — cannot overwrite. Fire it first with TeamFire before re-hiring.`,
      };
    }

    // ── Ensure directory exists (mkdir -p semantics).
    const targetDir = dirname(filePath);
    if (!fs.existsSync(targetDir)) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (e) {
        return { isError: true, output: `Failed to create directory ${targetDir}: ${(unwrapErrorCause(e) as Error).message}` };
      }
    }

    // ── Render frontmatter + body.
    const content = renderFrontmatter(args) + '\n\n' + args.prompt;

    // ── Write file (writeFileSync ensures atomicity at the OS level on POSIX).
    try {
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (e) {
      return { isError: true, output: `Failed to write ${filePath}: ${(unwrapErrorCause(e) as Error).message}` };
    }

    // ── The watcher fires instantly; catalog reloads; profile is dispatchable this turn.
    return {
      output: `Hired "${args.name}" at ${filePath}.\nThe agent profile is now available in the current session and may be dispatched immediately via subagent_type.`,
    };
  }
}

registerAgentToolService(ITeamHireTool, TeamHireTool, { name: 'TeamHire', domain: 'team' });
