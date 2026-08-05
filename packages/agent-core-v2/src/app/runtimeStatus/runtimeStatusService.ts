/**
 * `runtimeStatus` domain (L2) — `IRuntimeStatusService` implementation.
 *
 * Stores per-subagent-profile runtime state as a single JSON document under
 * `<homeDir>/agents/runtime-status.json` (scope `'agents'`, key
 * `'runtime-status.json'`) — the same directory and storage pattern as
 * `performance.json`. Each write upserts the profile's single entry (latest
 * instance wins). On corrupt/missing data the service degrades to an empty
 * table and logs a warning — it must never break a subagent run. Write
 * failures are swallowed and logged (same policy as `recordShift`).
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import type {
  RosterSnapshot,
  RuntimeStatusEntry,
  RuntimeStatusRaw,
} from './runtimeStatus';
import { buildRosterSnapshot, IRuntimeStatusService } from './runtimeStatus';

const STORAGE_SCOPE = 'agents';
const STORAGE_KEY = 'runtime-status.json';

export class RuntimeStatusService implements IRuntimeStatusService {
  declare readonly _serviceBrand: undefined;

  /**
   * In-process serialisation queue for read-modify-write cycles, mirroring
   * `AgentPerformanceServiceImpl`. The atomic document store makes each write
   * atomic (tmp + rename) but its `acquire` is a no-op, so without this queue
   * two concurrent state transitions could lose one another's entry.
   * Cross-process lost updates remain possible and are accepted (advisory
   * data for the panel).
   */
  private _queue: Promise<void> = Promise.resolve();

  constructor(
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {}

  markWorking(profileName: string, agentId: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const raw = await this._readOrCreate();
        raw[profileName] = {
          state: 'working',
          agentId,
          updatedAt: new Date().toISOString(),
        };
        await this.store.set<RuntimeStatusRaw>(STORAGE_SCOPE, STORAGE_KEY, raw);
      } catch (error) {
        this.log.warn('runtime-status: failed to write working state', { profileName, agentId, error });
      }
    });
  }

  markResting(profileName: string, agentId: string, restExpiresAt: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const raw = await this._readOrCreate();
        raw[profileName] = {
          state: 'resting',
          agentId,
          updatedAt: new Date().toISOString(),
          restExpiresAt,
        };
        await this.store.set<RuntimeStatusRaw>(STORAGE_SCOPE, STORAGE_KEY, raw);
      } catch (error) {
        this.log.warn('runtime-status: failed to write resting state', { profileName, agentId, error });
      }
    });
  }

  removeProfile(profileName: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const raw = await this._readOrCreate();
        delete raw[profileName];
        await this.store.set<RuntimeStatusRaw>(STORAGE_SCOPE, STORAGE_KEY, raw);
      } catch (error) {
        this.log.warn('runtime-status: failed to remove profile entry', { profileName, error });
      }
    });
  }

  list(): Promise<RuntimeStatusRaw> {
    return this._readOrCreate();
  }

  roster(standbyKeepaliveMs: number, now: number = Date.now()): Promise<RosterSnapshot> {
    return this._readOrCreate().then((raw) => buildRosterSnapshot(raw, now, standbyKeepaliveMs));
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this._queue.then(op);
    // Keep the chain alive even when one write fails.
    this._queue = run.catch(() => {});
    return run;
  }

  private async _readOrCreate(): Promise<RuntimeStatusRaw> {
    const raw = await this.store.get<RuntimeStatusRaw>(STORAGE_SCOPE, STORAGE_KEY);
    if (raw === undefined) return {};
    if (typeof raw !== 'object' || raw === null) {
      this.log.warn('runtime-status: corrupt document replaced', { scope: STORAGE_SCOPE, key: STORAGE_KEY });
      return {};
    }
    // Validate each profile's entry shape; drop corrupted ones.
    const safe: RuntimeStatusRaw = {};
    for (const [profile, entry] of Object.entries(raw)) {
      if (entry && typeof entry === 'object' && typeof (entry as { state?: unknown }).state === 'string') {
        safe[profile] = entry as RuntimeStatusEntry;
      } else {
        this.log.warn('runtime-status: corrupt profile entry dropped', { profile });
      }
    }
    return safe;
  }
}

registerScopedService(
  LifecycleScope.App,
  IRuntimeStatusService,
  RuntimeStatusService,
  ScopeActivation.OnDemand,
  'runtimeStatus',
);

// Re-exports for consumers/tests that prefer a single entry point.
export type {
  RuntimeAgentState,
  RuntimeStatusEntry,
  RuntimeStatusRaw,
  RosterStatus,
  RosterMember,
  RosterSnapshot,
  IRuntimeStatusService,
} from './runtimeStatus';
export { buildRosterSnapshot, deriveRosterStatus } from './runtimeStatus';
