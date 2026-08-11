/**
 * `leadTurnTimeout` domain (L4) — `ILeadTurnTimeoutService` implementation.
 *
 * Team-mode mechanical guardrail on the main agent's own turn. In team mode a
 * tech-lead is supposed to dispatch work to subagents rather than execute it
 * by hand; this service arms on displayable user turns of the main agent and
 * polices the `[subagent] lead_turn_timeout_ms` budget (default 30s, `0`
 * disables) with two enforcement modes:
 *
 * - **`warn` (legacy)**: budget exceeded → `loop.cancel` with a plain
 *   `{ kind: 'lead_turn_timeout' }` reason → turn.ended → inject a
 *   "dispatch, don't do it yourself" reminder once. The reminder can be
 *   ignored, so this is a soft nudge.
 * - **`enforce` (default, the hard limit)**: budget exceeded → the turn is
 *   *locked* (never cancelled); every subsequent execution-class tool call is
 *   vetoed at the executor (`onBeforeExecuteTool`), so the lead physically
 *   cannot keep reading / writing / editing / running commands by hand. The
 *   first blocked call offers a user re-authorization round-trip
 *   (`ISessionQuestionService`, the AskUserQuestion kernel): on approval the
 *   turn is re-armed with a *fresh* budget window (grants never stack), on
 *   decline / timeout it stays locked with dispatch / management / wait-user
 *   tools still allowed until the turn ends, and a `lead_turn_lock_cap_ms`
 *   backstop force-cancels a locked turn that runs away.
 * - **`yolo` / `auto` permission modes (user-trusted, zero friction)**:
 *   regardless of the gate, budget exhaustion never locks, vetoes, or cancels —
 *   the turn is re-armed with a fresh window of the same length
 *   (`lead_turn_timeout_ms`) and a system warning is injected (once per
 *   extension) telling the model it ran over and should wrap up / dispatch.
 *   Auto-extensions are unbounded: the per-turn grant cap applies only to the
 *   user re-authorization channel. Manual mode keeps the warn / enforce
 *   behavior unchanged.
 *
 * **Budget accounting**: the budget accumulates execution-class tool
 * durations by `toolCallId` — the service self-times each
 * `tool.call.started` → `tool.result` pair and adds the delta to the armed
 * **Budget accounting**: the budget accumulates execution-class tool
 * durations by `toolCallId` — the service self-times each
 * `tool.call.started` → `tool.result` pair and adds the delta to the armed
 * turn when `classifyToolCall(name, args)` returns `'execution'` — **plus every
 * completed step's LLM generation duration** (`llmStreamDurationMs`), charged
 * whether or not the step ended in a tool call. Dispatch / management /
 * wait-user tools do not consume budget, and — crucially — while one of them
 * is still in flight at budget-exceeded time the lock/interrupt is *delayed*
 * (a foreground `Agent` dispatch must not be cut mid-flight); it settles once
 * the last delaying tool settles.
 *
 * **Interrupt + inject ordering** (warn path): ① `loop.cancel`; ② wait for
 * `turn.ended`; ③ only then inject the reminder — per-turn once, and never
 * for a user-ESC turn. The enforce path injects nothing (the veto message and
 * the grant ask are the enforcement); its lock-cap backstop reuses the cancel
 * but stays silent.
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
import { IInstantiationService } from '#/_base/di/instantiation';
import { ILogService } from '#/_base/log/log';
import { createDeadlineAbortSignal } from '#/_base/utils/abort';
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
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeExecuteDecision, BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { ISessionQuestionService, type QuestionResult } from '#/session/question/question';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import {
  resolveLeadTurnGate,
  resolveLeadTurnGrantMs,
  resolveLeadTurnGrantTimeoutMs,
  resolveLeadTurnLockCapMs,
  resolveLeadTurnMaxGrants,
  resolveLeadTurnTimeoutMs,
  resolveTeamMode,
  TEAM_TOOL_NAMES,
} from '#/session/subagent/configSection';

import {
  decideExecutionBlock,
  ILeadTurnTimeoutService,
  type ToolCallClass,
} from './leadTurnTimeout';

/** Reminder origin name — non-user so it bypasses the UserPromptSubmit filter. */
export const LEAD_TURN_TIMEOUT_REMINDER_NAME = 'lead_turn_timeout_reminder';
/** Auto-extend (yolo/auto) warning origin name — distinct from the warn reminder. */
export const LEAD_TURN_AUTO_EXTEND_WARNING_NAME = 'lead_turn_auto_extend_warning';
/** Loop-cancel reason kind — a plain object so the loop records 'aborted'. */
export const LEAD_TURN_TIMEOUT_CANCEL_KIND = 'lead_turn_timeout';

/** Block message the model sees when an execution-class call is vetoed. */
const LEAD_TURN_BLOCK_MESSAGE =
  'Lead-turn budget exhausted — execution-class tools are blocked until the turn ends. Dispatch the work to team members instead of doing it yourself.';

export type { ToolCallClass };

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
  /** warn path: the mechanism already interrupted this turn. */
  fired: boolean;
  /** enforce path: the turn is locked — execution-class calls are vetoed. */
  locked: boolean;
  /** enforce path: an ask was declined/timed out (or grants are capped) this lock episode. */
  asked: boolean;
  /** Lock/grant episode counter — bumped on every grant or yolo auto-extend. */
  epoch: number;
  /** Grants consumed this turn (never resets within a turn). */
  grantsUsed: number;
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
  /** Lock-cap backstop timers, keyed by turnId. */
  private readonly lockCapTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IConfigService private readonly config: IConfigService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
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
        // Inject only on the warn path (a mechanism-fired interrupt, never a
        // user ESC, never a natural completion). The enforce path's block is
        // carried by the veto message + grant ask, not by an inject.
        if (
          armed.fired &&
          event.interruptReason !== 'user_cancelled' &&
          resolveLeadTurnGate(this.config) !== 'enforce'
        ) {
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
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => this.adjudicateToolCall(event)),
    );
  }

  override dispose(): void {
    for (const timer of this.lockCapTimers.values()) clearTimeout(timer);
    this.lockCapTimers.clear();
    super.dispose();
  }

  private shouldArm(origin: PromptOrigin): boolean {
    // Only the main agent (tech-lead) is supervised; subagents are not.
    if (this.callerAgentId !== 'main') return false;
    if (!resolveTeamMode(this.config)) return false;
    if (resolveLeadTurnTimeoutMs(this.config) <= 0) return false;
    // `lead_turn_gate = off` disables the mechanism entirely.
    if (resolveLeadTurnGate(this.config) === 'off') return false;
    // system_trigger / internal-steering turns must not arm — otherwise a
    // reminder inject would itself open a turn and recurse.
    if (!isDisplayablePromptOrigin(origin)) return false;
    return true;
  }

  private arm(turnId: number): void {
    if (this.armed.has(turnId)) return;
    this.armed.set(turnId, {
      consumedMs: 0,
      fired: false,
      locked: false,
      asked: false,
      epoch: 0,
      grantsUsed: 0,
    });
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
    // flight → lock (enforce) or interrupt (warn). (The accumulation seam for
    // future refinements is `classifyToolCall` + this single addition point.)
    this.checkBudget(call.turnId, state);
  }

  /**
   * Charge a completed step's LLM generation. Every step charges — whether or
   * not it ended in a tool call: `llmStreamDurationMs` covers only the LLM
   * streaming segment, and tool execution happens between steps, so charging
   * both is not double-counting. A freshly completed step has nothing in
   * flight, so the in-flight exemption in `checkBudget` is naturally inert: an
   * over-budget generation locks (enforce) or interrupts (warn).
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
    // lock/interrupt; it settles first.
    for (const call of this.inFlight.values()) {
      if (call.turnId !== turnId) continue;
      if (classifyToolCall(call.name, call.args) !== 'execution') return;
    }
    // yolo/auto (user-trusted, no-friction): never lock / veto / cancel — re-arm
    // the same window and warn. Only manual keeps the lock/fire path.
    if (this.permissionMode.mode === 'yolo' || this.permissionMode.mode === 'auto') {
      this.autoExtend(turnId, state);
      return;
    }
    if (resolveLeadTurnGate(this.config) === 'enforce') {
      this.lock(turnId, state);
    } else {
      this.fire(turnId);
    }
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
    // The reminder is injected from the turn.ended handler (warn path) once
    // the turn has truly finished (activeTurnJob released) — never here.
  }

  /**
   * enforce path: lock the turn. Execution-class calls are vetoed from now on;
   * the lock-cap backstop bounds how long a locked turn may keep running.
   */
  private lock(turnId: number, state: ArmedTurn): void {
    if (state.locked) return;
    state.locked = true;
    state.asked = false;
    this.armLockCap(turnId, state);
  }

  /** Re-arm the turn with a fresh budget window after a user grant. */
  private rearmTurn(turnId: number, state: ArmedTurn): void {
    state.consumedMs = 0;
    state.locked = false;
    state.asked = false;
    state.epoch += 1;
    state.grantsUsed += 1;
    this.clearLockCap(turnId);
  }

  /**
   * yolo/auto path: budget exhausted → re-arm a fresh window of the same length
   * (`lead_turn_timeout_ms`) and inject a system warning. Never locks / vetoes /
   * cancels, so execution-class calls keep passing; one warning per extension.
   * The per-turn grant cap is intentionally not consumed — yolo/auto extend
   * unbounded (the grant channel is for user re-authorization, not this path).
   */
  private autoExtend(turnId: number, state: ArmedTurn): void {
    state.consumedMs = 0;
    state.locked = false;
    state.asked = false;
    state.epoch += 1;
    this.clearLockCap(turnId);
    this.injectBudgetWarning(turnId);
  }

  private armLockCap(turnId: number, state: ArmedTurn): void {
    const capMs = resolveLeadTurnLockCapMs(this.config);
    if (capMs <= 0) return;
    this.clearLockCap(turnId);
    this.lockCapTimers.set(
      turnId,
      setTimeout(() => {
        this.lockCapTimers.delete(turnId);
        const current = this.armed.get(turnId);
        if (current === undefined || !current.locked) return;
        // A foreground dispatch / management / wait-user tool still in flight
        // delays the backstop rather than being cut mid-flight.
        for (const call of this.inFlight.values()) {
          if (call.turnId !== turnId) continue;
          if (classifyToolCall(call.name, call.args) !== 'execution') {
            this.armLockCap(turnId, current);
            return;
          }
        }
        this.fire(turnId);
      }, capMs),
    );
  }

  private clearLockCap(turnId: number): void {
    const timer = this.lockCapTimers.get(turnId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.lockCapTimers.delete(turnId);
  }

  /**
   * Veto listener registered on the tool executor. Passes everything except
   * execution-class calls on a locked turn; a blocked call either starts the
   * user re-authorization round-trip (once per lock episode, under the
   * per-turn grant cap) or is vetoed outright with a dispatch-only message.
   * The listener only reads `armed`; all mutations happen in the event
   * handlers / grant factory, single-threaded on the agent's event loop.
   */
  private adjudicateToolCall(event: BeforeToolExecuteEvent): void {
    const state = this.armed.get(event.turnId);
    if (state === undefined || !state.locked) return;
    const decision = decideExecutionBlock({
      mode: resolveLeadTurnGate(this.config),
      className: classifyToolCall(event.toolCall.name, event.args),
      locked: state.locked,
      asked: state.asked,
      grantsUsed: state.grantsUsed,
      grantMs: resolveLeadTurnGrantMs(this.config),
      maxGrants: resolveLeadTurnMaxGrants(this.config),
      canAsk: this.canAskUser(),
    });
    if (decision.kind === 'pass') return;
    if (decision.ask) {
      event.waitUntil(() => this.requestGrant(event, state));
      return;
    }
    event.veto(denyToolExecution(decision.message));
  }

  /**
   * User re-authorization round-trip, run as the veto event's deferred
   * factory. Asks through the AskUserQuestion kernel (`ISessionQuestionService`,
   * wait-user by classification so the ask never consumes budget) with a
   * hard answer bound (`lead_turn_grant_timeout_ms`) and the turn's abort
   * signal. On approval the turn is re-armed (fresh window, never stacked);
   * on decline / timeout / no channel it stays locked with `asked` set so this
   * episode does not re-ask. On abort the factory never re-arms and never
   * vetoes — the executor's own abort handling takes over.
   */
  private async requestGrant(
    event: BeforeToolExecuteEvent,
    state: ArmedTurn,
  ): Promise<BeforeExecuteDecision | undefined> {
    if (!this.canAskUser()) {
      state.asked = true;
      return { veto: denyToolExecution(LEAD_TURN_BLOCK_MESSAGE) };
    }
    const timeoutMs = resolveLeadTurnGrantTimeoutMs(this.config);
    const deadline = createDeadlineAbortSignal(event.signal, timeoutMs);
    try {
      const question = this.resolveQuestionService();
      if (question === undefined) {
        state.asked = true;
        return { veto: denyToolExecution(LEAD_TURN_BLOCK_MESSAGE) };
      }
      const grantMs = resolveLeadTurnGrantMs(this.config);
      const grantSeconds = Math.max(1, Math.round(grantMs / 1000));
      const budgetSeconds = Math.max(1, Math.round(resolveLeadTurnTimeoutMs(this.config) / 1000));
      const result = await question.request(
        {
          turnId: event.turnId,
          toolCallId: event.toolCall.id,
          questions: [
            {
              question: `You have exceeded the ${budgetSeconds}s lead-turn budget and want to call "${event.toolCall.name}". Continue the turn?`,
              header: 'Lead-turn budget',
              options: [
                {
                  label: `Grant ${grantSeconds}s more`,
                  description: `Re-arm the turn with a fresh ${grantSeconds}s budget window.`,
                },
                {
                  label: 'No — dispatch instead',
                  description: 'Block execution-class tools; delegate the work to team members.',
                },
              ],
            },
          ],
        },
        { signal: deadline.signal, agentId: this.callerAgentId },
      );
      // The turn was cancelled while asking: never veto, never re-arm.
      if (event.signal.aborted) return undefined;
      if (deadline.timedOut()) {
        state.asked = true;
        return { veto: denyToolExecution(LEAD_TURN_BLOCK_MESSAGE) };
      }
      if (!isGrantAnswer(result)) {
        state.asked = true;
        return { veto: denyToolExecution(LEAD_TURN_BLOCK_MESSAGE) };
      }
      // Grant: re-arm only if the turn is still alive (cleanup may have run).
      if (this.armed.get(event.turnId) === state) {
        this.rearmTurn(event.turnId, state);
      }
      return undefined;
    } catch (error) {
      // Aborted (turn ended / user ESC / deadline) or a channel failure: the
      // turn state is cleaned up on turn.ended; do not re-arm, do not veto.
      this.log.warn('lead-turn budget grant request failed', { turnId: event.turnId, error });
      return undefined;
    } finally {
      deadline.clear();
    }
  }

  /** True when a user re-authorization round-trip is possible on this scope. */
  private canAskUser(): boolean {
    if (this.permissionMode.mode === 'auto') return false;
    if (resolveLeadTurnGrantTimeoutMs(this.config) <= 0) return false;
    return this.resolveQuestionService() !== undefined;
  }

  /** Lazy, defensive resolution of the Session-scoped question service. */
  private resolveQuestionService(): ISessionQuestionService | undefined {
    try {
      return this.instantiation.invokeFunction((accessor) => accessor.get(ISessionQuestionService));
    } catch {
      return undefined;
    }
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

  /**
   * yolo/auto auto-extend warning: injected mid-turn through the system prompt
   * channel (the turn stays active, so the inject merges into it and never
   * opens a new armed turn). Runs once per auto-extend.
   */
  private injectBudgetWarning(turnId: number): void {
    const seconds = Math.round(resolveLeadTurnTimeoutMs(this.config) / 1000);
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You exceeded the ${seconds}s turn budget and it was auto-extended by ${seconds}s. Wrap up the current work and dispatch the rest to team members instead of executing it yourself.`,
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: LEAD_TURN_AUTO_EXTEND_WARNING_NAME },
    };
    void this.prompt
      .inject(message)
      .catch((error) => this.log.warn('lead-turn yolo budget warning inject failed', { turnId, error }));
  }

  private cleanup(turnId: number): void {
    for (const [toolCallId, call] of this.inFlight) {
      if (call.turnId === turnId) this.inFlight.delete(toolCallId);
    }
    this.clearLockCap(turnId);
    this.armed.delete(turnId);
  }
}

/**
 * Detect a grant answer. The AskUserQuestion kernel returns answers keyed by
 * question text with the selected option label as the value; the grant option
 * label is built as `Grant <n>s more`, so a value starting with `Grant` means
 * approval. Dismissals (`null`) and the decline option are refusals.
 */
function isGrantAnswer(result: QuestionResult): boolean {
  if (result === null) return false;
  const answers =
    typeof result === 'object' && 'answers' in result ? result.answers : result;
  return Object.values(answers).some(
    (value) => typeof value === 'string' && value.startsWith('Grant'),
  );
}

registerScopedService(
  LifecycleScope.Agent,
  ILeadTurnTimeoutService,
  LeadTurnTimeoutService,
  ScopeActivation.OnScopeCreated,
  'leadTurnTimeout',
);
