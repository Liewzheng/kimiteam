/**
 * `tools` domain (L7) — `ITeamHireTool` contract.
 *
 * Public contract of the `TeamHire` tool: the model-facing input schema that
 * validates and normalises user-supplied agent profile fields, plus the
 * `ITeamHireTool` DI decorator that the implementation registers against via
 * `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

/** kebab-case pattern borrowed from agentFile.ts so both sides agree on valid names. */
export const TEAM_HIRE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TeamHireInput {
  /** Agent name (kebab-case, used as the filename `name.md`). */
  name: string;
  /** Short job title / role tag. */
  role?: string;
  /** What this agent does — rendered into frontmatter + tool description. */
  description: string;
  /** When to use it — rendered into frontmatter. */
  when_to_use?: string;
  /** System prompt body (the `---` fence separates it from frontmatter). */
  prompt: string;
  /** Model preference written to frontmatter key `model_preference`. */
  model?: string;
  /** Allowed tool names (YAML list) in the agent file. */
  tools?: string[];
  /** Excluded tool names (YAML list) in the agent file. */
  disallowed_tools?: string[];
  /** Allowed subagent types (YAML list) in the agent file. */
  subagents?: string[];
  /** Whether this is an on-duty member (`duty: true`). */
  duty?: boolean;
  /** Profile scope — user-level `~/.kimi-code/agents/` or project-level `<cwd>/.agents/`. */
  scope?: 'user' | 'project';
}

export const TeamHireInputSchema: z.ZodType<TeamHireInput> = z.object({
  name: z
    .string()
    .min(1, 'name is required')
    .regex(
      TEAM_HIRE_NAME_PATTERN,
      'name must be kebab-case (e.g. "code-reviewer"): lowercase letters, digits, hyphens only; no underscores or capitals',
    )
    .describe(
      'Agent name (kebab-case, used as the filename). E.g. "code-reviewer".',
    ),
  role: z
    .string()
    .min(1)
    .optional()
    .describe('Short job title / role tag shown in agent listings.'),
  description: z
    .string()
    .min(1, 'description is required')
    .describe('What this agent does — concise explanation of its capabilities.'),
  when_to_use: z
    .string()
    .min(1)
    .optional()
    .describe(
      'When to use this agent (context / trigger description). Written as frontmatter `whenToUse`.',
    ),
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .describe('System prompt body that defines the agent behaviour. Written after the `---` frontmatter fence.'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Model preference for this agent: one of "primary" / "secondary" or an explicit model id from config.toml (e.g. "provider/model"). Written as frontmatter `model_preference`.',
    ),
  tools: z
    .array(z.string())
    .min(1)
    .optional()
    .describe('Allowed tool names — rendered as a YAML list in the agent file.'),
  disallowed_tools: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      'Excluded tool names — rendered as a YAML list in the agent file. Written as frontmatter `disallowedTools`.',
    ),
  subagents: z
    .array(z.string())
    .min(1)
    .optional()
    .describe('Allowed subagent types for this agent (YAML list).'),
  duty: z.boolean().optional().describe('Whether this is an on-duty member (duty: true).'),
  scope: z
    .enum(['user', 'project'])
    .optional()
    .describe(
      'Profile scope — "user" writes to ~/.kimi-code/agents/, "project" writes to the project <cwd>/.agents/',
    ),
});

/** Static description carrying the autonomous team-building discipline. */
export const TEAM_HIRE_DESCRIPTION = `**Self-built team management tools** — When tasks require capabilities that don't exist in the current agent catalog, you should independently decide to hire new specialists without asking for item-by-item permission from the user.

- **Hire**: Provide name (kebab-case), role, description, prompt (system instruction), and optionally model/tools/subagents. The hired agent is immediately available for dispatch within this session.
  - Model options: 'primary', 'secondary', or any explicit [models] id like 'provider/model-name'. Fill these in based on your own judgment of what the task needs — you have full autonomy to author these details.
- **Fire**: Remove an existing agent's profile file so it can no longer be dispatched. If a named agent doesn't exist, you are shown all currently available agent profiles for reference.`;

export interface ITeamHireTool extends AgentTool<TeamHireInput> {
  readonly _serviceBrand: undefined;
}

export const ITeamHireTool = createDecorator<ITeamHireTool>('teamHireTool');
