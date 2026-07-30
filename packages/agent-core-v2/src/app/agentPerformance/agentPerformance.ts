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
  readonly agentId?: string;
  readonly sessionId?: string;
}

/** Raw document shape stored in the atomic-document. */
export interface PerformanceRaw {
  [profileName: string]: { entries: PerformanceEntry[] };
}

/** Computed summary for one profile (the public API). */
export interface PerformanceSummary {
  readonly last?: number;
  readonly average?: number;
  readonly count: number;
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
  /** Read-only summary for one profile. */
  summary(profileName: string): Promise<PerformanceSummary>;
  /** Every stored profile's summary. */
  list(): Promise<ProfilePerformanceEntry[]>;
}

export const IAgentPerformanceService: ServiceIdentifier<IAgentPerformanceService> =
  createDecorator<IAgentPerformanceService>('agentPerformance');
