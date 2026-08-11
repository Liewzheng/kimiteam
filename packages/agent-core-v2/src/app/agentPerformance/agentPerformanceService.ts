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

import type { PerformanceEntry, PerformanceRaw, PerformanceShift } from './agentPerformance';
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
    const raw = (await this._readRaw()) as PerformanceRaw;
    const bucketKey = entry.profileName;
    if (!raw[bucketKey]) {
      raw[bucketKey] = { entries: [] };
    }
    // Each stored entry carries profileName (self-describing data).
    raw[bucketKey].entries.push({ ...entry });
    while (raw[bucketKey].entries.length > MAX_ENTRIES_PER_PROFILE) {
      raw[bucketKey].entries.shift();
    }
    // Keep the persisted per-model aggregate in sync — recomputed from the
    // whole (already-trimmed) bucket, so existing entries with a model are
    // backfilled too and history is never lost.
    raw[bucketKey].byModel = this._computeByModel(raw[bucketKey].entries, raw[bucketKey].shifts);
    await this.store.set<PerformanceRaw>(STORAGE_SCOPE, STORAGE_KEY, raw);
  }

  async recordShift(profileName: string, shift: PerformanceShift): Promise<void> {
    const run = this._queue.then(() => this._recordShift(profileName, shift));
    this._queue = run.catch(() => {});
    return run;
  }

  private async _recordShift(profileName: string, shift: PerformanceShift): Promise<void> {
    const raw = (await this._readRaw()) as PerformanceRaw;
    if (!raw[profileName]) {
      raw[profileName] = { entries: [], shifts: [shift] };
    } else {
      if (!raw[profileName].shifts) {
        raw[profileName].shifts = [];
      }
      raw[profileName].shifts!.push({ ...shift });
      while (raw[profileName].shifts!.length > MAX_ENTRIES_PER_PROFILE) {
        raw[profileName].shifts!.shift();
      }
    }
    // Same sync rule as `_record`: shift-only models surface in byModel with a
    // count and no score average; existing model-bearing entries backfill in.
    raw[profileName].byModel = this._computeByModel(raw[profileName].entries, raw[profileName].shifts);
    await this.store.set<PerformanceRaw>(STORAGE_SCOPE, STORAGE_KEY, raw);
  }

  async summary(profileName: string): Promise<PerformanceSummary> {
    const raw = await this._readWithBackfill();
    const bucket = raw[profileName];
    if (bucket === undefined) {
      return { count: 0 };
    }
    return this._computeSummary(bucket.entries, bucket.shifts);
  }

  async recentScores(profileName: string, limit: number): Promise<number[]> {
    const raw = await this._readWithBackfill();
    const bucket = raw[profileName];
    if (bucket === undefined) return [];
    return bucket.entries.slice(-limit).map((entry) => entry.score);
  }

  async recentShiftDurationMs(profileName: string): Promise<number | undefined> {
    const raw = await this._readWithBackfill();
    const shifts = raw[profileName]?.shifts;
    if (shifts === undefined || shifts.length === 0) return undefined;
    // FIFO trim pushes newest to the tail, so the last shift is the most recent.
    return shifts.at(-1)?.durationMs;
  }

  async list(): Promise<ProfilePerformanceEntry[]> {
    const raw = await this._readWithBackfill();
    const keys = Object.keys(raw);
    return Promise.all(
      keys.map(async (profileName) => ({
        profileName,
        summary: await this.summary(profileName),
      })),
    );
  }

  private async _readRaw(): Promise<PerformanceRaw> {
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

  /**
   * Read path: acquire the document through the serialization queue so a
   * one-time byModel backfill can never race a concurrent
   * record()/recordShift() read-modify-write (which would otherwise risk
   * losing an entry). The persist is best-effort — a failed cache write must
   * not fail the read, since summary() recomputes byModel from entries/shifts
   * as the source of truth.
   */
  private _readWithBackfill(): Promise<PerformanceRaw> {
    const run = this._queue.then(async () => {
      const raw = await this._readRaw();
      if (this._backfillInto(raw)) {
        try {
          await this.store.set<PerformanceRaw>(STORAGE_SCOPE, STORAGE_KEY, raw);
        } catch (err) {
          this.log.warn('agent-performance: byModel backfill write failed', { error: String(err) });
        }
      }
      return raw;
    });
    // Keep the chain typed as Promise<void> (the queue only serializes).
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  /**
   * One-time lazy migration for legacy buckets whose persisted byModel is
   * missing or stale (e.g. written before byModel was persisted, or an empty
   * `{}` left by the old writer while entries carry models). Recomputes from
   * entries + shifts and rewrites only on a real diff. Entries/shifts
   * themselves are never touched — history is preserved.
   */
  private _backfillInto(raw: PerformanceRaw): boolean {
    let dirty = false;
    for (const bucket of Object.values(raw)) {
      const byModel = this._computeByModel(bucket.entries, bucket.shifts);
      if (byModel === undefined) continue; // no model attribution → nothing to backfill
      if (!this._byModelEquals(bucket.byModel, byModel)) {
        bucket.byModel = byModel;
        dirty = true;
      }
    }
    return dirty;
  }

  /** Structural equality for persisted byModel — key order irrelevant. */
  private _byModelEquals(
    a: Record<string, { count: number; average?: number }> | undefined,
    b: Record<string, { count: number; average?: number }> | undefined,
  ): boolean {
    if (a === undefined || b === undefined) return a === b;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      const av = a[key];
      const bv = b[key];
      if (av === undefined || bv === undefined) return false;
      if (av.count !== bv.count || av.average !== bv.average) return false;
    }
    return true;
  }

  /**
   * Per-model aggregate from raw entries + shifts: `count` merges score entries
   * and shift records, `average` covers only score entries (rounded to 1
   * decimal). Returns `undefined` when no entry/shift carries a model. This is
   * the single aggregation point shared by `summary()` (recomputed) and the
   * persisted cache (written on record/recordShift, backfilled on read).
   */
  private _computeByModel(
    entries: PerformanceEntry[],
    shifts?: PerformanceShift[],
  ): Record<string, { count: number; average?: number }> | undefined {
    const modelMap = new Map<string, { scoreSum: number; scoreCount: number; shiftCount: number }>();
    for (const e of entries) {
      if (e.model) {
        let m = modelMap.get(e.model);
        if (!m) { m = { scoreSum: 0, scoreCount: 0, shiftCount: 0 }; modelMap.set(e.model, m); }
        m.scoreSum += e.score;
        m.scoreCount += 1;
      }
    }
    if (shifts) {
      for (const s of shifts) {
        if (s.model) {
          let m = modelMap.get(s.model);
          if (!m) { m = { scoreSum: 0, scoreCount: 0, shiftCount: 0 }; modelMap.set(s.model, m); }
          m.shiftCount += 1;
        }
      }
    }
    if (modelMap.size === 0) return undefined;
    const byModel: Record<string, { count: number; average?: number }> = {};
    for (const [model, data] of modelMap) {
      byModel[model] = {
        count: data.scoreCount + data.shiftCount,
        average: data.scoreCount > 0 ? Number((data.scoreSum / data.scoreCount).toFixed(1)) : undefined,
      };
    }
    return byModel;
  }

  private _computeSummary(entries: PerformanceEntry[], shifts?: PerformanceShift[]): PerformanceSummary {
    // Shift-derived aggregates are computed even without any scores — a member
    // can have worked shifts before receiving its first score.
    let avgDurationMs: number | undefined;
    if (shifts && shifts.length > 0) {
      const total = shifts.reduce((a, b) => a + b.durationMs, 0);
      avgDurationMs = Number((total / shifts.length).toFixed(1));
    }

    // byModel aggregation — recomputed from entries + shifts as the source of
    // truth, never trusting the persisted cache in the raw doc.
    const byModel = this._computeByModel(entries, shifts);

    const scores = entries.map((e) => e.score);
    if (scores.length === 0) return { count: 0, avgDurationMs, byModel };
    const avg = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));

    return { last: scores[scores.length - 1], average: avg, count: scores.length, avgDurationMs, byModel };
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
export type {
  PerformanceEntry, PerformanceRaw, PerformanceShift, PerformanceSummary,
  ProfilePerformanceEntry, IAgentPerformanceService,
} from './agentPerformance';

