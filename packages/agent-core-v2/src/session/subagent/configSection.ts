/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms` on disk) together
 * with the `KIMI_SUBAGENT_TIMEOUT_MS` env override (precedence: env >
 * config.toml > 2h default). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Per-run
 * timeouts resolve through `resolveSubagentTimeoutMs`, and the timeout
 * message renders with `formatSubagentTimeoutDescription`. The run-duration
 * alert threshold (`run_alert_ms`, default 15 min) follows the same shape,
 * with its own `KIMI_SUBAGENT_RUN_ALERT_MS` env override (`0` disables).
 *
 * Team mode resolves through `resolveTeamMode` with precedence: an explicit
 * `[subagent] team_mode` value wins, then the `KIMI_CODE_TEAM_MODE` env var
 * (set to `1` by the kimiteam launcher so the team build starts in team
 * mode), then off. `teamMode` has no `envBindings` entry — the env default
 * lives outside the config file, so `/team off` and the web toggle persist
 * `team_mode = false` and override the env until the value is cleared.
 *
 * The model half of the spawn binding is the secondary model (the
 * `[secondary_model]` section on disk): when its
 * experiment is enabled and the model is set, newly spawned subagents bind to
 * it by default instead of inheriting the caller's model, and the
 * `Agent`/`AgentSwarm` tools let the parent model pick per spawn via their
 * `model` parameter. When unset, spawning behavior is unchanged (subagents
 * inherit the caller's model). A recipe with patch fields binds the
 * synthesized derived entry (`SECONDARY_DERIVED_MODEL_ID`); a pointer-only
 * recipe binds the pointed entry directly. `default_effort` is passed as the
 * explicit subagent thinking; without it the subagent resolves thinking
 * naturally (global thinking config → the bound model's default effort)
 * rather than inheriting the caller's level. Both tools resolve spawn
 * bindings through `resolveSubagentBinding`, advertise the pair via
 * `buildSubagentModelDescriptions` (each line suffixed with the entry's
 * resolved capability flags, so the parent can route multimodal or
 * thinking-heavy subagent tasks instead of guessing from the model id),
 * and wrap spawn failures with
 * `wrapSubagentModelError`; while the experiment is off they also strip the
 * no-op `model` parameter from their advertised schemas via
 * `stripSubagentModelParameter`. Self-registered at module load via
 * `registerConfigSection`.
 */

import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { AgentModelPreference, AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { isPlainObject } from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  MODELS_SECTION,
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';
import { type SecondaryModelConfig } from '#/app/kosongConfig/configSection';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
  /**
   * Session-wide cap on concurrently running subagents (`[subagent]
   * max_concurrency` on disk). Enforced by the subagent pool for every
   * dispatch path (Agent, AgentSwarm, resume, retry). The
   * `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` env var and the runtime override
   * set via the `TeamConcurrency` tool both take precedence over this value.
   */
  maxConcurrency: z.number().int().min(1).optional(),
  /**
   * Team mode (`[subagent] team_mode` on disk). When off, the
   * five Team* management tools (TeamHire/TeamFire/TeamScore/TeamMessage/
   * TeamConcurrency) are hidden from the main agent's tool list by the tool
   * policy. Only tool visibility is gated — model binding, item_models,
   * model_overrides, role/duty profile fields work regardless. An explicit
   * value wins over the `KIMI_CODE_TEAM_MODE` env default (see
   * `resolveTeamMode`).
   */
  teamMode: z.boolean().optional(),
  /**
   * Team-mode idle TTL (`[subagent] idle_ttl_ms` on disk, default 2 hours).
   * Inline models keep warm KV-caches for minutes to hours and parked
   * instances hold no local resources, so the default horizon is long; the
   * value is configurable per install.
   */
  idleTtlMs: z.number().int().min(1).optional(),
  /**
   * Team auto-initiative (`[subagent] team_auto` on disk, default off): when
   * on and the main agent has been idle past `auto_idle_ms`, the engine
   * injects a proactive "review the project and apply one bounded improvement"
   * prompt (strategy / documentation / process).
   */
  teamAuto: z.boolean().optional(),
  /**
   * Idle threshold for team auto-initiative (`[subagent] auto_idle_ms` on
   * disk, default 300_000 ms = 5 min; `0` disables the idle trigger).
   */
  autoIdleMs: z.number().int().min(0).optional(),
  /**
   * Lead-turn timeout (`[subagent] lead_turn_timeout_ms` on disk, default
   * 30_000; `0` disables). In team mode the main agent's user turn is
   * interrupted once its active time exceeds this budget, nudging the
   * tech-lead to dispatch work to team members instead of doing it itself.
   */
  leadTurnTimeoutMs: z.number().int().min(0).optional(),
  /**
   * Lead-turn enforcement mode (`[subagent] lead_turn_gate` on disk, default
   * `enforce`): `off` disables the mechanism entirely (like
   * `lead_turn_timeout_ms = 0`); `warn` keeps the legacy
   * cancel → turn.ended → inject reminder, which the lead can ignore;
   * `enforce` replaces the cancel with a code-layer hard block — once the
   * budget is exhausted the turn is *locked*, execution-class tools are vetoed
   * at the executor, and the lead can only continue by dispatching / managing
   * or by the user granting a fresh budget window (see
   * `lead_turn_grant_ms`). An explicit `lead_turn_timeout_ms = 0` overrides
   * any mode.
   */
  leadTurnGate: z.enum(['off', 'warn', 'enforce']).optional(),
  /**
   * Re-authorization window (`[subagent] lead_turn_grant_ms`, default 30_000;
   * `0` disables the ask — the turn stays locked until it ends). When the
   * turn is locked, the engine asks the user for permission and, on approval,
   * re-arms the turn with a *fresh* budget window of this length; grants never
   * stack onto the exhausted budget.
   */
  leadTurnGrantMs: z.number().int().min(0).optional(),
  /**
   * User-answer bound for the grant ask (`[subagent]
   * lead_turn_grant_timeout_ms`, default 60_000; `0` disables the ask — the
   * turn stays locked). If the user does not answer in time the ask is treated
   * as a decline and the turn stays locked.
   */
  leadTurnGrantTimeoutMs: z.number().int().min(0).optional(),
  /**
   * Per-turn grant cap (`[subagent] lead_turn_max_grants`, default 5): the
   * maximum number of re-authorizations in one turn; beyond it the turn stays
   * locked with no further asks.
   */
  leadTurnMaxGrants: z.number().int().min(1).optional(),
  /**
   * Locked-turn backstop (`[subagent] lead_turn_lock_cap_ms`, default
   * 120_000; `0` disables). A locked turn that keeps running past this cap
   * (e.g. runaway text generation) is force-cancelled. A foreground dispatch /
   * management / wait-user tool still in flight delays the backstop.
   */
  leadTurnLockCapMs: z.number().int().min(0).optional(),
  /**
   * Per-profile model override: `[subagent.model_overrides]` on disk
   * (`coder = "local/qwen3.6-35b-a3b"`). Binds newly spawned subagents of the
   * named profile to the given `[models.<id>]` id, taking precedence over the
   * profile's `model_preference` and the secondary-model default. An explicit
   * per-call `model` argument still wins; validity is checked against the
   * model catalog at spawn time.
   */
  modelOverrides: z.record(z.string(), z.string()).optional(),
  /**
   * Keep-alive wake-up period (`[subagent] warm_interval_ms`, default 30
   * minutes; `0` disables). The keep-alive keeper wakes this often to renew
   * the rest horizon of standby members (see `standbyKeepaliveMs`) so they
   * stay warm in the standby pool instead of being reaped at `restExpiresAt`.
   * Pipeline-phase-one + keepalive: consumed by the keep-alive keeper.
   */
  warmIntervalMs: z.number().int().min(0).optional(),
  /**
   * Duty-member idle TTL (`[subagent] duty_idle_ttl_ms`, default `0` = never
   * reaped). A duty member parks without an idle countdown and is never reaped
   * proactively; `0` keeps it on duty until the main agent sends `TaskStop`.
   */
  dutyIdleTtlMs: z.number().int().min(0).optional(),
  /**
   * Standby-pool cap (`[subagent] max_standby`, default 8). Upper bound on how
   * many members the keep-alive keeper renews / keeps in the standby pool;
   * beyond the cap a resting member drops back to plain `resting` and is
   * reaped at `restExpiresAt`.
   */
  maxStandby: z.number().int().min(0).optional(),
  /**
   * Standby keep-alive window (`[subagent] standby_keepalive_ms`, default 15
   * minutes). After a subagent run settles (`resting`), the instance stays in
   * the standby pool (warm cache, grab-now) for this window measured from its
   * settle time (`updatedAt`); once the window elapses it drops to plain
   * `resting` and runs the existing idle TTL to off-duty. Consumers resolve
   * the effective value through {@link resolveSubagentStandbyKeepaliveMs}.
   */
  standbyKeepaliveMs: z.number().int().min(0).optional(),
  /**
   * TeamScore acceptance gate (`[subagent] score_gate` on disk, default
   * `enforce`): whether TeamScore `record` requires the main agent to have
   * performed a detectable acceptance action — reading the member's delivery
   * output (TaskOutput / `agents/main/tasks/<task_id>/output.log`), reviewing
   * a diff (`git diff` / `git show`), or rerunning tests (vitest / pnpm test /
   * npm test / pytest) — since the member's delivery completed. `enforce`
   * rejects a record with no evidence; `warn` records it with a warning; `off`
   * keeps the pre-gate behavior. Penalty actions are always exempt. Shape
   * detection only: this blocks "scored with no acceptance at all", never
   * "perfunctory acceptance".
   */
  scoreGate: z.enum(['off', 'warn', 'enforce']).optional(),
  /**
   * Run-duration alert threshold (`[subagent] run_alert_ms`, default 15
   * minutes; `0` disables). While a supervised team-mode subagent run is in
   * flight, the engine injects a system message into the main agent's next
   * turn once the run has been running this long, then repeats every 30
   * minutes — the lead is nudged to review long-running work instead of
   * waiting blind for the 2h hard timeout. Duty members (no hard timeout) are
   * alerted too.
   */
  runAlertMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Default idle TTL before a parked subagent is reaped: 2 hours. */
export const DEFAULT_SUBAGENT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;

/** Default lead-turn timeout for the main agent in team mode: 30s (0 disables). */
export const DEFAULT_LEAD_TURN_TIMEOUT_MS = 30_000;

/** Lead-turn enforcement mode (`[subagent] lead_turn_gate`). */
export type LeadTurnGateMode = 'off' | 'warn' | 'enforce';

/** Default lead-turn gate mode: `enforce` — the user-mandated hard limit. */
export const DEFAULT_LEAD_TURN_GATE: LeadTurnGateMode = 'enforce';

/** Default re-authorization window granted on user approval: 30s (0 disables the ask). */
export const DEFAULT_LEAD_TURN_GRANT_MS = 30_000;

/** Default user-answer bound for the grant ask: 60s (0 disables the ask). */
export const DEFAULT_LEAD_TURN_GRANT_TIMEOUT_MS = 60_000;

/** Default per-turn grant cap: 5. */
export const DEFAULT_LEAD_TURN_MAX_GRANTS = 5;

/** Default locked-turn backstop: 120s (0 disables). */
export const DEFAULT_LEAD_TURN_LOCK_CAP_MS = 120_000;

/** Default idle threshold before team auto-initiative fires: 5 minutes (0 disables). */
export const DEFAULT_TEAM_AUTO_IDLE_MS = 300_000;

/** Default keep-alive wake-up period: 30 minutes (`0` disables). */
export const DEFAULT_SUBAGENT_WARM_INTERVAL_MS = 1_800_000;

/** Default duty-member idle TTL: `0` = never reaped. */
export const DEFAULT_SUBAGENT_DUTY_IDLE_TTL_MS = 0;

/** Default standby-pool cap: 8 members. */
export const DEFAULT_SUBAGENT_MAX_STANDBY = 8;

/** Default standby keep-alive window: 15 minutes. */
export const DEFAULT_SUBAGENT_STANDBY_KEEPALIVE_MS = 900_000;

/** TeamScore acceptance-gate mode. */
export type ScoreGateMode = 'off' | 'warn' | 'enforce';

/** Default TeamScore acceptance-gate mode: `enforce`. */
export const DEFAULT_SCORE_GATE: ScoreGateMode = 'enforce';

/** Default run-duration alert threshold: 15 minutes (`0` disables). */
export const DEFAULT_SUBAGENT_RUN_ALERT_MS = 15 * 60 * 1000;

/** Repeat cadence for run-duration alerts after the first: every 30 minutes. */
export const SUBAGENT_RUN_ALERT_INTERVAL_MS = 30 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const SUBAGENT_RUN_ALERT_ENV = 'KIMI_SUBAGENT_RUN_ALERT_MS';

function parseRunAlertMsEnv(raw: string): number | undefined {
  // `0` is valid (disables the alert), so the parse floor differs from the
  // timeout env (`>= 1`).
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
    runAlertMs: { env: SUBAGENT_RUN_ALERT_ENV, parse: parseRunAlertMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

/**
 * Resolve the run-duration alert threshold (`[subagent] run_alert_ms`, default
 * 15 minutes; `0` disables). The first alert fires after this long; repeats
 * follow every {@link SUBAGENT_RUN_ALERT_INTERVAL_MS}.
 */
export function resolveSubagentRunAlertMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.runAlertMs ??
    DEFAULT_SUBAGENT_RUN_ALERT_MS
  );
}

/**
 * Resolve the effective idle TTL before a parked subagent is reaped. Governs
 * `SubagentIdleReaper.arm` and the resting horizon written to the runtime
 * status file. Falls back to {@link DEFAULT_SUBAGENT_IDLE_TTL_MS} when
 * `[subagent] idle_ttl_ms` is unset.
 */
export function resolveSubagentIdleTtlMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.idleTtlMs ??
    DEFAULT_SUBAGENT_IDLE_TTL_MS
  );
}

/**
 * Resolve the lead-turn timeout for the main agent's user turn in team mode
 * (`[subagent] lead_turn_timeout_ms`, default 30s; `0` disables the
 * interrupt). The budget applies to the *active* time of a displayable user
 * turn — interaction-pending windows (approval / question / user-tool) pause
 * the clock.
 */
export function resolveLeadTurnTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.leadTurnTimeoutMs ??
    DEFAULT_LEAD_TURN_TIMEOUT_MS
  );
}

/**
 * Resolve the lead-turn enforcement mode (`[subagent] lead_turn_gate`,
 * default `enforce`). An explicit `lead_turn_timeout_ms = 0` disables the
 * mechanism regardless of the mode (`shouldArm` checks the timeout first).
 */
export function resolveLeadTurnGate(config: IConfigService): LeadTurnGateMode {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.leadTurnGate ??
    DEFAULT_LEAD_TURN_GATE
  );
}

/**
 * Resolve the re-authorization window (`[subagent] lead_turn_grant_ms`,
 * default 30s; `0` disables the ask — the turn stays locked until it ends).
 */
export function resolveLeadTurnGrantMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.leadTurnGrantMs ??
    DEFAULT_LEAD_TURN_GRANT_MS
  );
}

/**
 * Resolve the user-answer bound for the grant ask (`[subagent]
 * lead_turn_grant_timeout_ms`, default 60s; `0` disables the ask).
 */
export function resolveLeadTurnGrantTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.leadTurnGrantTimeoutMs ??
    DEFAULT_LEAD_TURN_GRANT_TIMEOUT_MS
  );
}

/**
 * Resolve the per-turn grant cap (`[subagent] lead_turn_max_grants`, default 5).
 */
export function resolveLeadTurnMaxGrants(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.leadTurnMaxGrants ??
    DEFAULT_LEAD_TURN_MAX_GRANTS
  );
}

/**
 * Resolve the locked-turn backstop (`[subagent] lead_turn_lock_cap_ms`,
 * default 120s; `0` disables).
 */
export function resolveLeadTurnLockCapMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.leadTurnLockCapMs ??
    DEFAULT_LEAD_TURN_LOCK_CAP_MS
  );
}

/** Resolve the team auto-initiative switch (`[subagent] team_auto`, default off). */
export function resolveTeamAuto(config: IConfigService): boolean {
  return config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.teamAuto ?? false;
}

/**
 * Resolve the idle threshold before team auto-initiative fires
 * (`[subagent] auto_idle_ms`, default 5 min; `0` disables the idle trigger).
 */
export function resolveTeamAutoIdleMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.autoIdleMs ??
    DEFAULT_TEAM_AUTO_IDLE_MS
  );
}

/**
 * Resolve the keep-alive wake-up period (`[subagent] warm_interval_ms`,
 * default 30 min; `0` disables). The keep-alive keeper runs on this cadence
 * to renew standby members' rest horizon.
 */
export function resolveSubagentWarmIntervalMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.warmIntervalMs ??
    DEFAULT_SUBAGENT_WARM_INTERVAL_MS
  );
}

/**
 * Resolve the duty-member idle TTL (`[subagent] duty_idle_ttl_ms`, default
 * `0` = never reaped). Duty members park without an idle countdown and are
 * never reaped proactively.
 */
export function resolveSubagentDutyIdleTtlMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.dutyIdleTtlMs ??
    DEFAULT_SUBAGENT_DUTY_IDLE_TTL_MS
  );
}

/**
 * Resolve the standby-pool cap (`[subagent] max_standby`, default 8) — the
 * upper bound on how many members the keep-alive keeper keeps in the standby
 * pool.
 */
export function resolveSubagentMaxStandby(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.maxStandby ??
    DEFAULT_SUBAGENT_MAX_STANDBY
  );
}

/**
 * Resolve the standby keep-alive window (`[subagent] standby_keepalive_ms`,
 * default 15 min) — the horizon used by the runtime-status roster to derive
 * `standby` from a `resting` entry whose `restExpiresAt` is within the window
 * of `now`.
 */
export function resolveSubagentStandbyKeepaliveMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.standbyKeepaliveMs ??
    DEFAULT_SUBAGENT_STANDBY_KEEPALIVE_MS
  );
}

/** Tool names gated by team mode (see `SubagentConfigSchema.teamMode`). */
export const TEAM_TOOL_NAMES: readonly string[] = [
  'TeamHire',
  'TeamFire',
  'TeamScore',
  'TeamMessage',
  'TeamConcurrency',
];

/**
 * Env var carrying the kimiteam launcher's team-mode default. Set to `1` by
 * `scripts/install-kimiteam.sh` / `install-kimiteam.ps1` so the team build
 * starts in team mode; `resolveTeamMode` honors it only when `[subagent]
 * team_mode` is unset.
 */
export const TEAM_MODE_ENV = 'KIMI_CODE_TEAM_MODE';

/**
 * Resolve the team-mode switch (`[subagent] team_mode`, default off). An
 * explicit config value wins; otherwise the `KIMI_CODE_TEAM_MODE` env var
 * (set to `1` by the kimiteam launcher) supplies the default; otherwise off.
 * `/team off` and the web toggle persist `team_mode = false` and therefore
 * override the env default until the config value is cleared.
 */
export function resolveTeamMode(config: IConfigService): boolean {
  const configured = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.teamMode;
  if (configured !== undefined) return configured;
  return parseBooleanEnv(process.env[TEAM_MODE_ENV]) ?? false;
}

/**
 * Resolve the TeamScore acceptance-gate mode (`[subagent] score_gate`, default
 * `enforce`). See `SubagentConfigSchema.scoreGate` for the semantics.
 */
export function resolveScoreGate(config: IConfigService): ScoreGateMode {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.scoreGate ??
    DEFAULT_SCORE_GATE
  );
}

export type SubagentModelChoice = AgentModelPreference;

export function resolveSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
): SecondaryModelConfig | undefined {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return undefined;
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
}

/**
 * Resolve the model id to record on a team-mode shift for a bound subagent.
 * A subagent bound to the synthesized derived entry
 * (`SECONDARY_DERIVED_MODEL_ID`, i.e. a secondary recipe with patch fields)
 * records the real model the `[secondary_model]` recipe points at (`.model`),
 * not the reserved derived id; every other alias is recorded as-is. Falls
 * back to the alias when the secondary config can no longer be resolved
 * (e.g. the flag was flipped off mid-session), so the recorded id stays the
 * bound id rather than becoming `undefined`.
 */
export function resolveRecordedModelId(
  config: IConfigService,
  flags: IFlagService,
  modelAlias: string | undefined,
): string | undefined {
  if (modelAlias !== SECONDARY_DERIVED_MODEL_ID) return modelAlias;
  return resolveSecondaryModel(config, flags)?.model ?? modelAlias;
}

/**
 * Provenance of a resolved subagent model binding, used by
 * `wrapSubagentModelError` to point the error message at the right knob.
 */
export type SubagentBindingSource =
  | 'model-param'
  | 'item-models'
  | 'model-override'
  | 'model-preference'
  | 'secondary'
  | 'caller';

/** The resolved per-spawn model binding, threaded through swarm tasks. */
export interface SubagentSpawnBinding {
  readonly model: string;
  readonly thinking?: string;
  /** Per-profile sampling temperature, folded from the member's `temperature` frontmatter. */
  readonly temperature?: number;
  readonly source?: SubagentBindingSource;
}

/**
 * The per-profile spawn defaults resolved from the member's agent file
 * (`think_mode` / `temperature` frontmatter). Kept as the narrow profile
 * surface so binding assembly never needs the full catalog profile.
 */
export type SubagentProfileSpawnDefaults = Pick<AgentProfile, 'thinkMode' | 'temperature'>;

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice,
  profileName?: string,
  /** Where `requested` came from; only used for precedence and error provenance. */
  requestedSource: 'model-param' | 'item-models' | 'model-preference' = 'model-param',
  /** The member's own spawn defaults (`think_mode` / `temperature` frontmatter), when available. */
  profile?: SubagentProfileSpawnDefaults,
): { model: string; thinking?: string; temperature?: number; source: SubagentBindingSource } {
  // Precedence: an explicit per-call choice (model parameter / item_models) >
  // `[subagent.model_overrides]` > the profile's model_preference > the
  // secondary default > inherit the caller. A choice that arrived via the
  // profile's model_preference therefore never suppresses the override.
  const fromTool = requested !== undefined && requestedSource !== 'model-preference';
  // 1) Per-profile override from `[subagent.model_overrides]`.
  const override =
    fromTool || profileName === undefined
      ? undefined
      : config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.modelOverrides?.[profileName];
  if (override !== undefined) {
    return {
      model: override,
      thinking: profile?.thinkMode,
      temperature: profile?.temperature,
      source: 'model-override',
    };
  }
  // 2) An explicit `[models.<id>]` id (anything but the symbolic shortcuts)
  //    binds directly; validity is checked against the catalog at spawn.
  if (requested !== undefined && requested !== 'primary' && requested !== 'secondary') {
    return {
      model: requested,
      thinking: profile?.thinkMode,
      temperature: profile?.temperature,
      source: requestedSource,
    };
  }
  // 3) Secondary default (unless 'primary' was requested), then inherit.
  const secondary = resolveSecondaryModel(config, flags);
  if (requested !== 'primary' && secondary?.model !== undefined) {
    return {
      model:
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ID,
      // An explicitly configured secondary `default_effort` stays authoritative;
      // the profile's declared think_mode fills in when the recipe has none.
      thinking: secondary.defaultEffort ?? profile?.thinkMode,
      temperature: profile?.temperature,
      source: 'secondary',
    };
  }
  return {
    model: own.modelAlias,
    // The member's own declared think_mode wins over inherited caller thinking
    // (inheritance is ambient state, not a deliberate binding); effort
    // validity is normalized downstream by `resolveThinkingEffort`.
    thinking: profile?.thinkMode ?? own.thinkingLevel,
    temperature: profile?.temperature,
    source: 'caller',
  };
}

/** Every configured `[models.<id>]` id, sorted; the explicit-id choices. */
export function listCatalogModelIds(config: IConfigService): readonly string[] {
  return Object.keys(config.get<Record<string, unknown> | undefined>(MODELS_SECTION) ?? {}).sort();
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
  modelCatalog: IModelCatalog,
): string | undefined {
  const secondary = resolveSecondaryModel(config, flags);
  const secondaryModel = secondary?.model;
  if (secondaryModel === undefined || callerModelAlias === undefined) return undefined;
  const boundSecondary =
    secondaryModelPatch(secondary) === undefined ? secondaryModel : SECONDARY_DERIVED_MODEL_ID;
  const lines = [
    'Available models (pass via model):',
    `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, boundSecondary))}`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks${capabilitiesSuffix(resolvedCapabilities(modelCatalog, callerModelAlias))}`,
  ];
  const catalogIds = listCatalogModelIds(config);
  if (catalogIds.length > 0) {
    lines.push(`- or any [models] id from config.toml:\n  ${catalogIds.join(', ')}`);
  }
  return lines.join('\n');
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function capabilitiesSuffix(capability: ModelCapability | undefined): string {
  if (capability === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
}

function resolvedCapabilities(
  modelCatalog: IModelCatalog,
  model: string,
): ModelCapability | undefined {
  try {
    return modelCatalog.get(model).capabilities;
  } catch {
    return undefined;
  }
}

/**
 * Strip the `model` property from a subagent collaboration tool's advertised
 * JSON schema. While the `secondary-model` experiment is off the parameter is
 * a silent no-op, so the schema the model sees (and the args validator
 * compiled from the same advertised schema) drops it entirely — the
 * secondary-model concept never enters the prompt, and a stray `model`
 * argument is rejected instead of silently inheriting the caller's model.
 * Returns the input unchanged when there is no `model` property; otherwise a
 * shallow copy — the input is never mutated, so callers can keep both
 * variants as shared constants.
 */
export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
  source: SubagentBindingSource = 'secondary',
  config?: IConfigService,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  if (source !== 'secondary') {
    const origin =
      source === 'model-override'
        ? 'comes from [subagent.model_overrides] in config.toml'
        : source === 'model-preference'
          ? "comes from the agent type's model_preference"
          : source === 'item-models'
            ? 'comes from the item_models parameter'
            : 'comes from the model parameter';
    const available =
      config === undefined
        ? ''
        : ` Available [models] ids: ${listCatalogModelIds(config).join(', ')}.`;
    return new Error2(
      error.code,
      `${error.message} (subagent model "${boundModel}" ${origin} — check that it names a valid [models] entry.${available})`,
      {
        cause: error,
        name: error.name,
        details: { ...error.details, subagentModel: boundModel, subagentModelSource: source },
      },
    );
  }
  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ID
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ID}"`
      : `"${boundModel}"`;
  return new Error2(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        secondaryModel: boundModel,
        secondaryModelConfig: {
          section: 'secondaryModel.model',
          environment: SECONDARY_MODEL_ENV,
        },
      },
    },
  );
}

export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}
