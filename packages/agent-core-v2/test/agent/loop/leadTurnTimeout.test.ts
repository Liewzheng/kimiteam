/**
 * `LeadTurnTimeoutService` — team-mode main-agent lead-turn timeout.
 *
 * Verifies the tool-call-budget mechanism per the finalized design: arming
 * gates (main agent + team mode + displayable origin + budget > 0),
 * execution-class tool durations accumulate by `toolCallId`, dispatch /
 * management / wait-user tools neither consume budget nor get interrupted
 * mid-flight, and the cancel → turn.ended → inject ordering holds with
 * per-turn dedupe and the user-ESC skip. The classifier is exercised as pure
 * functions; pure generation is not charged (tool-level accumulation).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  classifyToolCall,
  LEAD_TURN_TIMEOUT_CANCEL_KIND,
  LEAD_TURN_TIMEOUT_REMINDER_NAME,
  LeadTurnTimeoutService,
} from '#/agent/leadTurnTimeout/leadTurnTimeoutService';
import { TEAM_TOOL_NAMES } from '#/session/subagent/configSection';

import {
  agentService,
  createTestAgent,
  type TestAgentContext,
} from '../../harness';
import { stubLog } from '../../_base/log/stubs';
import { stubLoopWithHooks, type StubLoop } from './stubs';

function userTurnStarted(turnId: number): unknown {
  return { type: 'turn.started', turnId, origin: { kind: 'user' } };
}

function toolStarted(turnId: number, toolCallId: string, name: string, args: unknown = {}): unknown {
  return { type: 'tool.call.started', turnId, toolCallId, name, args };
}

function toolResult(turnId: number, toolCallId: string): unknown {
  return { type: 'tool.result', turnId, toolCallId, output: '' };
}

function turnEnded(
  turnId: number,
  reason: 'completed' | 'cancelled' | 'failed' | 'blocked',
  interruptReason?: 'user_cancelled' | 'aborted',
): unknown {
  return { type: 'turn.ended', turnId, reason, ...(interruptReason === undefined ? {} : { interruptReason }) };
}

function stepStarted(turnId: number, step: number): unknown {
  return { type: 'turn.step.started', turnId, step };
}

function stepCompleted(turnId: number, step: number, llmStreamDurationMs?: number): unknown {
  return { type: 'turn.step.completed', turnId, step, ...(llmStreamDurationMs === undefined ? {} : { llmStreamDurationMs }) };
}

describe('classifyToolCall', () => {
  it('classifies hands-on execution tools as execution', () => {
    for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'FetchURL', 'WebSearch', 'Skill', 'TodoList']) {
      expect(classifyToolCall(name, {})).toBe('execution');
    }
  });

  it('classifies delegation tools as dispatch', () => {
    expect(classifyToolCall('Agent', { subagent_type: 'coder', run_in_background: false })).toBe('dispatch');
    expect(classifyToolCall('Agent', { subagent_type: 'coder', run_in_background: true })).toBe('dispatch');
    expect(classifyToolCall('AgentSwarm', {})).toBe('dispatch');
  });

  it('classifies team + task management tools as management', () => {
    for (const name of [...TEAM_TOOL_NAMES, 'TaskList', 'TaskOutput', 'TaskStop']) {
      expect(classifyToolCall(name, {})).toBe('management');
    }
  });

  it('classifies AskUserQuestion as wait-user', () => {
    expect(classifyToolCall('AskUserQuestion', { question: 'x' })).toBe('wait-user');
  });
});

describe('LeadTurnTimeoutService', () => {
  let ctx: TestAgentContext | undefined;
  let loop: StubLoop;
  let injectSpy: Mock;

  function harnessCtx(options: { teamMode?: boolean; leadTurnTimeoutMs?: number }): TestAgentContext {
    return createTestAgent(
      agentService(IAgentLoopService, loop),
      {
        initialConfig: {
          subagent: {
            ...(options.teamMode === undefined ? {} : { teamMode: options.teamMode }),
            ...(options.leadTurnTimeoutMs === undefined ? {} : { leadTurnTimeoutMs: options.leadTurnTimeoutMs }),
          },
        },
      },
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    loop = stubLoopWithHooks();
    ctx = harnessCtx({ teamMode: true, leadTurnTimeoutMs: 5000 });
    // The real prompt service stays in place (overriding it breaks the harness
    // agent-scope construction); spy on its `inject` to capture the reminder.
    injectSpy = vi.spyOn(ctx.get(IAgentPromptService), 'inject').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  function publish(event: unknown): void {
    ctx!.get(IEventBus).publish(event as never);
  }

  it('interrupts when execution-class tool time exceeds the budget, then injects after turn.ended', async () => {
    publish(userTurnStarted(1));

    publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(3000);
    publish(toolResult(1, 'c1')); // 3000ms consumed < 5000
    expect(loop.cancels).toHaveLength(0);

    publish(toolStarted(1, 'c2', 'Read'));
    await vi.advanceTimersByTimeAsync(2000);
    publish(toolResult(1, 'c2')); // 5000ms consumed → interrupt (plain reason)

    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
    // ② the reminder is NOT injected yet — the turn must truly end first.
    expect(injectSpy).not.toHaveBeenCalled();

    // ③ once the turn ends, the reminder lands.
    publish(turnEnded(1, 'cancelled', 'aborted'));
    await Promise.resolve();
    expect(injectSpy).toHaveBeenCalledTimes(1);
    const message = injectSpy.mock.calls[0]?.[0] as ContextMessage;
    expect(message.origin).toEqual({ kind: 'system_trigger', name: LEAD_TURN_TIMEOUT_REMINDER_NAME });
    const text = (message.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('5s');
    expect(text).toContain('tech-lead');
    expect(text).toContain('dispatch');
  });

  it('does not consume budget for a foreground Agent dispatch and never interrupts it', async () => {
    publish(userTurnStarted(1));
    publish(toolStarted(1, 'a1', 'Agent', { subagent_type: 'coder', run_in_background: false }));
    // A long foreground dispatch — wall time far past the budget, but the
    // dispatch consumes nothing and must not be interrupted.
    await vi.advanceTimersByTimeAsync(20_000);
    publish(toolResult(1, 'a1'));
    expect(loop.cancels).toHaveLength(0);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('delays the interrupt while a dispatch tool is in flight at budget-exceeded time', async () => {
    publish(userTurnStarted(1));
    publish(toolStarted(1, 'a1', 'Agent', { subagent_type: 'coder' })); // in-flight dispatch
    publish(toolStarted(1, 'b1', 'Bash'));

    await vi.advanceTimersByTimeAsync(5000);
    publish(toolResult(1, 'b1')); // budget crossed, but Agent still in flight → delay
    expect(loop.cancels).toHaveLength(0);

    publish(toolResult(1, 'a1')); // dispatch settles → no delaying tool left → interrupt
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
  });

  it('does not consume budget for AskUserQuestion (wait-user)', async () => {
    publish(userTurnStarted(1));
    publish(toolStarted(1, 'q1', 'AskUserQuestion', { question: 'proceed?' }));
    await vi.advanceTimersByTimeAsync(20_000); // the user's answer wait
    publish(toolResult(1, 'q1'));
    expect(loop.cancels).toHaveLength(0);
  });

  it('does not arm on a non-displayable (system_trigger) turn', async () => {
    publish({ type: 'turn.started', turnId: 1, origin: { kind: 'system_trigger', name: 'subagent' } });
    publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(20_000);
    publish(toolResult(1, 'c1'));
    expect(loop.cancels).toHaveLength(0);
  });

  it('does not arm outside team mode or when the budget is 0', async () => {
    const noTeam = harnessCtx({ leadTurnTimeoutMs: 5000 });
    noTeam.get(IEventBus).publish(userTurnStarted(1) as never);
    noTeam.get(IEventBus).publish(toolStarted(1, 'c1', 'Bash') as never);
    await vi.advanceTimersByTimeAsync(20_000);
    noTeam.get(IEventBus).publish(toolResult(1, 'c1') as never);
    expect(loop.cancels).toHaveLength(0);
    await noTeam.dispose();

    const zero = harnessCtx({ teamMode: true, leadTurnTimeoutMs: 0 });
    zero.get(IEventBus).publish(userTurnStarted(2) as never);
    zero.get(IEventBus).publish(toolStarted(2, 'c2', 'Bash') as never);
    await vi.advanceTimersByTimeAsync(20_000);
    zero.get(IEventBus).publish(toolResult(2, 'c2') as never);
    expect(loop.cancels).toHaveLength(0);
    await zero.dispose();
  });

  it('injects exactly once per mechanism-fired turn (duplicate turn.ended is a no-op)', async () => {
    publish(userTurnStarted(1));
    publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    publish(toolResult(1, 'c1'));
    publish(turnEnded(1, 'cancelled', 'aborted'));
    await Promise.resolve();
    expect(injectSpy).toHaveBeenCalledTimes(1);

    publish(turnEnded(1, 'cancelled', 'aborted'));
    await Promise.resolve();
    expect(injectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not inject when the user cancels the turn before the mechanism fires', async () => {
    publish(userTurnStarted(1));
    publish(turnEnded(1, 'cancelled', 'user_cancelled'));
    await Promise.resolve();
    publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(20_000);
    publish(toolResult(1, 'c1'));
    expect(loop.cancels).toHaveLength(0);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('charges a pure-generation step (no tool calls) and interrupts when it exceeds the budget', async () => {
    publish(userTurnStarted(1));
    publish(stepStarted(1, 1));
    publish(stepCompleted(1, 1, 6000)); // a 6s LLM generation with no tools
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);

    publish(turnEnded(1, 'cancelled', 'aborted'));
    await Promise.resolve();
    expect(injectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not additionally charge the LLM generation of a step that called a tool', async () => {
    publish(userTurnStarted(1));
    // Step 1 has a Bash tool: its 3s duration counts, the 10s generation does not.
    publish(stepStarted(1, 1));
    publish(toolStarted(1, 'b1', 'Bash'));
    await vi.advanceTimersByTimeAsync(3000);
    publish(toolResult(1, 'b1')); // 3000 consumed
    publish(stepCompleted(1, 1, 10_000)); // NOT charged — step has a tool
    expect(loop.cancels).toHaveLength(0); // if the 10s had counted we'd have fired here

    // Step 2: another execution tool crosses the budget.
    publish(stepStarted(1, 2));
    publish(toolStarted(1, 'b2', 'Read'));
    await vi.advanceTimersByTimeAsync(2000);
    publish(toolResult(1, 'b2')); // 5000 → interrupt
    publish(stepCompleted(1, 2, 10_000)); // not charged either
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
  });

  it('does not charge the generation of a dispatch-only step (Agent)', async () => {
    publish(userTurnStarted(1));
    publish(stepStarted(1, 1));
    publish(toolStarted(1, 'a1', 'Agent', { subagent_type: 'coder' }));
    await vi.advanceTimersByTimeAsync(5000);
    publish(toolResult(1, 'a1')); // dispatch not counted
    publish(stepCompleted(1, 1, 10_000)); // step has a tool → generation not counted
    expect(loop.cancels).toHaveLength(0);
  });

  it('accumulates pure generation and execution tools together across a mixed turn', async () => {
    publish(userTurnStarted(1));
    // Step 1: pure generation 3000ms.
    publish(stepStarted(1, 1));
    publish(stepCompleted(1, 1, 3000));
    expect(loop.cancels).toHaveLength(0); // 3000 < 5000

    // Step 2: Bash 2000ms crosses the budget.
    publish(stepStarted(1, 2));
    publish(toolStarted(1, 'b1', 'Bash'));
    await vi.advanceTimersByTimeAsync(2000);
    publish(toolResult(1, 'b1')); // 3000 + 2000 = 5000 → interrupt
    publish(stepCompleted(1, 2, 9999)); // step has a tool → not charged
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
  });

  it('does not arm for a non-main agent', async () => {
    const bus = new FakeBus();
    const loopStub = stubLoopWithHooks();
    const promptStub = { inject: vi.fn().mockResolvedValue(undefined) } as unknown as IAgentPromptService;
    const service = new LeadTurnTimeoutService(
      { _serviceBrand: undefined, agentId: 'sub', scope: () => 'agents/sub' } as unknown as IAgentScopeContext,
      { _serviceBrand: undefined, get: () => ({ teamMode: true, leadTurnTimeoutMs: 5000 }) } as unknown as never,
      loopStub,
      promptStub,
      bus as unknown as IEventBus,
      stubLog(),
    );
    bus.publish(userTurnStarted(1) as never);
    bus.publish(toolStarted(1, 'c1', 'Bash') as never);
    await vi.advanceTimersByTimeAsync(20_000);
    bus.publish(toolResult(1, 'c1') as never);
    expect(loopStub.cancels).toHaveLength(0);
    expect(promptStub.inject).not.toHaveBeenCalled();
    service.dispose();
  });
});

/** Minimal bus stub for the direct-construction (non-main) test. */
class FakeBus {
  private readonly byType = new Map<string, Array<(e: never) => void>>();
  publish(event: never): void {
    for (const handler of this.byType.get((event as { type: string }).type) ?? []) handler(event);
  }
  subscribe(type: unknown, handler: unknown): { dispose(): void } {
    const list = this.byType.get(type as string) ?? [];
    list.push(handler as (e: never) => void);
    this.byType.set(type as string, list);
    return { dispose: () => {} };
  }
}
