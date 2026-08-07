/**
 * `workspaceAgentProfileLoader` domain — agent-file model types.
 *
 * Shared types for the agent-file primitives: the parsed single-file
 * definition (`AgentFileDefinition`), scan roots (`AgentFileRoot`) tagged with
 * their source, and the discovery result carrying per-file skip diagnostics.
 * Pure data; no scoped state.
 */

import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';

export type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';

export type AgentFileSource = 'plugin' | 'project' | 'user' | 'extra' | 'explicit';

export interface AgentFileRoot {
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface AgentFileDefinition {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly override: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  /** Skill-name allowlist (`undefined` = every skill active, lone `*` = unrestricted). */
  readonly skills?: readonly string[];
  readonly modelPreference?: AgentModelPreference;
  /** Short job title shown in tool listings and the TUI subagent card. */
  readonly role?: string;
  /** On-duty member: its subagent runs are exempt from the subagent timeout. */
  readonly duty?: boolean;
  /** Display (e.g. Chinese) name shown on the Web team card; defaults to `name`. */
  readonly displayName?: string;
  /** Per-profile thinking effort (`think_mode` frontmatter), e.g. 'off'/'low'/'high'. */
  readonly thinkMode?: string;
  /** Per-profile sampling temperature (`temperature` frontmatter), e.g. 0.3. */
  readonly temperature?: number;
  readonly prompt: string;
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface AgentFileDiscoveryResult {
  readonly agents: readonly AgentFileDefinition[];
  readonly skipped: readonly SkippedAgentFile[];
  readonly scannedRoots: readonly string[];
}
