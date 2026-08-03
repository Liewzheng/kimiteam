/**
 * `subagent` domain (L6) — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms` on disk) together
 * with the `KIMI_SUBAGENT_TIMEOUT_MS` env override, mirroring v1's
 * `resolveSubagentTimeoutMs` precedence (env > config.toml > 2h default). While
 * the env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Both
 * collaboration tools — `Agent` in this domain and `AgentSwarm` in the `swarm`
 * domain — resolve their per-run timeout through `resolveSubagentTimeoutMs`,
 * and render the timeout message with `formatSubagentTimeoutDescription`.
 *
 * The model half of the spawn binding is the secondary model (the section
 * and type in `app/kosongConfig` — `[secondary_model]` on disk): when its
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
 * `buildSubagentModelDescriptions`, and wrap spawn failures with
 * `wrapSubagentModelError`. Self-registered at module load via
 * `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
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
   * Team mode (`[subagent] team_mode` on disk, default off). When off, the
   * five Team* management tools (TeamHire/TeamFire/TeamScore/TeamMessage/
   * TeamConcurrency) are hidden from the main agent's tool list by the tool
   * policy. Only tool visibility is gated — model binding, item_models,
   * model_overrides, role/duty profile fields work regardless.
   */
  teamMode: z.boolean().optional(),
  /**
   * Per-profile model override: `[subagent.model_overrides]` on disk
   * (`coder = "local/qwen3.6-35b-a3b"`). Binds newly spawned subagents of the
   * named profile to the given `[models.<id>]` id, taking precedence over the
   * profile's `model_preference` and the secondary-model default. An explicit
   * per-call `model` argument still wins; validity is checked against the
   * model catalog at spawn time.
   */
  modelOverrides: z.record(z.string(), z.string()).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

/** Default per-run subagent timeout: 2 hours, same as v1. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

/** Parse the env override; anything but a positive integer is ignored (v1 semantics). */
function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

/**
 * Resolve the effective per-run subagent timeout. Governs foreground and
 * background subagents (and AgentSwarm) through the task manager's per-task
 * timeout.
 */
export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
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

/** Resolve the team-mode switch (`[subagent] team_mode`, default off). */
export function resolveTeamMode(config: IConfigService): boolean {
  return config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.teamMode ?? false;
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
  readonly source?: SubagentBindingSource;
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice,
  profileName?: string,
  /** Where `requested` came from; only used for precedence and error provenance. */
  requestedSource: 'model-param' | 'item-models' | 'model-preference' = 'model-param',
): { model: string; thinking?: string; source: SubagentBindingSource } {
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
    return { model: override, source: 'model-override' };
  }
  // 2) An explicit `[models.<id>]` id (anything but the symbolic shortcuts)
  //    binds directly; validity is checked against the catalog at spawn.
  if (requested !== undefined && requested !== 'primary' && requested !== 'secondary') {
    return { model: requested, source: requestedSource };
  }
  // 3) Secondary default (unless 'primary' was requested), then inherit.
  const secondary = resolveSecondaryModel(config, flags);
  if (requested !== 'primary' && secondary?.model !== undefined) {
    return {
      model:
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ID,
      thinking: secondary.defaultEffort,
      source: 'secondary',
    };
  }
  return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'caller' };
}

/** Every configured `[models.<id>]` id, sorted; the explicit-id choices. */
export function listCatalogModelIds(config: IConfigService): readonly string[] {
  return Object.keys(config.get<Record<string, unknown> | undefined>(MODELS_SECTION) ?? {}).sort();
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
): string | undefined {
  if (callerModelAlias === undefined) return undefined;
  const lines: string[] = [];
  const secondaryModel = resolveSecondaryModel(config, flags)?.model;
  if (secondaryModel !== undefined) {
    lines.push(
      `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks`,
      `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
    );
  }
  const catalogIds = listCatalogModelIds(config);
  if (catalogIds.length > 0) {
    lines.push(`- or any [models] id from config.toml:\n  ${catalogIds.join(', ')}`);
  }
  if (lines.length === 0) return undefined;
  return ['Available models (pass via model):', ...lines].join('\n');
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

/** Human-readable duration for the subagent timeout message. */
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
