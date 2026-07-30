/**
 * `team-concurrency` tool domain (L7) — contract + input schema.
 *
 * Lets the main agent inspect, adjust, and evaluate subagent concurrency.
 * Registered via `registerAgentToolService` at module load in
 * teamConcurrencyTool.ts. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const TeamConcurrencyInputSchema = z.object({
  action: z.enum(['get', 'set', 'evaluate']).describe(
    'Action to perform: get = read current pool state; set = apply a runtime limit override; evaluate = report machine resources, model topology, and concurrency advice',
  ),
  value: z.number().int().min(1).optional().describe(
    'Concurrency limit for `set` action (required when action=set, ignored otherwise). Must be ≥ 1.',
  ),
});

export type TeamConcurrencyInput = z.infer<typeof TeamConcurrencyInputSchema>;

/** Error returned when a subagent tries to call this tool. */
export const SUBAGENT_NOT_ALLOWED_MSG = 'TeamConcurrency is only available to the main agent';

export interface ITeamConcurrencyTool extends AgentTool<TeamConcurrencyInput> {
  readonly _serviceBrand: undefined;
}

export const ITeamConcurrencyTool = createDecorator<ITeamConcurrencyTool>('teamConcurrency');
