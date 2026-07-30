/**
 * `subagentPool` domain (L6) — `ISubagentPoolService` implementation.
 *
 * FIFO waiters: a dispatcher whose turn arrives while the pool is at capacity
 * parks until a slot is released or its signal aborts. Raising the runtime
 * limit drains waiting dispatchers while capacity allows; lowering it never
 * preempts running subagents. Bound at Session scope.
 */

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortError } from '#/_base/utils/abort';
import { IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';

import { resolveSwarmMaxConcurrency } from '../swarm/agentRunBatch';
import { SUBAGENT_SECTION, type SubagentConfig } from '../subagent/configSection';
import {
  ISubagentPoolService,
  type SubagentPoolLimitSource,
  type SubagentPoolState,
} from './subagentPool';

interface Waiter {
  readonly resolve: (slot: IDisposable) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  readonly signal: AbortSignal;
}

export class SubagentPoolService extends Disposable implements ISubagentPoolService {
  declare readonly _serviceBrand: undefined;

  private _active = 0;
  private readonly _waiters: Waiter[] = [];
  private _runtimeLimit: number | undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  async acquire(signal: AbortSignal): Promise<IDisposable> {
    signal.throwIfAborted();
    const limit = this._effectiveLimit().limit;
    if (limit === undefined || this._active < limit) {
      this._active++;
      return this._slot();
    }
    return new Promise<IDisposable>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this._waiters.indexOf(waiter);
          if (index >= 0) this._waiters.splice(index, 1);
          reject(signal.reason ?? abortError('Subagent pool wait aborted'));
        },
      };
      this._waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  setRuntimeLimit(value?: number): void {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`Subagent pool limit must be a positive integer, got ${JSON.stringify(value)}.`);
    }
    this._runtimeLimit = value;
    this._drain();
  }

  state(): SubagentPoolState {
    const { limit, source } = this._effectiveLimit();
    return { limit, limitSource: source, active: this._active, queued: this._waiters.length };
  }

  // ---------------------------------------------------------------------

  private _effectiveLimit(): { limit?: number; source: SubagentPoolLimitSource } {
    // Env wins, mirroring the batch cap's semantics. An invalid value must not
    // break state()/acquire() — warn and fall through (the AgentSwarm batch cap
    // still throws on its own resolve path, preserving existing behavior).
    try {
      const env = resolveSwarmMaxConcurrency();
      if (env !== undefined) return { limit: env, source: 'env' };
    } catch (error) {
      this.log.warn('[SubagentPool] invalid KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY ignored:', error);
    }
    if (this._runtimeLimit !== undefined) return { limit: this._runtimeLimit, source: 'runtime' };
    const configured = this.config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.maxConcurrency;
    if (configured !== undefined) return { limit: configured, source: 'config' };
    return { source: 'none' };
  }

  private _slot(): IDisposable {
    let released = false;
    return toDisposable(() => {
      if (released) return;
      released = true;
      this._active--;
      this._drain();
    });
  }

  /** Grant slots to queued waiters while capacity allows. */
  private _drain(): void {
    for (;;) {
      const limit = this._effectiveLimit().limit;
      if (limit !== undefined && this._active >= limit) return;
      const waiter = this._waiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason ?? abortError('Subagent pool wait aborted'));
        continue;
      }
      this._active++;
      waiter.resolve(this._slot());
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISubagentPoolService,
  SubagentPoolService,
  ScopeActivation.OnDemand,
  'subagentPool',
);
