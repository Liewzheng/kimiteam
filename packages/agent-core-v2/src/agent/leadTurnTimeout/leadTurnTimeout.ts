/**
 * `leadTurnTimeout` domain (L4) — main-agent lead-turn timeout contract.
 *
 * Team-mode mechanical guardrail: the main agent (tech-lead) must dispatch
 * work to subagents instead of doing it itself. This Agent-scoped service
 * watches the main agent's displayable user turns, interrupts a turn whose
 * active time exceeds the `[subagent] lead_turn_timeout_ms` budget, and once
 * the turn truly ends injects a "dispatch, don't do it yourself" reminder.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ILeadTurnTimeoutService {
  readonly _serviceBrand: undefined;
}

export const ILeadTurnTimeoutService: ServiceIdentifier<ILeadTurnTimeoutService> =
  createDecorator<ILeadTurnTimeoutService>('leadTurnTimeout');
