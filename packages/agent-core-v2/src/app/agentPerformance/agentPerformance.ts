/**
 * `agentPerformance` domain (L2) — subagent performance scoring.
 *
 * App-scope service that persists per-subagent-profile score history as a
 * single JSON document under `<homeDir>/agents/performance.json`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** One entry in the raw store — before any aggregation. */
export interface PerformanceEntry {
  readonly profileName: string;   // subagent profile name this score belongs to
  readonly ts: string;            // ISO-8601 timestamp
  readonly score: number;         // 0-100 integer
  readonly note: string;
  readonly model?: string;        // model id the member was using when scored
  readonly agentId?: string;
  readonly todoId?: string;       // the todo this score's delivery hung on
  readonly sessionId?: string;
}

/** A shift (toured work period) record attached to a profile bucket. */
export interface PerformanceShift {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly workSummary: string;
  readonly model?: string;
  readonly concurrency?: number;
  readonly agentId?: string;
  readonly sessionId?: string;
}

/** A profile bucket in the raw document — entries + shifts + a persisted byModel cache. */
export interface PerformanceBucket {
  entries: PerformanceEntry[];
  shifts?: PerformanceShift[];
  /**
   * Persisted per-model aggregate (count + score average), kept in sync on
   * every record/recordShift. Carried in the raw document so a reader of
   * `performance.json` itself (e.g. the main agent checking a member's
   * per-model breakdown per team-lead-doctrine) sees the same numbers as
   * `summary()`, which still recomputes from entries/shifts as the source of
   * truth. Legacy buckets written before this field existed are backfilled
   * lazily on the next read.
   */
  byModel?: Record<string, { count: number; average?: number }>;
}

/** Raw document shape stored in the atomic-document. */
export interface PerformanceRaw {
  [profileName: string]: PerformanceBucket;
}

/** Computed summary for one profile (the public API). */
export interface PerformanceSummary {
  readonly last?: number;
  readonly average?: number;
  readonly count: number;
  readonly avgDurationMs?: number;
  readonly byModel?: Record<string, { count: number; average?: number }>;
}

/** Output of `list()` — full array with profile name. */
export interface ProfilePerformanceEntry {
  readonly profileName: string;
  readonly summary: PerformanceSummary;
}

export interface IAgentPerformanceService {
  readonly _serviceBrand: undefined;

  /** Upsert a score entry (FIFO trim at 50). */
  record(entry: PerformanceEntry): Promise<void>;
  /** Record a shift (FIFO trim at 50). */
  recordShift(profileName: string, shift: PerformanceShift): Promise<void>;
  /** Read-only summary for one profile. */
  summary(profileName: string): Promise<PerformanceSummary>;
  /**
   * The most recent shift's duration for a profile, or `undefined` when it has
   * no recorded shifts. Read-only, over the FIFO shift bucket (newest last).
   * Purpose: load-weighted member selection — the duty scheduler weights a
   * candidate by how long its most recent shift ran (doctrine: "load (recent
   * shift duration + concurrency)"), which `summary().avgDurationMs` does not
   * give (that is an average over the whole bucket, not the recent shift).
   */
  recentShiftDurationMs(profileName: string): Promise<number | undefined>;
  /**
   * The most recent raw scores for a profile, newest last, capped at `limit`.
   * `summary()` only exposes aggregates, so distribution checks (e.g. score
   * inflation) read the raw FIFO bucket through this.
   */
  recentScores(profileName: string, limit: number): Promise<number[]>;
  /** Every stored profile's summary. */
  list(): Promise<ProfilePerformanceEntry[]>;
}

export const IAgentPerformanceService: ServiceIdentifier<IAgentPerformanceService> =
  createDecorator<IAgentPerformanceService>('agentPerformance');
