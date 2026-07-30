/**
 * `team-message` tool — unit tests with stubbed collaborators.
 *
 * Covers the subagent gate, unknown-target error, soft delivery (steer via
 * `IAgentPromptService.inject`), interrupt delivery (`IAgentLoopService.cancel`
 * before inject), and inject failure. Run:
 * `npx vitest run test/agent/tools/team-message.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { TeamMessageTool } from '#/agent/tools/team-message/teamMessageTool';
import { SUBAGENT_NOT_ALLOWED_MSG } from '#/agent/tools/team-message/team-message';
import type { ExecutableToolResult, RunnableToolExecution } from '#/tool/toolContract';

function logStub(): unknown {
  const stub: Record<string, unknown> = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    setLevel: () => {},
    level: 'debug',
    flush: async () => {},
  };
  stub['child'] = () => stub;
  return stub;
}

const CTX = { signal: new AbortController().signal } as never;

interface BuildOptions {
  readonly callerMeta?: Record<string, unknown>;
  readonly running?: boolean;
  readonly known?: boolean;
  readonly injectError?: Error;
}

function buildTool(options: BuildOptions = {}) {
  const callerAgentId = 'main';
  const running = options.running !== false;
  const known = options.known !== false;

  const loop = {
    status: vi.fn(() => ({ state: running ? 'running' : 'idle' })),
    cancel: vi.fn(() => true),
  };
  const prompt = {
    inject: vi.fn(async (_message: unknown) => {
      if (options.injectError !== undefined) throw options.injectError;
      return {};
    }),
  };
  const handle = {
    id: 'agent-1',
    accessor: {
      get: (token: unknown) =>
        token === IAgentLoopService ? loop : token === IAgentPromptService ? prompt : undefined,
    },
  };
  const lifecycle = {
    get: vi.fn((id: string) => (known && id === 'agent-1' ? handle : undefined)),
    list: vi.fn(() => (known ? [handle] : [])),
  };
  const sessionMeta = {
    read: vi.fn(async () => ({ agents: { [callerAgentId]: options.callerMeta ?? {} } })),
  };

  const tool = new TeamMessageTool(
    sessionMeta as never,
    { agentId: callerAgentId } as never,
    lifecycle as never,
    logStub() as never,
  );
  return { tool, loop, prompt, lifecycle };
}

async function execute(
  resolution: Awaited<ReturnType<TeamMessageTool['resolveExecution']>>,
): Promise<ExecutableToolResult> {
  if ('execute' in resolution) {
    return (resolution as RunnableToolExecution).execute(CTX);
  }
  return resolution;
}

describe('TeamMessage', () => {
  it('rejects calls from a subagent (management tools are main-agent only)', async () => {
    const { tool, prompt } = buildTool({ callerMeta: { type: 'sub' } });
    const resolution = await tool.resolveExecution({ agent_id: 'agent-1', message: 'hello' });
    expect(resolution).toEqual({ output: SUBAGENT_NOT_ALLOWED_MSG, isError: true });
    expect(prompt.inject).not.toHaveBeenCalled();
  });

  it('errors with the live agent list when the target is not live', async () => {
    const { tool } = buildTool({ known: false });
    const result = await execute(await tool.resolveExecution({ agent_id: 'ghost', message: 'hi' }));
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('"ghost" is not currently live');
    expect(String(result.output)).toContain('resume');
  });

  it('soft delivery steers into the running turn without cancelling', async () => {
    const { tool, loop, prompt } = buildTool();
    const result = await execute(
      await tool.resolveExecution({ agent_id: 'agent-1', message: 'revise section B' }),
    );
    expect(result.isError).toBeUndefined();
    expect(loop.cancel).not.toHaveBeenCalled();
    expect(prompt.inject).toHaveBeenCalledTimes(1);
    const message = prompt.inject.mock.calls[0]![0] as {
      role: string;
      content: { type: string; text?: string }[];
      origin: unknown;
    };
    expect(message.role).toBe('user');
    expect(message.content[0]).toEqual({ type: 'text', text: 'revise section B' });
    expect(message.origin).toEqual({ kind: 'agent_message', agentId: 'main' });
    expect(String(result.output)).toContain('steered into the running turn');
  });

  it('interrupt delivery cancels the current turn before injecting', async () => {
    const { tool, loop, prompt } = buildTool();
    const result = await execute(
      await tool.resolveExecution({ agent_id: 'agent-1', message: 'stop and redo', interrupt: true }),
    );
    expect(result.isError).toBeUndefined();
    expect(loop.cancel).toHaveBeenCalledTimes(1);
    expect(prompt.inject).toHaveBeenCalledTimes(1);
    expect(loop.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.inject.mock.invocationCallOrder[0]!,
    );
    expect(String(result.output)).toContain('turn cancelled');
  });

  it('reports delivery failure when inject throws', async () => {
    const { tool } = buildTool({ injectError: new Error('scope disposed') });
    const result = await execute(await tool.resolveExecution({ agent_id: 'agent-1', message: 'hi' }));
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('Delivery to "agent-1" failed');
    expect(String(result.output)).toContain('scope disposed');
  });
});
