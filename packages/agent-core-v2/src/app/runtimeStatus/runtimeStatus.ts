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
 *
 * The persisted document keeps exactly two states (`working` / `resting`) and
 * is never migrated. `standby` is a *derived* state computed on read by
 * {@link deriveRosterStatus}: a `resting` entry whose settle time
 * (`updatedAt`) falls within the standby keep-alive window of `now` (the
 * resolved `[subagent] standby_keepalive_ms`) is treated as `standby` — a
 * freshly rested instance with a warm cache, before it drops to plain
 * `resting` and runs the existing idle TTL. {@link buildRosterSnapshot}
 * synthesises the read-only roster (who is
 * working/standby/resting/off-duty) for the panel and the scheduler; see
 * {@link IRuntimeStatusService.roster}.
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

/**
 * Four-state roster classification. `working` (engaged) > `standby` (resting,
 * within the keep-alive window — warm / grab-now) > `resting` (parked, beyond
 * the keep-alive window — long-horizon, still parked) > `off-duty` (rest
 * horizon passed — pending reap, or absent from the table).
 */
export type RosterStatus = 'working' | 'standby' | 'resting' | 'off-duty';

/** One profile's roster row — the raw persisted entry plus its derived status. */
export interface RosterMember {
  readonly profileName: string;
  readonly status: RosterStatus;
  /** The raw persisted entry; absent for profiles not present in the table. */
  readonly entry?: RuntimeStatusEntry;
}

/** Read-only roster snapshot synthesised from the runtime status table. */
export interface RosterSnapshot {
  /** ISO-8601 timestamp of the snapshot moment (the `now` used for derivation). */
  readonly at: string;
  /** The keep-alive window applied for the `standby` derivation (ms). */
  readonly standbyKeepaliveMs: number;
  /** Profiles currently engaged. */
  readonly working: readonly RosterMember[];
  /** Profiles resting with settle time (`updatedAt`) within the keep-alive window. */
  readonly standby: readonly RosterMember[];
  /** Profiles parked beyond the keep-alive window (long-horizon). */
  readonly resting: readonly RosterMember[];
  /**
   * Profiles whose rest horizon has passed (or malformed resting entries) —
   * off duty and pending reap.
   */
  readonly offDuty: readonly RosterMember[];
  /** Every classified member, profile-name sorted, for iteration. */
  readonly members: readonly RosterMember[];
  /** Convenience map: profileName → derived status for the present profiles. */
  readonly statusByProfile: Readonly<Record<string, RosterStatus>>;
}

/**
 * Derive the four-state roster status of a persisted entry. Pure — no I/O, no
 * config dependency: the caller passes the keep-alive window and the clock.
 *
 * - `working` → `working`.
 * - `resting` whose settle time (`updatedAt`) is within the keep-alive window
 *   of `now` (`now - updatedAt <= standbyKeepaliveMs`) → `standby` — freshly
 *   rested, warm cache, grab-now. Once the window elapses it drops to
 *   `resting` (long-horizon, runs the existing idle TTL).
 * - `resting` whose `restExpiresAt` has passed, or that has no valid
 *   `restExpiresAt` (malformed), or whose `updatedAt` is unparseable
 *   (corrupt) → `off-duty` — the instance should have been reaped; the roster
 *   surfaces it as off duty rather than pretending it is available.
 *
 * The rest-horizon (`restExpiresAt`) check wins over freshness: a resting
 * entry that settled within the window but whose expiry already passed is
 * still `off-duty` (pending reap), never `standby`.
 *
 * With `standbyKeepaliveMs === 0` no resting entry is ever derived `standby`
 * (a zero-length window), which is the intended "disable standby" shape.
 */
export function deriveRosterStatus(
  entry: RuntimeStatusEntry | undefined,
  now: number,
  standbyKeepaliveMs: number,
): RosterStatus {
  if (entry === undefined) return 'off-duty';
  if (entry.state === 'working') return 'working';
  if (entry.state !== 'resting') return 'off-duty';
  // Rest horizon: expired or malformed → off duty (pending reap).
  const expires = Date.parse(entry.restExpiresAt ?? '');
  if (!Number.isFinite(expires) || expires <= now) return 'off-duty';
  // Keepalive window measured from settle time (`updatedAt`): a freshly
  // rested instance (warm cache) is standby; beyond the window it drops to
  // plain resting and runs the existing idle TTL to off-duty.
  const settled = Date.parse(entry.updatedAt ?? '');
  if (!Number.isFinite(settled)) return 'off-duty'; // corrupt settle time
  return now - settled <= standbyKeepaliveMs ? 'standby' : 'resting';
}

/**
 * Synthesise the read-only roster snapshot from the raw status table. Pure —
 * the caller supplies the clock and the resolved `[subagent]
 * standby_keepalive_ms`. Profiles are emitted profile-name sorted; members
 * absent from the table are not enumerated (they are off duty by absence).
 */
export function buildRosterSnapshot(
  raw: RuntimeStatusRaw,
  now: number,
  standbyKeepaliveMs: number,
): RosterSnapshot {
  const names = Object.keys(raw).sort();
  const members: RosterMember[] = [];
  const statusByProfile: Record<string, RosterStatus> = {};
  const working: RosterMember[] = [];
  const standby: RosterMember[] = [];
  const resting: RosterMember[] = [];
  const offDuty: RosterMember[] = [];
  for (const profileName of names) {
    const entry = raw[profileName];
    const status = deriveRosterStatus(entry, now, standbyKeepaliveMs);
    const member: RosterMember = { profileName, status, entry };
    members.push(member);
    statusByProfile[profileName] = status;
    (status === 'working' ? working : status === 'standby' ? standby : status === 'resting' ? resting : offDuty)
      .push(member);
  }
  return {
    at: new Date(now).toISOString(),
    standbyKeepaliveMs,
    working,
    standby,
    resting,
    offDuty,
    members,
    statusByProfile,
  };
}

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

  /**
   * Read the current runtime status table (profile name → latest entry).
   * Pure read: never writes or repairs — degrades to `{}` when the document
   * is absent or corrupt (same policy as the writers' read helper).
   */
  list(): Promise<RuntimeStatusRaw>;

  /**
   * Read-only roster snapshot: who is working / standby / resting / off-duty,
   * derived from the persisted table at `now` with the given keep-alive
   * window (`[subagent] standby_keepalive_ms`). Pure read — never writes or
   * repairs the stored document. Consumers resolve the window via
   * {@link resolveSubagentStandbyKeepaliveMs} (the panel and the duty
   * scheduler both read config already); `now` defaults to `Date.now()`.
   */
  roster(standbyKeepaliveMs: number, now?: number): Promise<RosterSnapshot>;
}

export const IRuntimeStatusService: ServiceIdentifier<IRuntimeStatusService> =
  createDecorator<IRuntimeStatusService>('runtimeStatus');
