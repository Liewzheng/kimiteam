/**
 * `team-message` tool domain (L7) — contract + input schema.
 *
 * Lets the main agent deliver a soft-remind or interrupt/correct message to an
 * in-flight subagent.  Registered via `registerAgentToolService` at module load
 * in teamMessageTool.ts.  Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const TeamMessageInputSchema = z.object({
  agent_id: z.string().trim().min(1).describe('Target subagent instance id (from Agent/TaskOutput metadata)'),
  message: z.string().trim().min(1).max(8192).describe('User-role message to deliver; wrapped as a ContextMessage'),
  interrupt: z.boolean().optional().describe('If true, interrupt the target agent\'s current turn before injecting (like pressing ESC twice in TUI)'),
});

export type TeamMessageInput = z.infer<typeof TeamMessageInputSchema>;

/** Error returned when a subagent tries to call this tool. */
export const SUBAGENT_NOT_ALLOWED_CODE = 'TeamMessageSubagentGate';
export const SUBAGENT_NOT_ALLOWED_MSG = 'Management tools are only available to the main agent.';

/** Error returned when the target agent handle cannot be found. */
export const AGENT_UNAVAILABLE_CODE = 'TeamMessageAgentUnavailable';

export interface ITeamMessageTool extends AgentTool<TeamMessageInput> {
  readonly _serviceBrand: undefined;
}

export const ITeamMessageTool = createDecorator<ITeamMessageTool>('teamMessage');
