/**
 * `agentProfileFile` domain (workspace scope) — injectable agent-profile file
 * engine.
 *
 * The single write/delete/update channel for agent profile `<name>.md` files
 * (`~/.kimi-code/agents/`, `<cwd>/.kimi-code/agents/`, plus the legacy
 * `.agents/agents` fallbacks). Both the `TeamHire` / `TeamFire` tools and the
 * Web management tier go through this instead of inlining `node:fs` calls.
 * The existing file watcher (`IUserAgentProfileLoader`) picks up writes, so
 * no manual catalog reload is needed after `create` / `remove` / `update`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type AgentProfileScope = 'user' | 'project';

/** Fields accepted by `create` — mirror of the agent-file frontmatter keys. */
export interface AgentProfileCreateInput {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly role?: string;
  readonly whenToUse?: string;
  readonly modelPreference?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly skills?: readonly string[];
  readonly duty?: boolean;
  readonly scope?: AgentProfileScope;
}

/**
 * Field-level patch for `update`. Only own keys present on the patch object
 * are applied; a key mapped to `undefined` removes it from the frontmatter.
 * `prompt` is the exception — it replaces the file body (the Markdown after
 * the frontmatter block), not a frontmatter key.
 */
export interface AgentProfileFilePatch {
  readonly description?: string;
  readonly role?: string;
  readonly whenToUse?: string;
  readonly modelPreference?: string;
  readonly tools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly subagents?: readonly string[] | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly duty?: boolean | undefined;
  readonly prompt?: string;
}

export interface AgentProfileFileResult {
  readonly name: string;
  readonly scope: AgentProfileScope;
  /** The resolved path that was (or would be) operated on. */
  readonly path: string;
  readonly created?: boolean;
  readonly removed?: boolean;
  readonly updated?: boolean;
}

export type AgentProfileFileErrorCode = 'invalid_name' | 'already_exists' | 'not_found' | 'io';

/** Domain error carrying a stable code so callers can branch on the failure. */
export class AgentProfileFileError extends Error {
  readonly code: AgentProfileFileErrorCode;
  readonly path?: string;

  constructor(code: AgentProfileFileErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'AgentProfileFileError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export interface IAgentProfileFileService {
  readonly _serviceBrand: undefined;

  /**
   * Render and write a new `<name>.md` agent profile. Validates the kebab-case
   * name and refuses to overwrite an existing file. The write is atomic
   * (`createExclusive`) — a concurrent create for the same name cannot
   * double-write.
   *
   * Throws `AgentProfileFileError` on invalid name, existing file, or IO
   * failure; resolves with the written path on success.
   */
  create(input: AgentProfileCreateInput): Promise<AgentProfileFileResult>;

  /**
   * Delete the first existing candidate file for the profile. Mirrors the
   * TeamFire semantics: resolves with `removed: false` (no throw) when no file
   * exists.
   */
  remove(name: string, scope?: AgentProfileScope): Promise<AgentProfileFileResult>;

  /**
   * Patch frontmatter fields of an existing profile file, replacing the body
   * when `patch.prompt` is set. Throws `not_found` when the file does not
   * exist at the scope's primary path.
   */
  update(
    name: string,
    scope: AgentProfileScope | undefined,
    patch: AgentProfileFilePatch,
  ): Promise<AgentProfileFileResult>;

  /** Agent profile names found across the known agent directories (deduped, sorted). */
  list(scope?: AgentProfileScope): Promise<string[]>;

  /** The single write path a hire targets (sync — used for approval accesses). */
  resolveWritePath(name: string, scope?: AgentProfileScope): string;

  /** The candidate paths a fire may delete, first match wins (sync — approval accesses). */
  resolveCandidatePaths(name: string, scope?: AgentProfileScope): string[];
}

export const IAgentProfileFileService: ServiceIdentifier<IAgentProfileFileService> =
  createDecorator<IAgentProfileFileService>('agentProfileFileService');
