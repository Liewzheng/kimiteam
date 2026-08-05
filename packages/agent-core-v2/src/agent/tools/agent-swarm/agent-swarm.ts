/**
 * `tools` domain — `IAgentSwarmTool` contract (the `AgentSwarm` tool).
 *
 * Public contract of the `AgentSwarm` collaboration tool: the input zod
 * schema the model-facing parameters are derived from, the tool-owned
 * constants the schema is built around (prompt template placeholder, maximum
 * subagent count), and the `IAgentSwarmTool` DI decorator that the
 * implementation registers against via `registerAgentToolService`. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;
export const SWARM_BACKGROUND_UNAVAILABLE =
  'Background swarm execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    todo_id: z
      .string()
      .optional()
      .describe(
        'Required: the todo number (create or select one from /todo / TodoList before dispatching) this swarm hangs on. The engine rejects a dispatch without it, validates that it exists and is not done, and closes it with whatDone/assignee on completion.',
      ),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Which model to run the item-spawned subagents on: "secondary" = the configured secondary model; "primary" = the main model you are running on (for hard, quality-sensitive tasks); or any explicit [models] id from config.toml (e.g. "local/gemma4-26b") listed under "Available models" in this tool description. This explicit choice overrides the selected agent type\'s model_preference and any [subagent.model_overrides] entry; without either, secondary is the default when configured. Only effective when a secondary model is configured; otherwise subagents inherit your model. Resumed subagents always keep their own model.',
      ),
    item_models: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of item string to the model for that item-spawned subagent ("primary" / "secondary" / any [models] id). Every key must exactly match one of the items. Items not listed here use the model parameter / agent type preference / defaults.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for the swarm to finish: the whole batch is registered as one background task and its completion arrives via automatic notification in a later turn. When false (default), block until every subagent finishes and render the full result.',
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;


export interface IAgentSwarmTool extends AgentTool<AgentSwarmToolInput> { readonly _serviceBrand: undefined }
export const IAgentSwarmTool = createDecorator<IAgentSwarmTool>('agentSwarmTool');
