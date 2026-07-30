/**
 * `subagentPool` domain (L6) — `ISubagentPoolService` contract.
 *
 * A session-wide slot pool capping how many subagent runs may be active at
 * once. `ISessionSubagentService.run` acquires a slot before starting a turn
 * and releases it when the run's completion settles, so every dispatch path —
 * the `Agent` tool's single spawn, `AgentSwarm` batches, resumes and retries —
 * shares the same ceiling. The effective limit resolves as:
 * `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (env) > a runtime override set via
 * the `TeamConcurrency` tool > `[subagent] max_concurrency` > unlimited.
 * Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export type SubagentPoolLimitSource = 'env' | 'runtime' | 'config' | 'none';

export interface SubagentPoolState {
  /** Effective limit; `undefined` means unlimited. */
  readonly limit?: number;
  readonly limitSource: SubagentPoolLimitSource;
  /** Slots currently held by running subagents. */
  readonly active: number;
  /** Dispatchers waiting for a slot. */
  readonly queued: number;
}

export interface ISubagentPoolService {
  readonly _serviceBrand: undefined;

  /**
   * Take a slot, waiting (abortably via `signal`) while the pool is at
   * capacity. Dispose the returned handle exactly once to release the slot.
   */
  acquire(signal: AbortSignal): Promise<IDisposable>;

  /**
   * Set a session-runtime limit override (the `TeamConcurrency` tool's `set`).
   * `undefined` clears the override. Lowering the limit below the active count
   * never preempts running subagents — it only stops new grants.
   */
  setRuntimeLimit(value?: number): void;

  /** Snapshot of the effective limit, its source, and occupancy. */
  state(): SubagentPoolState;
}

export const ISubagentPoolService: ServiceIdentifier<ISubagentPoolService> =
  createDecorator<ISubagentPoolService>('subagentPoolService');
