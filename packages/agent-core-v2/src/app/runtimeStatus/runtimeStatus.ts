/**
 * `runtimeStatus` domain (L2) — per-profile subagent runtime state for the
 * team panel.
 *
 * App-scope service that persists the latest working/resting state of each
 * subagent profile as a single JSON document under
 * `<homeDir>/agents/runtime-status.json` (scope `'agents'`, key
 * `'runtime-status.json'`), in the same directory as `performance.json`.
 * Profile-granular: when several instances of the same profile coexist only
 * the most recently updated one is kept — the panel reads at profile
 * granularity and does not need per-instance history. Written by the
 * session-scope idle supervisor at run start (`working`), run settle
 * (`resting` + idle expiry) and reap (entry removed). Write failures are
 * swallowed and logged — they must never block a subagent run.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** Whether a profile's latest subagent instance is engaged or parked idle. */
export type RuntimeAgentState = 'working' | 'resting';

export interface RuntimeStatusEntry {
  readonly state: RuntimeAgentState;
  /** The agent instance behind this state. */
  readonly agentId: string;
  /** ISO-8601 timestamp of the last state transition. */
  readonly updatedAt: string;
  /** ISO-8601 idle-expiry timestamp; present only when `state === 'resting'`. */
  readonly restExpiresAt?: string;
}

/** Raw document shape stored in the atomic document. */
export type RuntimeStatusRaw = Record<string, RuntimeStatusEntry>;

export interface IRuntimeStatusService {
  readonly _serviceBrand: undefined;

  /** Record a run starting on `agentId` for `profileName` (state `working`). */
  markWorking(profileName: string, agentId: string): Promise<void>;

  /**
   * Record the profile's latest instance settling into idle (state `resting`)
   * with the given idle-expiry timestamp.
   */
  markResting(profileName: string, agentId: string, restExpiresAt: string): Promise<void>;

  /** Drop the profile's entry — its instance was reaped (went off duty). */
  removeProfile(profileName: string): Promise<void>;
}

export const IRuntimeStatusService: ServiceIdentifier<IRuntimeStatusService> =
  createDecorator<IRuntimeStatusService>('runtimeStatus');
