/**
 * `leadTurnTimeout` domain (L4) — main-agent lead-turn timeout contract.
 *
 * Team-mode mechanical guardrail: the main agent (tech-lead) must dispatch
 * work to subagents instead of doing it itself. This Agent-scoped service
 * watches the main agent's displayable user turns. Under `lead_turn_gate =
 * warn` it interrupts a turn whose active time exceeds the
 * `[subagent] lead_turn_timeout_ms` budget and — once the turn truly ends —
 * injects a "dispatch, don't do it yourself" reminder. Under `lead_turn_gate
 * = enforce` it replaces the interrupt with a code-layer hard block: the turn
 * is locked, execution-class tools are vetoed at the executor, and the lead
 * can only continue by dispatching / managing or by the user granting a fresh
 * budget window. Under `yolo` / `auto` permission modes the exhaustion response
 * is neither — the turn is re-armed with a fresh window of the same length and
 * a system warning is injected, so execution is never blocked. The pure decision
 * helpers here are the mechanical core of that block, kept side-effect free
 * for direct testing.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { LeadTurnGateMode } from '#/session/subagent/configSection';

export interface ILeadTurnTimeoutService {
  readonly _serviceBrand: undefined;
}

export const ILeadTurnTimeoutService: ServiceIdentifier<ILeadTurnTimeoutService> =
  createDecorator<ILeadTurnTimeoutService>('leadTurnTimeout');

/** Budget-accounting class of a tool call (see `classifyToolCall`). */
export type ToolCallClass = 'execution' | 'dispatch' | 'management' | 'wait-user';

/** Mutable lock state of an armed turn, as seen by the pure decision helper. */
export interface LeadTurnLockSnapshot {
  readonly locked: boolean;
  /** An ask was already rejected / timed out this lock episode (or grants are capped). */
  readonly asked: boolean;
  /** Grants consumed this turn (never resets within a turn). */
  readonly grantsUsed: number;
}

/**
 * Verdict for an execution-class tool call on a possibly-locked turn. `pass`
 * lets the call through; `block` vetoes it, and `ask` selects whether the
 * engine should first attempt the user re-authorization round-trip (only when
 * a grant is still available and an ask channel exists).
 */
export type LeadTurnExecutionDecision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'block'; readonly ask: boolean; readonly message: string };

/**
 * Decide whether an execution-class tool call is blocked by the lead-turn hard
 * gate. Pure function — no IO, no service access. Rules:
 *   - gate ≠ `enforce`, or the turn is not locked → pass;
 *   - non-execution classes (dispatch / management / wait-user) always pass,
 *     so the lead can still dispatch, manage, and ask the user while locked;
 *   - an execution-class call on a locked turn is blocked; `ask` is true only
 *     when a grant is still available (grantMs > 0, not yet asked this lock
 *     episode, grants under the per-turn cap) and an ask channel exists.
 */
export function decideExecutionBlock(params: {
  readonly mode: LeadTurnGateMode;
  readonly className: ToolCallClass;
  readonly locked: boolean;
  readonly asked: boolean;
  readonly grantsUsed: number;
  readonly grantMs: number;
  readonly maxGrants: number;
  readonly canAsk: boolean;
}): LeadTurnExecutionDecision {
  if (params.mode !== 'enforce' || !params.locked) return { kind: 'pass' };
  if (params.className !== 'execution') return { kind: 'pass' };
  const ask =
    params.canAsk &&
    params.grantMs > 0 &&
    !params.asked &&
    params.grantsUsed < params.maxGrants;
  return {
    kind: 'block',
    ask,
    message: ask
      ? 'Lead-turn budget exhausted — execution-class tools are blocked. Ask the user to extend the turn budget, or dispatch the work to team members instead of doing it yourself.'
      : 'Lead-turn budget exhausted — execution-class tools are blocked until the turn ends. Dispatch the work to team members instead of doing it yourself.',
  };
}

/** Budget state of an armed turn, as seen by the re-arm helper. */
export interface LeadTurnGrantSnapshot {
  readonly consumedMs: number;
  readonly locked: boolean;
  readonly asked: boolean;
  /** Lock/grant episode counter — bumped on every grant. */
  readonly epoch: number;
}

/**
 * Re-arm the turn's budget after a user grant. Pure function — the grant gives
 * a *fresh* window (`consumedMs` resets to 0, never stacks onto the exhausted
 * budget), clears the lock and the per-episode `asked` flag, and bumps the
 * episode counter. The per-turn `grantsUsed` cap is intentionally NOT reset:
 * grants are capped per turn.
 */
export function rearmState(state: LeadTurnGrantSnapshot): LeadTurnGrantSnapshot {
  return {
    consumedMs: 0,
    locked: false,
    asked: false,
    epoch: state.epoch + 1,
  };
}
