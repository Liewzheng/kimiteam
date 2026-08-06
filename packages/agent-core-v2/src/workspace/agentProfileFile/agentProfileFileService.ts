/**
 * `agentProfileFile` domain (workspace scope) — `IAgentProfileFileService`
 * implementation.
 *
 * Owns the write/delete/update of agent profile `<name>.md` files through
 * `IHostFileSystem`, scoped by `IBootstrapService` paths. The frontmatter
 * renderer lives here (moved out of the TeamHire tool) so the engine, the
 * tools, and the Web management tier share one serializer. Registration
 * mirrors the workspace-scoped `IUserAgentProfileLoader`.
 */

import { dirname, join } from 'pathe';
import { dump as dumpYaml } from 'js-yaml';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { parseFrontmatter } from '#/_base/text/frontmatter';

import {
  AgentProfileFileError,
  IAgentProfileFileService,
  type AgentProfileCreateInput,
  type AgentProfileFilePatch,
  type AgentProfileFileResult,
  type AgentProfileScope,
} from './agentProfileFile';

/** kebab-case name pattern shared with the agent-file parser (kept in sync). */
export const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type BootstrapPaths = Pick<IBootstrapService, 'homeDir' | 'osHomeDir' | 'cwd'>;

/** The primary agents directory for a scope (where `create` writes). */
export function agentProfileDir(bootstrap: BootstrapPaths, scope: AgentProfileScope): string {
  return scope === 'user'
    ? join(bootstrap.homeDir, 'agents')
    : join(bootstrap.cwd, '.kimi-code', 'agents');
}

/** The single write path a hire targets. */
export function agentProfileFilePath(
  bootstrap: BootstrapPaths,
  name: string,
  scope: AgentProfileScope,
): string {
  return join(agentProfileDir(bootstrap, scope), `${name}.md`);
}

/** Candidate paths a fire may delete, first match wins (mirrors TeamFire). */
export function agentProfileCandidatePaths(
  bootstrap: BootstrapPaths,
  name: string,
  scope: AgentProfileScope,
): string[] {
  if (scope === 'user') {
    return [
      join(bootstrap.homeDir, 'agents', `${name}.md`),
      join(bootstrap.osHomeDir, '.kimi-code', 'agents', `${name}.md`),
    ];
  }
  return [
    join(bootstrap.cwd, '.kimi-code', 'agents', `${name}.md`),
    join(bootstrap.cwd, '.agents', 'agents', `${name}.md`),
  ];
}

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
export function renderFrontmatter(input: AgentProfileCreateInput): string {
  const fields: string[] = [];

  // Always present
  fields.push(`name: ${input.name}`);
  fields.push(`description: ${quoteScalar(input.description)}`);

  // Optional scalars
  if (input.whenToUse !== undefined) {
    fields.push(`whenToUse: ${quoteScalar(input.whenToUse)}`);
  }
  if (input.role !== undefined) {
    fields.push(`role: ${quoteScalar(input.role)}`);
  }
  if (input.modelPreference !== undefined) {
    fields.push(`model_preference: ${quoteScalar(input.modelPreference)}`);
  }
  if (input.duty !== undefined) {
    fields.push(`duty: ${input.duty}`);
  }

  // Optional list fields — YAML list form always used for reliability.
  if (input.tools !== undefined && input.tools.length > 0) {
    fields.push('tools:\n' + serializeList(input.tools));
  }
  if (input.disallowedTools !== undefined && input.disallowedTools.length > 0) {
    fields.push('disallowedTools:\n' + serializeList(input.disallowedTools));
  }
  if (input.subagents !== undefined && input.subagents.length > 0) {
    fields.push('subagents:\n' + serializeList(input.subagents));
  }
  if (input.skills !== undefined && input.skills.length > 0) {
    fields.push('skills:\n' + serializeList(input.skills));
  }

  return ['---', ...fields, '---'].join('\n');
}

/** Frontmatter key each patch field maps to (`prompt` is the body, not a key). */
const PATCH_KEY_TO_FRONTMATTER: Record<
  Exclude<keyof AgentProfileFilePatch, 'prompt'>,
  string
> = {
  description: 'description',
  role: 'role',
  whenToUse: 'whenToUse',
  modelPreference: 'model_preference',
  tools: 'tools',
  disallowedTools: 'disallowedTools',
  subagents: 'subagents',
  skills: 'skills',
  duty: 'duty',
};

export class AgentProfileFileService implements IAgentProfileFileService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  async create(input: AgentProfileCreateInput): Promise<AgentProfileFileResult> {
    const scope = input.scope ?? 'user';
    if (!AGENT_NAME_PATTERN.test(input.name)) {
      throw new AgentProfileFileError(
        'invalid_name',
        `Invalid agent name "${input.name}": must be kebab-case (e.g. "code-reviewer") — lowercase letters, digits and hyphens only; no underscores or capitals`,
      );
    }

    const filePath = agentProfileFilePath(this.bootstrap, input.name, scope);
    const targetDir = dirname(filePath);

    try {
      await this.fs.mkdir(targetDir, { recursive: true });
    } catch (error) {
      throw new AgentProfileFileError(
        'io',
        `Failed to create directory ${targetDir}: ${errorMessage(error)}`,
        targetDir,
      );
    }

    const content = renderFrontmatter(input) + '\n\n' + input.prompt;
    let created: boolean;
    try {
      created = await this.fs.createExclusive(filePath, new TextEncoder().encode(content));
    } catch (error) {
      throw new AgentProfileFileError(
        'io',
        `Failed to write ${filePath}: ${errorMessage(error)}`,
        filePath,
      );
    }
    if (!created) {
      throw new AgentProfileFileError(
        'already_exists',
        `Agent "${input.name}" already exists at ${filePath} — cannot overwrite. Fire it first with TeamFire before re-hiring.`,
        filePath,
      );
    }

    return { name: input.name, scope, path: filePath, created: true };
  }

  async remove(name: string, scope?: AgentProfileScope): Promise<AgentProfileFileResult> {
    const resolvedScope = scope ?? 'user';
    for (const candidate of agentProfileCandidatePaths(this.bootstrap, name, resolvedScope)) {
      if (await this.exists(candidate)) {
        try {
          await this.fs.remove(candidate);
        } catch (error) {
          throw new AgentProfileFileError(
            'io',
            `Failed to delete ${candidate}: ${errorMessage(error)}`,
            candidate,
          );
        }
        return { name, scope: resolvedScope, path: candidate, removed: true };
      }
    }
    // Silent skip — nothing to delete (mirrors TeamFire's first-match scan).
    return {
      name,
      scope: resolvedScope,
      path: agentProfileFilePath(this.bootstrap, name, resolvedScope),
      removed: false,
    };
  }

  async update(
    name: string,
    scope: AgentProfileScope | undefined,
    patch: AgentProfileFilePatch,
  ): Promise<AgentProfileFileResult> {
    const resolvedScope = scope ?? 'user';
    const filePath = agentProfileFilePath(this.bootstrap, name, resolvedScope);
    let text: string;
    try {
      text = await this.fs.readText(filePath);
    } catch {
      throw new AgentProfileFileError(
        'not_found',
        `Agent profile "${name}" not found at ${filePath}`,
        filePath,
      );
    }

    const parsed = parseFrontmatter(text);
    if (parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      throw new AgentProfileFileError(
        'io',
        `Agent profile "${name}" has no frontmatter to update at ${filePath}`,
        filePath,
      );
    }
    const data = parsed.data as Record<string, unknown>;
    const { prompt, ...frontmatterPatch } = patch;
    for (
      const key of Object.keys(frontmatterPatch) as Array<
        Exclude<keyof AgentProfileFilePatch, 'prompt'>
      >
    ) {
      const value = frontmatterPatch[key];
      const frontmatterKey = PATCH_KEY_TO_FRONTMATTER[key];
      if (value === undefined) {
        delete data[frontmatterKey];
      } else {
        data[frontmatterKey] = value;
      }
    }

    const body =
      prompt !== undefined ? prompt : parsed.body.replace(/^\n+/, '');
    const content = `---\n${dumpYaml(data)}\n---\n\n${body}`;
    try {
      await this.fs.writeText(filePath, content);
    } catch (error) {
      throw new AgentProfileFileError(
        'io',
        `Failed to write ${filePath}: ${errorMessage(error)}`,
        filePath,
      );
    }
    return { name, scope: resolvedScope, path: filePath, updated: true };
  }

  async list(scope?: AgentProfileScope): Promise<string[]> {
    const dirs =
      scope === undefined
        ? [
            join(this.bootstrap.homeDir, 'agents'),
            join(this.bootstrap.osHomeDir, '.kimi-code', 'agents'),
            join(this.bootstrap.cwd, '.kimi-code', 'agents'),
            join(this.bootstrap.cwd, '.agents', 'agents'),
          ]
        : scope === 'user'
          ? [
              join(this.bootstrap.homeDir, 'agents'),
              join(this.bootstrap.osHomeDir, '.kimi-code', 'agents'),
            ]
          : [
              join(this.bootstrap.cwd, '.kimi-code', 'agents'),
              join(this.bootstrap.cwd, '.agents', 'agents'),
            ];
    const names = new Set<string>();
    for (const dir of dirs) {
      try {
        const entries = await this.fs.readdir(dir);
        for (const entry of entries) {
          if (entry.isFile && /\.md$/.test(entry.name)) names.add(entry.name.slice(0, -3));
        }
      } catch {
        // directory inaccessible — skip
      }
    }
    return [...names].sort();
  }

  resolveWritePath(name: string, scope?: AgentProfileScope): string {
    return agentProfileFilePath(this.bootstrap, name, scope ?? 'user');
  }

  resolveCandidatePaths(name: string, scope?: AgentProfileScope): string[] {
    return agentProfileCandidatePaths(this.bootstrap, name, scope ?? 'user');
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Workspace,
  IAgentProfileFileService,
  AgentProfileFileService,
  ScopeActivation.OnScopeCreated,
  'agentProfileFile',
);
