/**
 * `team-message` tool domain (L7) — `ITeamMessageTool` implementation.
 *
 * Delivers a user-role ContextMessage to a live agent in the session — the
 * main agent's channel for reminding or correcting an in-flight subagent.
 * Default mode steers the message into the target's active turn (or launches
 * a fresh turn when idle), mirroring the cron fire path; `interrupt: true`
 * cancels the target's current turn first (the double-ESC semantics: stop
 * current output, re-read the new input). Fire-and-forget — the target's
 * replies flow back through the normal task result/notification channels.
 * Management tool: rejected when invoked by a subagent. Bound at Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ILogService } from '#/_base/log/log';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { AgentMessageOrigin, ContextMessage } from '#/agent/contextMemory/types';

import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import {
  ITeamMessageTool,
  TeamMessageInputSchema,
  SUBAGENT_NOT_ALLOWED_MSG,
  type TeamMessageInput,
} from './team-message';

const TOOL_DESCRIPTION =
  'Send a message to an in-flight subagent — the reminder/correction channel of the three supervision rights: ' +
  'check progress with TaskList/TaskOutput, interrupt or dismiss with TaskStop, remind or correct with TeamMessage. ' +
  'By default the message steers into the target\'s active turn without breaking its flow; ' +
  '`interrupt: true` cancels the target\'s current turn first (like double-ESC in the TUI: stop output, re-read the new input). ' +
  'Fire-and-forget: the subagent\'s replies come back through its task result. ' +
  'When a target drifts, correct it immediately — do not wait for the final result.';

export class TeamMessageTool implements ITeamMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamMessage';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamMessageInputSchema);
  private readonly callerAgentId: string;

  constructor(
    @ISessionMetadata private readonly sessionMeta: ISessionMetadata,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ILogService private readonly log: ILogService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    return TOOL_DESCRIPTION;
  }

  async resolveExecution(args: TeamMessageInput): Promise<ToolExecution> {
    if (await this.isCallerSubagent()) {
      return { output: SUBAGENT_NOT_ALLOWED_MSG, isError: true };
    }

    return {
      description: `${args.interrupt === true ? '[interrupt] ' : ''}message to ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      display: { kind: 'generic', summary: `→ ${args.agent_id}` },
      approvalRule: this.name,
      execute: () => this.deliver(args),
    };
  }

  private async isCallerSubagent(): Promise<boolean> {
    const meta = (await this.sessionMeta.read()).agents?.[this.callerAgentId];
    return isSubagentMeta(meta);
  }

  private async deliver(args: TeamMessageInput): Promise<ExecutableToolResult> {
    const handle = this.lifecycle.get(args.agent_id);
    if (!handle) {
      const ids = this.lifecycle.list().map((h) => h.id).sort();
      const listing =
        ids.length === 0
          ? 'No agents are alive in this session yet.'
          : `Live agent ids:\n${ids.map((id) => `  - ${id}`).join('\n')}`;
      return {
        output:
          `Agent "${args.agent_id}" is not currently live. ${listing}\n` +
          'If the target has already finished, append instructions with the Agent tool\'s `resume` instead.',
        isError: true,
      };
    }

    const loop = handle.accessor.get(IAgentLoopService);
    const promptService = handle.accessor.get(IAgentPromptService);
    const wasRunning = loop.status().state === 'running';

    let interrupted = false;
    if (args.interrupt === true) {
      try {
        interrupted = loop.cancel(undefined, { kind: 'team_message_interrupt', from: this.callerAgentId });
      } catch (error) {
        // Best-effort interrupt: a failed cancel must not block delivery.
        this.log.warn(`[TeamMessage] cancel(target=${args.agent_id}) failed:`, error);
      }
    }

    const origin: AgentMessageOrigin = { kind: 'agent_message', agentId: this.callerAgentId };
    const message: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: args.message }],
      toolCalls: [],
      origin,
    };

    let launchedNewTurn = false;
    try {
      const turn = await promptService.inject(message);
      launchedNewTurn = turn !== undefined && !wasRunning;
    } catch (error) {
      this.log.warn(`[TeamMessage] inject(target=${args.agent_id}) failed:`, error);
      return {
        output:
          `[TeamMessage] Delivery to "${args.agent_id}" failed — the agent may have terminated unexpectedly.\n` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    const mode = interrupted
      ? 'turn cancelled; target restarts with this instruction'
      : wasRunning
        ? 'steered into the running turn'
        : launchedNewTurn
          ? 'launched a fresh turn'
          : 'queued';
    return {
      output: `[TeamMessage] Delivered to "${args.agent_id}" (${mode}). Fire-and-forget — its reply arrives via the task result.`,
    };
  }
}

registerAgentToolService(ITeamMessageTool, TeamMessageTool, { name: 'TeamMessage', domain: 'team' });
