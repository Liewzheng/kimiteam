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

export const TeamScoreToolInputSchema = z
  .object({
    profile: z.string().trim().min(1).describe('Subagent profile name to score'),
    action: z
      .enum(['record', 'penalty'])
      .optional()
      .describe(
        "'record' (default) appends a performance score; 'penalty' deducts points from the profile average by appending a negative entry (history untouched, audit preserved)",
      ),
    score: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Performance score, 0–100 integer (record action)'),
    note: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('One-line comment — record: explains the score; penalty: the reason'),
    points: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Points to deduct from the profile average (penalty action, 1–100)'),
    reason: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Why the member is being penalized (penalty action)'),
    agent_id: z.string().optional().describe('Optional subagent instance ID this entry is for'),
    model: z
      .string()
      .optional()
      .describe('The model id the member was using (required for penalty)'),
  })
  .superRefine((value, ctx) => {
    const isPenalty = value.action === 'penalty';
    if (isPenalty) {
      if (value.points === undefined) {
        ctx.addIssue({ code: 'custom', message: 'penalty requires points', path: ['points'] });
      }
      if (value.reason === undefined) {
        ctx.addIssue({ code: 'custom', message: 'penalty requires reason', path: ['reason'] });
      }
      if (value.model === undefined) {
        ctx.addIssue({ code: 'custom', message: 'penalty requires model', path: ['model'] });
      }
    } else {
      if (value.score === undefined) {
        ctx.addIssue({ code: 'custom', message: 'record requires score', path: ['score'] });
      }
      if (value.note === undefined) {
        ctx.addIssue({ code: 'custom', message: 'record requires note', path: ['note'] });
      }
    }
  });

export type TeamScoreToolInput = z.infer<typeof TeamScoreToolInputSchema>;

/** Error returned when a subagent tries to call this tool. */
export const SUBAGENT_NOT_ALLOWED = 'TeamScore is only available to the main agent';

export interface ITeamScoreTool extends AgentTool<TeamScoreToolInput> {
  readonly _serviceBrand: undefined;
}

export const ITeamScoreTool = createDecorator<ITeamScoreTool>('teamScore');
