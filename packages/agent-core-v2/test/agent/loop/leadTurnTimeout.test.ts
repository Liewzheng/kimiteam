/**
 * `LeadTurnTimeoutService` — team-mode main-agent lead-turn timeout.
 *
 * Verifies the budget mechanism per the finalized design: arming gates (main
 * agent + team mode + displayable origin + budget > 0), execution-class tool
 * durations accumulate by `toolCallId` and every completed step charges its
 * LLM generation duration, dispatch / management / wait-user tools neither
 * consume budget nor get interrupted mid-flight, the warn path keeps the
 * cancel → turn.ended → inject ordering with per-turn dedupe and the user-ESC
 * skip, and the enforce path replaces the cancel with a code-layer block:
 * budget exhaustion locks the turn, execution-class tool calls are vetoed at
 * the executor, and the user re-authorization round-trip re-arms a fresh
 * budget window (never stacked, capped per turn). The classifier and the pure
 * decision helpers are exercised as pure functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Event } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import type { ToolCall } from '#/kosong/contract/message';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { BeforeToolExecuteEmitter } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import {
  ISessionQuestionService,
  type QuestionRequest,
  type QuestionResult,
} from '#/session/question/question';
import {
  classifyToolCall,
  LEAD_TURN_TIMEOUT_CANCEL_KIND,
  LEAD_TURN_TIMEOUT_REMINDER_NAME,
  LEAD_TURN_AUTO_EXTEND_WARNING_NAME,
  LeadTurnTimeoutService,
} from '#/agent/leadTurnTimeout/leadTurnTimeoutService';
import {
  decideExecutionBlock,
  rearmState,
} from '#/agent/leadTurnTimeout/leadTurnTimeout';
import {
  SUBAGENT_SECTION,
  TEAM_TOOL_NAMES,
  resolveLeadTurnGate,
  resolveLeadTurnGrantMs,
  resolveLeadTurnGrantTimeoutMs,
} from '#/session/subagent/configSection';

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

describe('decideExecutionBlock — pure veto decision', () => {
  const base = {
    mode: 'enforce' as const,
    className: 'execution' as const,
    locked: true,
    asked: false,
    grantsUsed: 0,
    grantMs: 30_000,
    maxGrants: 5,
    canAsk: true,
  };

  it('passes when the gate is not enforce', () => {
    expect(decideExecutionBlock({ ...base, mode: 'warn' }).kind).toBe('pass');
    expect(decideExecutionBlock({ ...base, mode: 'off' }).kind).toBe('pass');
  });

  it('passes when the turn is not locked', () => {
    expect(decideExecutionBlock({ ...base, locked: false }).kind).toBe('pass');
  });

  it('passes for dispatch / management / wait-user classes while locked', () => {
    for (const className of ['dispatch', 'management', 'wait-user'] as const) {
      expect(decideExecutionBlock({ ...base, className }).kind).toBe('pass');
    }
  });

  it('blocks an execution-class call on a locked turn with an ask while a grant is available', () => {
    const d = decideExecutionBlock(base);
    expect(d.kind).toBe('block');
    if (d.kind === 'block') {
      expect(d.ask).toBe(true);
      expect(d.message).toContain('budget');
    }
  });

  it('blocks silently when already asked, grants capped, grantMs 0, or no ask channel', () => {
    const silentCases: Array<Partial<typeof base>> = [
      { asked: true },
      { grantsUsed: 5, maxGrants: 5 },
      { grantMs: 0 },
      { canAsk: false },
      { asked: true, grantsUsed: 5, grantMs: 0, canAsk: false },
    ];
    for (const patch of silentCases) {
      const d = decideExecutionBlock({ ...base, ...patch });
      expect(d.kind).toBe('block');
      if (d.kind === 'block') expect(d.ask).toBe(false);
    }
  });
});

describe('rearmState — fresh budget window, never stacked', () => {
  it('resets consumed budget, clears the lock and asked flag, bumps the epoch', () => {
    expect(rearmState({ consumedMs: 4000, locked: true, asked: true, epoch: 2 })).toEqual({
      consumedMs: 0,
      locked: false,
      asked: false,
      epoch: 3,
    });
  });

  it('does not carry the exhausted budget into the new window', () => {
    const next = rearmState({ consumedMs: 100_000, locked: true, asked: false, epoch: 0 });
    expect(next.consumedMs).toBe(0);
  });
});

describe('lead-turn gate config resolution', () => {
  function cfg(value: Record<string, unknown>): IConfigService {
    return {
      _serviceBrand: undefined,
      get: (domain: string) => (domain === SUBAGENT_SECTION ? value : undefined),
    } as unknown as IConfigService;
  }

  it('resolves the gate mode with default enforce', () => {
    expect(resolveLeadTurnGate(cfg({}))).toBe('enforce');
    expect(resolveLeadTurnGate(cfg({ leadTurnGate: 'warn' }))).toBe('warn');
    expect(resolveLeadTurnGate(cfg({ leadTurnGate: 'off' }))).toBe('off');
  });

  it('resolves the grant window and its timeout defaults', () => {
    expect(resolveLeadTurnGrantMs(cfg({}))).toBe(30_000);
    expect(resolveLeadTurnGrantMs(cfg({ leadTurnGrantMs: 0 }))).toBe(0);
    expect(resolveLeadTurnGrantTimeoutMs(cfg({}))).toBe(60_000);
    expect(resolveLeadTurnGrantTimeoutMs(cfg({ leadTurnGrantTimeoutMs: 0 }))).toBe(0);
  });
});

describe('LeadTurnTimeoutService (warn path — legacy behavior)', () => {
  let ctx: TestAgentContext | undefined;
  let loop: StubLoop;
  let injectSpy: Mock;

  function harnessCtx(options: {
    teamMode?: boolean;
    leadTurnTimeoutMs?: number;
    leadTurnGate?: 'off' | 'warn' | 'enforce';
  }): TestAgentContext {
    return createTestAgent(
      agentService(IAgentLoopService, loop),
      {
        initialConfig: {
          subagent: {
            ...(options.teamMode === undefined ? {} : { teamMode: options.teamMode }),
            ...(options.leadTurnTimeoutMs === undefined ? {} : { leadTurnTimeoutMs: options.leadTurnTimeoutMs }),
            // Legacy warn-path tests pin the gate to `warn` so the cancel →
            // turn.ended → inject contract stays exactly as before.
            leadTurnGate: options.leadTurnGate ?? 'warn',
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
    publish(stepCompleted(1, 1, 6000)); // a 6s LLM generation with no tools
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);

    publish(turnEnded(1, 'cancelled', 'aborted'));
    await Promise.resolve();
    expect(injectSpy).toHaveBeenCalledTimes(1);
  });

  it('charges the LLM generation of a step that also called a tool', async () => {
    publish(userTurnStarted(1));
    // Step 1: the LLM stream ends with a Bash tool call. Its 3s generation
    // charges like any other step; the tool's 3s wall time charges on top →
    // 6s crosses the 5s budget (the old 口径 exempted this step's generation).
    publish(stepCompleted(1, 1, 3000)); // generation charged: 3000 < 5000
    publish(toolStarted(1, 'b1', 'Bash'));
    await vi.advanceTimersByTimeAsync(3000);
    publish(toolResult(1, 'b1')); // +3000 = 6000 → interrupt
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
  });

  it('exempts dispatch tool time but charges the dispatch step generation (Agent)', async () => {
    publish(userTurnStarted(1));
    // A long foreground dispatch consumes nothing…
    publish(toolStarted(1, 'a1', 'Agent', { subagent_type: 'coder' }));
    await vi.advanceTimersByTimeAsync(20_000);
    publish(toolResult(1, 'a1')); // dispatch duration not counted
    expect(loop.cancels).toHaveLength(0);
    // …but the step that produced the dispatch charges its 6s generation → over.
    publish(stepCompleted(1, 1, 6000));
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
  });

  it('accumulates pure generation and execution tools together across a mixed turn', async () => {
    publish(userTurnStarted(1));
    // Step 1: pure generation 3000ms.
    publish(stepCompleted(1, 1, 3000));
    expect(loop.cancels).toHaveLength(0); // 3000 < 5000

    // Step 2: Bash 2000ms crosses the budget.
    publish(toolStarted(1, 'b1', 'Bash'));
    await vi.advanceTimersByTimeAsync(2000);
    publish(toolResult(1, 'b1')); // 3000 + 2000 = 5000 → interrupt
    publish(stepCompleted(1, 2, 9999)); // already fired — charging it is a no-op
    expect(loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
  });

  it('does not arm for a non-main agent', async () => {
    const bus = new FakeBus();
    const loopStub = stubLoopWithHooks();
    const promptStub = { inject: vi.fn().mockResolvedValue(undefined) } as unknown as IAgentPromptService;
    const { executor } = stubToolExecutorWithVeto();
    const permissionMode = { mode: 'manual' } as IAgentPermissionModeService;
    const instantiation = {
      invokeFunction: () => undefined,
    } as unknown as IInstantiationService;
    const service = new LeadTurnTimeoutService(
      { _serviceBrand: undefined, agentId: 'sub', scope: () => 'agents/sub' } as unknown as IAgentScopeContext,
      { _serviceBrand: undefined, get: () => ({ teamMode: true, leadTurnTimeoutMs: 5000, leadTurnGate: 'enforce' }) } as unknown as never,
      loopStub,
      promptStub,
      executor,
      permissionMode,
      instantiation,
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

describe('LeadTurnTimeoutService (enforce path — code-layer hard block)', () => {
  let services: LeadTurnTimeoutService[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    services = [];
  });

  afterEach(() => {
    for (const service of services) service.dispose();
    services = [];
    vi.useRealTimers();
  });

  interface MakeServiceOptions {
    agentId?: string;
    teamMode?: boolean;
    leadTurnTimeoutMs?: number;
    leadTurnGate?: 'off' | 'warn' | 'enforce';
    leadTurnGrantMs?: number;
    leadTurnGrantTimeoutMs?: number;
    leadTurnMaxGrants?: number;
    leadTurnLockCapMs?: number;
    question?: ISessionQuestionService;
    permissionMode?: 'manual' | 'yolo' | 'auto';
  }

  function makeService(opts: MakeServiceOptions = {}): {
    bus: FakeBus;
    loop: StubLoop;
    prompt: { inject: Mock };
    emitter: BeforeToolExecuteEmitter;
    service: LeadTurnTimeoutService;
  } {
    const bus = new FakeBus();
    const loop = stubLoopWithHooks();
    const prompt = { inject: vi.fn().mockResolvedValue(undefined) } as unknown as { inject: Mock };
    const { executor, emitter } = stubToolExecutorWithVeto();
    const permissionMode = { mode: opts.permissionMode ?? 'manual' } as IAgentPermissionModeService;
    const instantiation = {
      invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
        fn({ get: () => opts.question }),
    } as unknown as IInstantiationService;
    const config = {
      _serviceBrand: undefined,
      get: () => ({
        teamMode: opts.teamMode ?? true,
        leadTurnTimeoutMs: opts.leadTurnTimeoutMs ?? 5000,
        leadTurnGate: opts.leadTurnGate ?? 'enforce',
        leadTurnGrantMs: opts.leadTurnGrantMs ?? 30_000,
        leadTurnGrantTimeoutMs: opts.leadTurnGrantTimeoutMs ?? 60_000,
        leadTurnMaxGrants: opts.leadTurnMaxGrants ?? 5,
        leadTurnLockCapMs: opts.leadTurnLockCapMs ?? 120_000,
      }),
    } as unknown as IConfigService;
    const service = new LeadTurnTimeoutService(
      { _serviceBrand: undefined, agentId: opts.agentId ?? 'main', scope: () => 'agents/main' } as unknown as IAgentScopeContext,
      config,
      loop,
      prompt as unknown as IAgentPromptService,
      executor,
      permissionMode,
      instantiation,
      bus as unknown as IEventBus,
      stubLog(),
    );
    services.push(service);
    return { bus, loop, prompt, emitter, service };
  }

  function vetoContext(
    turnId: number,
    name: string,
    args: unknown = {},
    toolCallId = 'tc1',
    signal = new AbortController().signal,
  ): ResolvedToolExecutionHookContext {
    const toolCall: ToolCall = { type: 'function', id: toolCallId, name, arguments: '{}' };
    return {
      turnId,
      signal,
      toolCall,
      toolCalls: [toolCall],
      args,
      execution: {} as never,
    };
  }

  function fireVeto(
    h: ReturnType<typeof makeService>,
    turnId: number,
    name: string,
    args: unknown = {},
    toolCallId = 'tc1',
    signal = new AbortController().signal,
  ): Promise<BeforeExecuteDecision | undefined> {
    return h.emitter.fireBeforeExecute(vetoContext(turnId, name, args, toolCallId, signal));
  }

  /** Drain the microtask ticks between the veto fire and the ask landing. */
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('locks on budget exhaustion (no cancel) and vetoes execution-class calls while passing dispatch/management/wait-user', async () => {
    const h = makeService(); // no question channel → silent block
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // 5000 → lock
    expect(h.loop.cancels).toHaveLength(0); // enforce never cancels on exhaustion

    const blocked = await fireVeto(h, 1, 'Read', {}, 'tc-read');
    expect(blocked?.veto).toBeDefined();
    expect(String(blocked?.veto?.output)).toContain('budget');
    expect(String(blocked?.veto?.output)).toContain('blocked');

    // Dispatch / management / wait-user always pass while locked.
    expect(await fireVeto(h, 1, 'Agent', { subagent_type: 'coder' }, 'tc-agent')).toBeUndefined();
    expect(await fireVeto(h, 1, 'TaskOutput', { task_id: 't1' }, 'tc-task')).toBeUndefined();
    expect(await fireVeto(h, 1, 'AskUserQuestion', { questions: [{ question: 'x', options: [] }] }, 'tc-ask')).toBeUndefined();
  });

  it('asks the user on the first blocked call and re-arms a fresh window on approval', async () => {
    const question = new QuestionStub();
    const h = makeService({ question });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // lock

    const decisionPromise = fireVeto(h, 1, 'Read', {}, 'tc-read');
    await flush();
    // The re-authorization ask was issued through the question kernel.
    expect(question.requests).toHaveLength(1);
    const request = question.requests[0]!;
    expect(request.turnId).toBe(1);
    expect(request.toolCallId).toBe('tc-read');
    expect(request.questions[0]!.options[0]!.label).toBe('Grant 30s more');

    question.answer('q', { 'continue?': 'Grant 30s more' });
    const decision = await decisionPromise;
    expect(decision).toBeUndefined(); // approved → the blocked tool proceeds

    // Re-armed with a fresh window: a short execution tool no longer blocks.
    h.bus.publish(toolStarted(1, 'c2', 'Bash'));
    await vi.advanceTimersByTimeAsync(2000);
    h.bus.publish(toolResult(1, 'c2')); // 2000 < 5000 → not locked again
    expect(await fireVeto(h, 1, 'Read', {}, 'tc-after')).toBeUndefined();
  });

  it('declines once and then silently vetoes further execution-class calls (no repeated ask)', async () => {
    const question = new QuestionStub();
    const h = makeService({ question });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // lock

    const first = fireVeto(h, 1, 'Read', {}, 'tc1');
    await flush();
    expect(question.requests).toHaveLength(1);
    question.answer('q', { 'continue?': 'No — dispatch instead' });
    const firstDecision = await first;
    expect(firstDecision?.veto).toBeDefined();

    // Second execution-class call: no new ask, immediate silent veto.
    const second = await fireVeto(h, 1, 'Bash', {}, 'tc2');
    expect(second?.veto).toBeDefined();
    expect(question.requests).toHaveLength(1); // no second ask
  });

  it('treats a grant-ask timeout as a decline and vetoes the call', async () => {
    const question = new QuestionStub();
    const h = makeService({ question, leadTurnGrantTimeoutMs: 1000 });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // lock

    const decisionPromise = fireVeto(h, 1, 'Read', {}, 'tc1');
    await flush();
    expect(question.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // deadline fires → ask resolves as declined
    const decision = await decisionPromise;
    expect(decision?.veto).toBeDefined();
    expect(question.requests).toHaveLength(1); // still only one ask this episode
  });

  it('re-arms per grant (no stacking) and caps grants per turn (max_grants)', async () => {
    const question = new QuestionStub();
    const h = makeService({ question, leadTurnMaxGrants: 2 });
    h.bus.publish(userTurnStarted(1));

    // Episode 1: exhaust → lock → ask → grant.
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1'));
    let d = fireVeto(h, 1, 'Read', {}, 'tc1');
    await flush();
    expect(question.requests).toHaveLength(1);
    question.answer('q', { q: 'Grant 30s more' });
    expect(await d).toBeUndefined();

    // Episode 2: exhaust again → lock → ask → grant (grantsUsed reaches the cap).
    h.bus.publish(toolStarted(1, 'c2', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c2'));
    d = fireVeto(h, 1, 'Read', {}, 'tc2');
    await flush();
    expect(question.requests).toHaveLength(2);
    question.answer('q', { q: 'Grant 30s more' });
    expect(await d).toBeUndefined();

    // Episode 3: exhaust again → lock → grants used up → silent veto, no ask.
    h.bus.publish(toolStarted(1, 'c3', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c3'));
    const silent = await fireVeto(h, 1, 'Read', {}, 'tc3');
    expect(silent?.veto).toBeDefined();
    expect(question.requests).toHaveLength(2); // no third ask
  });

  it('warn mode never locks: legacy cancel fires and the veto listener stays inert', async () => {
    const h = makeService({ leadTurnGate: 'warn' });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // warn → legacy cancel
    expect(h.loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
    expect(await fireVeto(h, 1, 'Bash', {}, 'tc2')).toBeUndefined(); // never locked → passes
  });

  it('never locks or vetoes when the mechanism is disabled', async () => {
    // gate off
    let h = makeService({ leadTurnGate: 'off' });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1'));
    expect(h.loop.cancels).toHaveLength(0);
    expect(await fireVeto(h, 1, 'Read', {}, 'tc1')).toBeUndefined();
    h.service.dispose();

    // budget 0
    h = makeService({ leadTurnTimeoutMs: 0 });
    h.bus.publish(userTurnStarted(2));
    h.bus.publish(toolStarted(2, 'c2', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(2, 'c2'));
    expect(await fireVeto(h, 2, 'Read', {}, 'tc2')).toBeUndefined();
    h.service.dispose();

    // team mode off
    h = makeService({ teamMode: false });
    h.bus.publish(userTurnStarted(3));
    h.bus.publish(toolStarted(3, 'c3', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(3, 'c3'));
    expect(await fireVeto(h, 3, 'Read', {}, 'tc3')).toBeUndefined();
    h.service.dispose();

    // non-main agent
    h = makeService({ agentId: 'agent-0' });
    h.bus.publish(userTurnStarted(4));
    h.bus.publish(toolStarted(4, 'c4', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(4, 'c4'));
    expect(await fireVeto(h, 4, 'Read', {}, 'tc4')).toBeUndefined();
    h.service.dispose();

    // non-displayable origin
    h = makeService();
    h.bus.publish({ type: 'turn.started', turnId: 5, origin: { kind: 'system_trigger', name: 'subagent' } });
    h.bus.publish(toolStarted(5, 'c5', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(5, 'c5'));
    expect(await fireVeto(h, 5, 'Read', {}, 'tc5')).toBeUndefined();
    h.service.dispose();
  });

  it('aborts the grant ask when the turn is cancelled, vetoes nothing, and cleans up', async () => {
    const question = new QuestionStub();
    const h = makeService({ question });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // lock

    const controller = new AbortController();
    const decisionPromise = fireVeto(h, 1, 'Read', {}, 'tc1', controller.signal);
    await flush();
    expect(question.requests).toHaveLength(1);

    controller.abort(); // user ESC mid-ask
    const decision = await decisionPromise;
    expect(decision).toBeUndefined(); // no veto on abort, no re-arm

    h.bus.publish(turnEnded(1, 'cancelled', 'user_cancelled'));
    await Promise.resolve();
    expect(h.loop.cancels).toHaveLength(0); // nothing force-cancelled
    // A late tool result on the dead turn is ignored (no leak, no lock).
    h.bus.publish(toolResult(1, 'c1'));
    expect(await fireVeto(h, 1, 'Read', {}, 'tc2')).toBeUndefined();
  });

  it('delays the lock while a dispatch tool is in flight (in-flight exemption preserved)', async () => {
    const h = makeService();
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'a1', 'Agent', { subagent_type: 'coder' })); // in-flight dispatch
    h.bus.publish(toolStarted(1, 'b1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'b1')); // budget crossed, Agent still in flight → not locked yet
    expect(await fireVeto(h, 1, 'Read', {}, 'tc1')).toBeUndefined(); // passes while unlocked

    h.bus.publish(toolResult(1, 'a1')); // dispatch settles → lock
    expect((await fireVeto(h, 1, 'Read', {}, 'tc2'))?.veto).toBeDefined();
  });

  it('force-cancels a locked turn past the lock cap and stays silent (no inject)', async () => {
    const h = makeService({ leadTurnLockCapMs: 1000 });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // lock
    expect(h.loop.cancels).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000); // lock cap fires
    expect(h.loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
    expect(h.prompt.inject).not.toHaveBeenCalled(); // enforce path never injects

    h.bus.publish(turnEnded(1, 'cancelled', 'aborted'));
    await Promise.resolve();
    expect(h.prompt.inject).not.toHaveBeenCalled();
  });

  it('delays the lock-cap backstop while a dispatch tool is in flight', async () => {
    const h = makeService({ leadTurnLockCapMs: 1000 });
    h.bus.publish(userTurnStarted(1));
    h.bus.publish(toolStarted(1, 'c1', 'Bash'));
    await vi.advanceTimersByTimeAsync(5000);
    h.bus.publish(toolResult(1, 'c1')); // lock
    h.bus.publish(toolStarted(1, 'a1', 'Agent', { subagent_type: 'coder' })); // in-flight dispatch

    await vi.advanceTimersByTimeAsync(1000); // cap fires but dispatch in flight → re-arm
    expect(h.loop.cancels).toHaveLength(0);

    h.bus.publish(toolResult(1, 'a1')); // dispatch settles
    await vi.advanceTimersByTimeAsync(1000); // re-armed cap fires
    expect(h.loop.cancels).toEqual([{ turnId: 1, reason: { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND } }]);
  });

  describe('yolo/auto permission modes — auto-extend instead of block', () => {
    it('auto-extends on exhaustion: no cancel, no veto, one warning injected', async () => {
      const h = makeService({ permissionMode: 'yolo' });
      h.bus.publish(userTurnStarted(1));
      h.bus.publish(toolStarted(1, 'c1', 'Bash'));
      await vi.advanceTimersByTimeAsync(5000);
      h.bus.publish(toolResult(1, 'c1')); // exhausted → auto-extend

      // No cancel, and execution-class calls pass immediately (never locked).
      expect(h.loop.cancels).toHaveLength(0);
      expect(await fireVeto(h, 1, 'Read', {}, 'tc-read')).toBeUndefined();

      // One warning through the prompt-inject channel, on this extension.
      expect(h.prompt.inject).toHaveBeenCalledTimes(1);
      const message = h.prompt.inject.mock.calls[0]?.[0] as ContextMessage;
      expect(message.origin).toEqual({ kind: 'system_trigger', name: LEAD_TURN_AUTO_EXTEND_WARNING_NAME });
      const text = (message.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('5s');
      expect(text).toContain('auto-extended');
      expect(text).toContain('dispatch');
    });

    it('re-arms a fresh window and injects one warning per extension', async () => {
      const h = makeService({ permissionMode: 'yolo' });
      h.bus.publish(userTurnStarted(1));

      // 1st extension.
      h.bus.publish(toolStarted(1, 'c1', 'Bash'));
      await vi.advanceTimersByTimeAsync(5000);
      h.bus.publish(toolResult(1, 'c1'));
      expect(h.prompt.inject).toHaveBeenCalledTimes(1);

      // Fresh window: a short execution call no longer triggers anything.
      h.bus.publish(toolStarted(1, 'c2', 'Bash'));
      await vi.advanceTimersByTimeAsync(2000);
      h.bus.publish(toolResult(1, 'c2')); // 2000 < 5000
      expect(h.prompt.inject).toHaveBeenCalledTimes(1);

      // 2nd extension: another warning, still no veto / cancel.
      h.bus.publish(toolStarted(1, 'c3', 'Bash'));
      await vi.advanceTimersByTimeAsync(5000);
      h.bus.publish(toolResult(1, 'c3'));
      expect(h.prompt.inject).toHaveBeenCalledTimes(2);
      expect(await fireVeto(h, 1, 'Bash', {}, 'tc-bash')).toBeUndefined();
      expect(h.loop.cancels).toHaveLength(0);
    });

    it('charges step generation and auto-extends (no cancel) instead of firing', async () => {
      const h = makeService({ permissionMode: 'yolo' });
      h.bus.publish(userTurnStarted(1));
      h.bus.publish(stepCompleted(1, 1, 6000)); // pure generation over budget
      expect(h.loop.cancels).toHaveLength(0);
      expect(h.prompt.inject).toHaveBeenCalledTimes(1);
      expect(await fireVeto(h, 1, 'Read', {}, 'tc1')).toBeUndefined();
    });

    it('yolo wins over the warn gate too: no legacy cancel, warning instead', async () => {
      const h = makeService({ permissionMode: 'yolo', leadTurnGate: 'warn' });
      h.bus.publish(userTurnStarted(1));
      h.bus.publish(toolStarted(1, 'c1', 'Bash'));
      await vi.advanceTimersByTimeAsync(5000);
      h.bus.publish(toolResult(1, 'c1'));
      expect(h.loop.cancels).toHaveLength(0); // yolo overrides the warn cancel
      expect(h.prompt.inject).toHaveBeenCalledTimes(1);
      expect(await fireVeto(h, 1, 'Read', {}, 'tc1')).toBeUndefined();
    });

    it('auto: auto-extends on exhaustion — no veto, no ask, one warning injected', async () => {
      const question = new QuestionStub();
      const h = makeService({ question, permissionMode: 'auto' });
      h.bus.publish(userTurnStarted(1));
      h.bus.publish(toolStarted(1, 'c1', 'Bash'));
      await vi.advanceTimersByTimeAsync(5000);
      h.bus.publish(toolResult(1, 'c1')); // exhausted → auto-extend

      // No cancel; execution-class calls pass immediately (never locked).
      expect(h.loop.cancels).toHaveLength(0);
      expect(await fireVeto(h, 1, 'Read', {}, 'tc-read')).toBeUndefined();
      // The user re-authorization channel is never engaged in auto mode.
      expect(question.requests).toHaveLength(0);

      // One warning through the prompt-inject channel, on this extension.
      expect(h.prompt.inject).toHaveBeenCalledTimes(1);
      const message = h.prompt.inject.mock.calls[0]?.[0] as ContextMessage;
      expect(message.origin).toEqual({ kind: 'system_trigger', name: LEAD_TURN_AUTO_EXTEND_WARNING_NAME });
      const text = (message.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('5s');
      expect(text).toContain('auto-extended');
      expect(text).toContain('dispatch');
    });

    it('manual mode still locks and vetoes on exhaustion (unchanged)', async () => {
      const h = makeService(); // permissionMode defaults to 'manual', gate enforce
      h.bus.publish(userTurnStarted(1));
      h.bus.publish(toolStarted(1, 'c1', 'Bash'));
      await vi.advanceTimersByTimeAsync(5000);
      h.bus.publish(toolResult(1, 'c1'));
      expect(h.loop.cancels).toHaveLength(0); // enforce: no cancel
      expect((await fireVeto(h, 1, 'Read', {}, 'tc-read'))?.veto).toBeDefined(); // vetoed
      expect(h.prompt.inject).not.toHaveBeenCalled(); // enforce never injects
    });
  });
});

/** In-memory question-service stub: records requests, resolves on `answer`. */
class QuestionStub implements ISessionQuestionService {
  readonly _serviceBrand: undefined;
  readonly requests: QuestionRequest[] = [];
  private pending: ((result: QuestionResult) => void) | undefined;

  request(req: QuestionRequest, options?: { signal?: AbortSignal }): Promise<QuestionResult> {
    this.requests.push(req);
    return new Promise<QuestionResult>((resolve) => {
      this.pending = resolve;
      options?.signal?.addEventListener('abort', () => resolve(null), { once: true });
    });
  }

  answer(_id: string, result: QuestionResult): void {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.(result);
  }

  enqueue(req: QuestionRequest): QuestionRequest & { readonly id: string } {
    return { ...req, id: `q:${this.requests.length + 1}` };
  }

  dismiss(_id: string): void {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.(null);
  }

  listPending(): readonly QuestionRequest[] {
    return [];
  }
}

/** Tool-executor stub exposing a fireable `onBeforeExecuteTool` veto emitter. */
function stubToolExecutorWithVeto(): {
  executor: IAgentToolExecutorService;
  emitter: BeforeToolExecuteEmitter;
} {
  const emitter = new BeforeToolExecuteEmitter();
  const executor: IAgentToolExecutorService = {
    _serviceBrand: undefined,
    execute: async function* () {},
    onBeforeExecuteTool: emitter.event,
    onWillExecuteTool: Event.None as Event<WillExecuteToolEvent>,
    hooks: { onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>() },
    recordDupType: () => {},
    registerToolCallGuard: () => ({ dispose() {} }),
    registerUnavailableToolDescriber: () => ({ dispose() {} }),
    registerMissingToolDescriber: () => ({ dispose() {} }),
  };
  return { executor, emitter };
}

/** Minimal bus stub for the direct-construction tests. */
class FakeBus {
  private readonly byType = new Map<string, Array<(e: unknown) => void>>();
  publish(event: unknown): void {
    for (const handler of this.byType.get((event as { type: string }).type) ?? []) handler(event);
  }
  subscribe(type: unknown, handler: unknown): { dispose(): void } {
    const list = this.byType.get(type as string) ?? [];
    list.push(handler as (e: unknown) => void);
    this.byType.set(type as string, list);
    return { dispose: () => {} };
  }
}
