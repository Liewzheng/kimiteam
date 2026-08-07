/**
 * `subagent` domain — `ISessionSubagentService` contract: driving turns
 * on other agents, plus the hook / event surface those runs announce.
 *
 * Owns *runs* — one agent driving a turn on another and the requester-side
 * announcements that come with it. The `onWillStartAgentTask` hook slot and
 * the `onDidStopAgentTask` event announce a run's start and stop so observers
 * can translate them into the `SubagentStart` / `SubagentStop` external hook
 * commands. Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { Turn } from '#/agent/loop/loop';
import type { Hooks } from '#/hooks';

export type AgentRunRequest =
  | { readonly kind: 'prompt'; readonly prompt: string }
  | { readonly kind: 'retry'; readonly trigger?: string };

export interface RunAgentOptions {
  readonly signal: AbortSignal;
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
  readonly onReady?: () => void;
}

export interface AgentRunHandle {
  readonly agentId: string;
  readonly turn: Turn;
  readonly completion: Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
}

export interface AgentTaskStartHookContext {
  readonly agentName: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface AgentTaskStopHookContext {
  readonly agentName: string;
  readonly response: string;
}

/**
 * A supervised subagent run settled (success, failure, timeout, or
 * TaskStop-style cancellation). Fired at the same run-completion point that
 * drives the unscored-score reminder and the PerformanceShift `endedAt`, so
 * per-member evidence windows (e.g. the TeamScore acceptance gate) can anchor
 * on the delivery-completion moment.
 */
export interface RunSettledContext {
  readonly agentId: string;
  /** The subagent profile the settled run belonged to. */
  readonly profileName: string;
}

export type AgentTaskHooks = {
  readonly onWillStartAgentTask: AgentTaskStartHookContext;
};

export interface ISessionSubagentService {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<AgentTaskHooks>;

  readonly onDidStopAgentTask: Event<AgentTaskStopHookContext>;

  /** Fired when a supervised subagent run settles (see `RunSettledContext`). */
  readonly onDidRunSettle: Event<RunSettledContext>;

  run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle>;

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void;
}

export const ISessionSubagentService: ServiceIdentifier<ISessionSubagentService> =
  createDecorator<ISessionSubagentService>('sessionSubagentService');
