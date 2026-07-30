/**
 * `team-score` tool domain (L7) — contract + input schema.
 *
 * Lets the main agent give performance scores to subagent profiles.
 * Registered via `registerAgentToolService` at module load in teamScoreTool.ts.
 * Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const TeamScoreToolInputSchema = z.object({
  profile: z.string().trim().min(1).describe('Subagent profile name to score'),
  score: z.number().int().min(0).max(100).describe('Performance score, 0–100 integer'),
  note: z.string().trim().min(1).describe('One-line comment explaining the score'),
  agent_id: z.string().optional().describe('Optional subagent instance ID this score is for'),
  model: z.string().optional().describe('The model id the member was using when scored; omit and the caller should backfill with the current binding'),
});

export type TeamScoreToolInput = z.infer<typeof TeamScoreToolInputSchema>;

/** Error returned when a subagent tries to call this tool. */
export const SUBAGENT_NOT_ALLOWED = 'TeamScore is only available to the main agent';

export interface ITeamScoreTool extends AgentTool<TeamScoreToolInput> {
  readonly _serviceBrand: undefined;
}

export const ITeamScoreTool = createDecorator<ITeamScoreTool>('teamScore');
