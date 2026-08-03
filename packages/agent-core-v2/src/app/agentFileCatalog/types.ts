/**
 * `agentFileCatalog` domain (L3) — agent-file model types.
 *
 * Shared types for the agent-file primitives: the parsed single-file
 * definition (`AgentFileDefinition`), scan roots (`AgentFileRoot`) tagged with
 * their source, and the discovery result carrying per-file skip diagnostics.
 * Pure data; no scoped state.
 */

import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';

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
  readonly prompt: string;
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface SkippedAgentFile {
  readonly path: string;
  readonly reason: string;
}

export interface AgentFileDiscoveryResult {
  readonly agents: readonly AgentFileDefinition[];
  readonly skipped: readonly SkippedAgentFile[];
  readonly scannedRoots: readonly string[];
}
