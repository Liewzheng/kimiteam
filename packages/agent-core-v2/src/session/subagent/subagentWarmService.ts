/**
 * `subagent` domain (L6) — docked-instance KV-cache warmer (keep-alive).
 *
 * Session-scoped helper owned by `SessionSubagentService`, mirroring the
 * `SubagentIdleReaper`'s Disposable+timer shape. After a subagent run settles
 * (success, failure, or cancellation) it starts a periodic timer (default 30
 * minutes, configurable via `[subagent] warm_interval_ms`, `0` disables) that
 * sends a zero-impact provider request on the parked instance's exact request
 * prefix — full context + system prompt + tool snapshot — with
 * `thinkingEffort: 'off'` and `maxCompletionTokens: 1`, then consumes and
 * discards the streamed output. The intent is to keep the provider-side
 * prompt cache of a long-resting instance from expiring so the next real
 * dispatch lands a cache hit (DeepSeek upstream TTL is hours-to-days, so the
 * warm is cheap insurance — ~170K prefix ≈ $0.0048/request).
 *
 * Zero perturbation by construction: the warm request goes straight to
 * `IModelCatalog.getRequester(model).request(...)` — it never appends to the
 * agent's context, never records usage, never touches the idle-reaper
 * countdown, and never enters the loop / permission / hook paths. Guarded: an
 * instance that is `running` or already removed is skipped; at most
 * {@link SubagentWarmService.MAX_IN_FLIGHT} warm requests are in flight
 * session-wide; a failed warm request is swallowed (logged at debug) and the
 * timer simply re-arms.
 *
 * The timer is cancelled the moment a new run starts on the instance
 * (`SessionSubagentService.run` cancels it), which also aborts any in-flight
 * warm for that instance through its per-instance `AbortController`. Cold
 * resume re-hangs the timer through {@link reconcile} (same pattern as the
 * idle reaper). All timers and controllers are cleared on disposal (session
 * close) — the service follows the `Disposable` convention of its owner.
 */

import { Disposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IRuntimeStatusService } from '#/app/runtimeStatus/runtimeStatus';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { Tool } from '#/kosong/contract/tool';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { resolveSubagentWarmIntervalMs } from './configSection';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

interface WarmTimerEntry {
  /** Profile the instance was armed under; used for reconcile diagnostics. */
  readonly profileName: string | undefined;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class SubagentWarmService extends Disposable {
  /** Session-wide cap on concurrently in-flight warm requests. */
  static readonly MAX_IN_FLIGHT = 2;

  private readonly timers = new Map<string, WarmTimerEntry>();
  private readonly controllers = new Map<string, AbortController>();
  private inFlight = 0;

  constructor(
    private readonly lifecycle: IAgentLifecycleService,
    private readonly status: IRuntimeStatusService,
    private readonly log: ILogService,
    private readonly config: IConfigService,
    private readonly modelCatalog: IModelCatalog,
  ) {
    super();
    this._register({
      dispose: () => {
        for (const entry of this.timers.values()) clearTimeout(entry.timeout);
        this.timers.clear();
        for (const controller of this.controllers.values()) controller.abort();
        this.controllers.clear();
      },
    });
  }

  /**
   * Start (or restart) the periodic warm timer for a resting instance. The
   * main agent is never warmed; `[subagent] warm_interval_ms` `0` disables.
   * Restarting cancels the previous timer and aborts any in-flight warm for
   * the instance (its context snapshot is stale the moment the run settles).
   */
  arm(agentId: string, profileName: string | undefined): void {
    if (agentId === MAIN_AGENT_ID) return;
    if (resolveSubagentWarmIntervalMs(this.config) <= 0) return;
    this.schedule(agentId, profileName);
  }

  /**
   * Re-hang a resting instance's warm timer after a cold resume (session was
   * restarted, so this service's in-process timers were all lost). Mirrors
   * the idle reaper's reconcile: reads the persisted runtime status; when a
   * `resting` entry references `agentId` and its idle horizon has not already
   * elapsed, the periodic timer is restarted at the full interval (warm is
   * periodic, not a remaining-TTL countdown). An entry that already elapsed
   * is left to the idle reaper to reap. Resolves once handled.
   */
  async reconcile(agentId: string): Promise<void> {
    if (agentId === MAIN_AGENT_ID) return;
    const raw = await this.status.list();
    for (const [profileName, entry] of Object.entries(raw)) {
      if (entry.state !== 'resting' || entry.agentId !== agentId) continue;
      const remainingMs = Date.parse(entry.restExpiresAt ?? '') - Date.now();
      if (Number.isFinite(remainingMs) && remainingMs > 0) {
        this.arm(agentId, profileName);
      }
      return;
    }
  }

  /** Cancel a pending warm timer and abort any in-flight warm for the instance. */
  cancel(agentId: string): void {
    const entry = this.timers.get(agentId);
    if (entry !== undefined) {
      clearTimeout(entry.timeout);
      this.timers.delete(agentId);
    }
    const controller = this.controllers.get(agentId);
    if (controller !== undefined) {
      controller.abort();
      this.controllers.delete(agentId);
    }
  }

  private schedule(agentId: string, profileName: string | undefined): void {
    // `cancel` aborts any previous in-flight warm before we mint the next
    // period's controller — so a stale warm can never outlive its instance's
    // new idle window, and the same-instance overlap stays bounded to one.
    this.cancel(agentId);
    const intervalMs = resolveSubagentWarmIntervalMs(this.config);
    if (intervalMs <= 0) return;
    this.controllers.set(agentId, new AbortController());
    const timeout = setTimeout(() => this.onTimerFired(agentId), intervalMs);
    this.timers.set(agentId, { profileName, timeout });
  }

  private onTimerFired(agentId: string): void {
    const entry = this.timers.get(agentId);
    this.timers.delete(agentId);
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) return; // already removed — stop; nothing re-arms
    if (this.loopState(handle) === 'running') return; // running — settle re-hangs
    // Re-arm for the next period up front so the cadence stays fixed regardless
    // of the warm request's duration; the fire below is skipped when the
    // session-wide in-flight budget is exhausted.
    this.schedule(agentId, entry?.profileName);
    if (this.inFlight >= SubagentWarmService.MAX_IN_FLIGHT) {
      this.log.debug('subagent warm skipped — in-flight budget full', { agentId });
      return;
    }
    this.inFlight += 1;
    void this.warm(agentId, entry?.profileName)
      .catch(() => { /* swallow — a failed warm never surfaces */ })
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  private async warm(agentId: string, profileName: string | undefined): Promise<void> {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) return; // removed while we waited
    const signal = this.controllers.get(agentId)?.signal;
    if (signal === undefined || signal.aborted) return; // cancelled
    // Final guard right before the request: a turn woken outside `run` (e.g. a
    // TeamMessage inject) between the timer fire and now must not be disturbed.
    if (this.loopState(handle) === 'running') return;

    const messages = this.snapshotMessages(handle);
    if (messages === undefined || messages.length === 0) return; // no prefix to keep warm
    const input = this.buildWarmRequest(handle);
    if (input === undefined) return; // model / system prompt / tools unavailable

    this.log.debug('subagent warm: sending keep-alive request', {
      agentId,
      profileName,
      messageCount: messages.length,
      model: input.model,
    });
    try {
      // Consume and discard — the warm output is thrown away. Nothing here
      // appends context, records usage, touches the idle reaper, or enters
      // the loop / permission / hook paths.
      for await (const _event of this.modelCatalog.getRequester(input.model).request(
        { systemPrompt: input.systemPrompt, tools: input.tools, messages },
        signal,
        {
          cacheKey: input.cacheKey,
          thinkingEffort: 'off',
          maxCompletionTokens: 1,
        },
      )) {
        // discard
      }
    } catch (error) {
      // Never surface — a failed warm is a missed cache refresh, not an error.
      this.log.debug('subagent warm failed', { agentId, profileName, error });
    }
  }

  private loopState(handle: IAgentScopeHandle): 'idle' | 'running' {
    try {
      return handle.accessor.get(IAgentLoopService).status().state;
    } catch {
      return 'running'; // scope not materialized — treat as busy and skip
    }
  }

  private snapshotMessages(handle: IAgentScopeHandle): readonly ContextMessage[] | undefined {
    try {
      return handle.accessor.get(IAgentContextMemoryService).get();
    } catch {
      return undefined;
    }
  }

  private buildWarmRequest(
    handle: IAgentScopeHandle,
  ): {
    readonly model: string;
    readonly systemPrompt: string;
    readonly tools: readonly Tool[];
    readonly cacheKey: string | undefined;
  } | undefined {
    try {
      const profile = handle.accessor.get(IAgentProfileService);
      const model = profile.resolveModelContext().modelAlias;
      if (model === undefined) return undefined;
      const systemPrompt = profile.getSystemPrompt();
      const cacheKey = profile.resolveRequestParams().cacheKey;
      const tools = handle.accessor.get(IAgentToolRegistryService).list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        ...(tool.disclosure === 'deferred' ? { deferred: true as const } : {}),
      }));
      return { model, systemPrompt, tools, cacheKey };
    } catch {
      return undefined;
    }
  }
}
