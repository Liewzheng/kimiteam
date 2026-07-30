/**
 * `tools` domain (L7) — `ITeamFireTool` contract.
 *
 * Public contract of the `TeamFire` tool: the model-facing input schema and
 * the `ITeamFireTool` DI decorator that the implementation registers against via
 * `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export interface TeamFireInput {
  /** Agent name to fire — resolved against the same kebab-case convention. */
  name: string;
  /** Which scope(s) to search — order determines which directory is checked first when both are not specified. */
  scope?: 'user' | 'project';
}

export const TeamFireInputSchema: z.ZodType<TeamFireInput> = z.object({
  name: z
    .string()
    .min(1, 'name is required')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'name must be kebab-case (lowercase letters, digits, hyphens)')
    .describe('Agent name to fire — must match a profile in the catalog. E.g. "code-reviewer".'),
  scope: z
    .enum(['user', 'project'])
    .optional()
    .describe(
      'Scope override — "user" searches ~/.kimi-code/agents/, "project" searches <cwd>/.agents/. When omitted both directories are consulted (user scope is checked first). This only affects file deletion; it does not prevent the other scope from being searched.',
    ),
});

/** Static description for the tool. */
export const TEAM_FIRE_DESCRIPTION = `Fire (remove) an agent profile by name so it can no longer be dispatched. If the named agent doesn't exist, you are shown all currently available profiles for reference.`;

export interface ITeamFireTool extends AgentTool<TeamFireInput> {
  readonly _serviceBrand: undefined;
}

export const ITeamFireTool = createDecorator<ITeamFireTool>('teamFireTool');
