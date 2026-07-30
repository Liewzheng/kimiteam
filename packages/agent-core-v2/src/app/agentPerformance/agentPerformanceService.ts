/**
 * `agentPerformance` domain (L2) - IAgentPerformanceServiceImpl.
 *
 * Stores per-subagent-profile score history as a single JSON document under
 * `<homeDir>/agents/performance.json` (scope `'agents'`, key `'performance.json'`).
 * On corrupt/missing data the service degrades to an empty table and logs a
 * warning - it must not break session bootstrap.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import type { PerformanceEntry, PerformanceRaw } from './agentPerformance';
import { IAgentPerformanceService } from './agentPerformance';
import type { PerformanceSummary, ProfilePerformanceEntry } from './agentPerformance';

const STORAGE_SCOPE = 'agents';
const STORAGE_KEY = 'performance.json';
const MAX_ENTRIES_PER_PROFILE = 50;

export class AgentPerformanceServiceImpl implements IAgentPerformanceService {
  declare readonly _serviceBrand: undefined;

  /**
   * In-process serialisation queue for read-modify-write cycles. The atomic
   * document store makes each individual write atomic (temp + rename) but its
   * `acquire` is a no-op, so without this queue two concurrent `record` calls
   * could lose one another's entries. Cross-process lost updates remain
   * possible and are accepted (scores are advisory data).
   */
  private _queue: Promise<void> = Promise.resolve();

  constructor(
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {}

  async record(entry: PerformanceEntry): Promise<void> {
    const run = this._queue.then(() => this._record(entry));
    // Keep the chain alive even when one record fails.
    this._queue = run.catch(() => {});
    return run;
  }

  private async _record(entry: PerformanceEntry): Promise<void> {
    const raw = (await this._readOrCreate()) as PerformanceRaw;
    const bucketKey = entry.profileName;
    if (!raw[bucketKey]) {
      raw[bucketKey] = { entries: [] };
    }
    // Each stored entry carries profileName (self-describing data).
    raw[bucketKey].entries.push({ ...entry });
    while (raw[bucketKey].entries.length > MAX_ENTRIES_PER_PROFILE) {
      raw[bucketKey].entries.shift();
    }
    await this.store.set<PerformanceRaw>(STORAGE_SCOPE, STORAGE_KEY, raw);
  }

  async summary(profileName: string): Promise<PerformanceSummary> {
    const raw = (await this._readOrCreate()) as PerformanceRaw;
    const entries = raw[profileName]?.entries;
    if (!entries || entries.length === 0) {
      return { count: 0 };
    }
    return this._computeSummary(entries);
  }

  async list(): Promise<ProfilePerformanceEntry[]> {
    const raw = (await this._readOrCreate()) as PerformanceRaw;
    const keys = Object.keys(raw);
    return Promise.all(
      keys.map(async (profileName) => ({
        profileName,
        summary: await this.summary(profileName),
      })),
    );
  }

  private async _readOrCreate(): Promise<PerformanceRaw> {
    const raw = await this.store.get<PerformanceRaw>(STORAGE_SCOPE, STORAGE_KEY);
    if (raw === undefined) {
      return {};
    }
    if (typeof raw !== 'object' || raw === null) {
      this.log.warn('agent-performance: corrupt document replaced', { scope: STORAGE_SCOPE, key: STORAGE_KEY });
      return {};
    }
    // Validate each profile's shape; drop corrupted ones.
    const safeRaw = {} as PerformanceRaw;
    for (const [profile, bucket] of Object.entries(raw)) {
      if (!bucket || typeof bucket !== 'object' || !Array.isArray((bucket as any).entries)) {
        this.log.warn('agent-performance: corrupt profile data dropped', { profile });
        continue;
      }
      safeRaw[profile] = bucket;
    }
    return safeRaw;
  }

  private _computeSummary(entries: PerformanceEntry[]): PerformanceSummary {
    const scores = entries.map((e) => e.score);
    if (scores.length === 0) return { count: 0 };
    const avg = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));
    return { last: scores[scores.length - 1], average: avg, count: scores.length };
  }
}


registerScopedService(
  LifecycleScope.App,
  IAgentPerformanceService,
  AgentPerformanceServiceImpl,
  ScopeActivation.OnDemand,
  'agentPerformance',
);

// Re-exports for consumers/tests that prefer a single entry point.
export type { PerformanceEntry, PerformanceRaw, PerformanceSummary, ProfilePerformanceEntry, IAgentPerformanceService } from './agentPerformance';

