/**
 * `leadTurnTimeout` domain (L4) — `ILeadTurnTimeoutService` implementation.
 *
 * Team-mode mechanical guardrail on the main agent's own turn. In team mode a
 * tech-lead is supposed to dispatch work to subagents rather than execute it
 * by hand; this service arms on displayable user turns of the main agent and
 * interrupts a turn whose *execution-class tool budget* exceeds the
 * `[subagent] lead_turn_timeout_ms` allowance (default 30s, `0` disables),
 * then — only after the turn has truly ended — injects a "dispatch, don't do
 * it yourself" reminder.
 *
 * **Budget accounting (per the finalized design)**: the budget accumulates
 * execution-class tool durations by `toolCallId` — the service self-times each
 * `tool.call.started` → `tool.result` pair and adds the delta to the armed
 * turn when `classifyToolCall(name, args)` returns `'execution'` — **plus every
 * completed step's LLM generation duration** (`llmStreamDurationMs`), charged
 * whether or not the step ended in a tool call. Dispatch / management /
 * wait-user tools do not consume budget, and — crucially — while one of them
 * is still in flight at budget-exceeded time the interrupt is *delayed* (a
 * foreground `Agent` dispatch must not be cut mid-flight); the interrupt fires
 * once the last delaying tool settles.
 *
 * **Interrupt + inject ordering** (the critical race): ① `loop.cancel` with a
 * plain `{ kind: 'lead_turn_timeout' }` reason (NOT a `UserCancellationError`,
 * so the loop records `interruptReason: 'aborted'` rather than
 * `user_cancelled`); ② wait for that turn's `turn.ended`; ③ only then
 * `promptService.inject` the reminder. A turn the user manually ESC-cancelled
 * before the mechanism fired never injects; a mechanism-fired turn injects
 * exactly once (per-turn `fired` flag + cleanup on `turn.ended`).
 *
 * **Generation**: every completed step — tool-bearing or not — charges its LLM
 * stream duration (`llmStreamDurationMs`): long generations consume budget per
 * doctrine. The stream duration covers only the LLM streaming segment, and tool
 * execution happens between steps (disjoint wall-clock intervals), so charging
 * both tool time and generation time is not double-counting. Dispatch /
 * management / wait-user steps' *generation* still counts; only their tool
 * durations are exempt.
 *
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  isDisplayablePromptOrigin,
  type TurnStepCompletedEvent,
} from '#/agent/loop/turnEvents';
import type {
  ToolCallStartedEvent,
  ToolResultEvent,
} from '#/agent/toolExecutor/toolExecutorEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import {
  resolveLeadTurnTimeoutMs,
  resolveTeamMode,
  TEAM_TOOL_NAMES,
} from '#/session/subagent/configSection';

import { ILeadTurnTimeoutService } from './leadTurnTimeout';

/** Reminder origin name — non-user so it bypasses the UserPromptSubmit filter. */
export const LEAD_TURN_TIMEOUT_REMINDER_NAME = 'lead_turn_timeout_reminder';
/** Loop-cancel reason kind — a plain object so the loop records 'aborted'. */
export const LEAD_TURN_TIMEOUT_CANCEL_KIND = 'lead_turn_timeout';

export type ToolCallClass = 'execution' | 'dispatch' | 'management' | 'wait-user';

/** Dispatch tools — delegate to a subagent (foreground or background). */
const DISPATCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'AgentSwarm']);
/** Management tools — team + task bookkeeping, never hands-on work. */
const MANAGEMENT_TOOLS: ReadonlySet<string> = new Set([
  ...TEAM_TOOL_NAMES,
  'TaskList',
  'TaskOutput',
  'TaskStop',
]);
/** Wait-user tools — the user's answer time sits inside the tool window. */
const WAIT_USER_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion']);

/**
 * Classify a tool call for budget accounting. Pure function:
 *   - `execution`  — hands-on work (file read/write/edit, Bash, search, …);
 *                    consumes the lead-turn budget. Any tool outside the three
 *                    special categories defaults to execution.
 *   - `dispatch`   — `Agent` / `AgentSwarm`: delegation, never hands-on work.
 *   - `management` — Team* + task-management tools (bookkeeping).
 *   - `wait-user`  — `AskUserQuestion`: the user's wait must not count.
 * `args` is accepted for future refinement (e.g. `Agent.run_in_background`);
 * the design counts the whole dispatch segment as non-consuming regardless.
 */
export function classifyToolCall(name: string, _args: unknown): ToolCallClass {
  if (DISPATCH_TOOLS.has(name)) return 'dispatch';
  if (MANAGEMENT_TOOLS.has(name)) return 'management';
  if (WAIT_USER_TOOLS.has(name)) return 'wait-user';
  return 'execution';
}

interface ArmedTurn {
  /** Accumulated budget (execution-class tool duration + step generation) in ms. */
  consumedMs: number;
  /** The mechanism already interrupted this turn. */
  fired: boolean;
}

interface InFlightCall {
  readonly turnId: number;
  readonly name: string;
  readonly args: unknown;
  readonly t0: number;
}

export class LeadTurnTimeoutService extends Disposable implements ILeadTurnTimeoutService {
  declare readonly _serviceBrand: undefined;

  private readonly callerAgentId: string;
  private readonly armed = new Map<number, ArmedTurn>();
  private readonly inFlight = new Map<string, InFlightCall>();

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IConfigService private readonly config: IConfigService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IEventBus eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.callerAgentId = scopeContext.agentId;
    this._register(
      eventBus.subscribe('turn.started', (event) => {
        if (!this.shouldArm(event.origin)) return;
        this.arm(event.turnId);
      }),
    );
    this._register(
      eventBus.subscribe('turn.ended', (event) => {
        const armed = this.armed.get(event.turnId);
        if (armed === undefined) return;
        this.cleanup(event.turnId);
        // Inject only for a mechanism-fired interrupt (never a user ESC, never
        // a natural completion before the budget ran out).
        if (armed.fired && event.interruptReason !== 'user_cancelled') {
          this.injectReminder(event.turnId);
        }
      }),
    );
    this._register(
      eventBus.subscribe('turn.step.completed', (event) => {
        this.onStepCompleted(event);
      }),
    );
    this._register(
      eventBus.subscribe('tool.call.started', (event) => {
        this.trackStarted(event);
      }),
    );
    this._register(
      eventBus.subscribe('tool.result', (event) => {
        this.trackResult(event);
      }),
    );
  }

  private shouldArm(origin: PromptOrigin): boolean {
    // Only the main agent (tech-lead) is supervised; subagents are not.
    if (this.callerAgentId !== 'main') return false;
    if (!resolveTeamMode(this.config)) return false;
    if (resolveLeadTurnTimeoutMs(this.config) <= 0) return false;
    // system_trigger / internal-steering turns must not arm — otherwise a
    // reminder inject would itself open a turn and recurse.
    if (!isDisplayablePromptOrigin(origin)) return false;
    return true;
  }

  private arm(turnId: number): void {
    if (this.armed.has(turnId)) return;
    this.armed.set(turnId, { consumedMs: 0, fired: false });
  }

  private trackStarted(event: ToolCallStartedEvent): void {
    if (!this.armed.has(event.turnId)) return;
    this.inFlight.set(event.toolCallId, {
      turnId: event.turnId,
      name: event.name,
      args: event.args,
      t0: Date.now(),
    });
  }

  private trackResult(event: ToolResultEvent): void {
    const call = this.inFlight.get(event.toolCallId);
    if (call === undefined) return;
    this.inFlight.delete(event.toolCallId);
    const state = this.armed.get(call.turnId);
    if (state === undefined || state.fired) return;
    if (classifyToolCall(call.name, call.args) === 'execution') {
      state.consumedMs += Math.max(0, Date.now() - call.t0);
    }
    // Re-evaluate after every tool settles: budget over + no delaying tool in
    // flight → interrupt. (The accumulation seam for future refinements is
    // `classifyToolCall` + this single addition point.)
    this.checkBudget(call.turnId, state);
  }

  /**
   * Charge a completed step's LLM generation. Every step charges — whether or
   * not it ended in a tool call: `llmStreamDurationMs` covers only the LLM
   * streaming segment, and tool execution happens between steps, so charging
   * both is not double-counting. A freshly completed step has nothing in
   * flight, so the in-flight exemption in `checkBudget` is naturally inert: an
   * over-budget generation interrupts.
   */
  private onStepCompleted(event: TurnStepCompletedEvent): void {
    const state = this.armed.get(event.turnId);
    if (state === undefined || state.fired) return;
    state.consumedMs += Math.max(0, event.llmStreamDurationMs ?? 0);
    this.checkBudget(event.turnId, state);
  }

  private checkBudget(turnId: number, state: ArmedTurn): void {
    if (state.fired || state.consumedMs < resolveLeadTurnTimeoutMs(this.config)) return;
    // A dispatch / management / wait-user tool still in flight holds the
    // interrupt; it fires once the last one settles.
    for (const call of this.inFlight.values()) {
      if (call.turnId !== turnId) continue;
      if (classifyToolCall(call.name, call.args) !== 'execution') return;
    }
    this.fire(turnId);
  }

  private fire(turnId: number): void {
    const state = this.armed.get(turnId);
    if (state === undefined || state.fired) return;
    state.fired = true;
    try {
      this.loop.cancel(turnId, { kind: LEAD_TURN_TIMEOUT_CANCEL_KIND });
    } catch (error) {
      this.log.warn('lead-turn timeout cancel failed', { turnId, error });
    }
    // The reminder is injected from the turn.ended handler once the turn has
    // truly finished (activeTurnJob released) — never here.
  }

  private injectReminder(turnId: number): void {
    const seconds = Math.round(resolveLeadTurnTimeoutMs(this.config) / 1000);
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You exceeded the ${seconds}s turn budget. You are the tech-lead — dispatch the work to team members instead of doing it yourself; keep every dispatch a minimal unit and time-box it.`,
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: LEAD_TURN_TIMEOUT_REMINDER_NAME },
    };
    void this.prompt
      .inject(message)
      .catch((error) => this.log.warn('lead-turn timeout reminder inject failed', { turnId, error }));
  }

  private cleanup(turnId: number): void {
    for (const [toolCallId, call] of this.inFlight) {
      if (call.turnId === turnId) this.inFlight.delete(toolCallId);
    }
    this.armed.delete(turnId);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ILeadTurnTimeoutService,
  LeadTurnTimeoutService,
  ScopeActivation.OnScopeCreated,
  'leadTurnTimeout',
);
