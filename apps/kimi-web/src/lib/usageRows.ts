// apps/kimi-web/src/lib/usageRows.ts
// Pure usage helpers for the /usage right-side panel — no Vue, no i18n imports.
// Model-key normalization and display-row derivation live here so UsagePanel
// stays a thin renderer and the logic is unit-testable.
//
// Mirrors the TUI's SubAgentUsage contract
// (apps/kimi-code/src/tui/components/messages/usage-panel.ts): the engine
// records every subagent bound to the `[secondary_model]` recipe under the
// synthesized `__secondary__` model alias; `secondaryModelId` (from the wire
// `secondary_model_id` field) resolves it to the real model id before render.
// When the server already normalized, `secondaryModelId` is null and the keys
// are used verbatim.

import type { AppTeamTokenUsage, AppTeamUsage } from '../api/types';

/** Engine-internal derived alias for a subagent bound to the `[secondary_model]`
 *  recipe — a runtime artifact, never a user-visible model id. */
export const SECONDARY_MODEL_ALIAS = '__secondary__';

/** Input side of a token row — cache reads and cache creation count as input
 *  spend, matching the TUI's `usageInputTotal`. */
export function tokenInputTotal(row: AppTeamTokenUsage): number {
  return row.inputOther + row.inputCacheRead + row.inputCacheCreation;
}

/** Display total for a token row. */
export function tokenTotal(row: AppTeamTokenUsage): number {
  return tokenInputTotal(row) + row.output;
}

/**
 * Resolve the engine's derived secondary alias to the real model id the
 * `[secondary_model]` recipe points at, merging any bucket that would collide
 * so all derived-secondary agents aggregate into the real model row. Member
 * breakdowns stay keyed by member name. When the real id is unavailable
 * (`null`, empty, or itself the alias), the usage is returned unchanged.
 */
export function normalizeTeamUsage(usage: AppTeamUsage): AppTeamUsage {
  const secondaryModelId = usage.secondaryModelId;
  if (
    secondaryModelId === null ||
    secondaryModelId.length === 0 ||
    secondaryModelId === SECONDARY_MODEL_ALIAS
  ) {
    return usage;
  }
  if (!hasDerivedSecondaryKey(usage)) return usage;
  return {
    runs: usage.runs,
    secondaryModelId,
    byModel: normalizeModelBucket(usage.byModel, secondaryModelId),
    byMember: Object.fromEntries(
      Object.entries(usage.byMember).map(([memberName, bucket]) => [
        memberName,
        normalizeModelBucket(bucket, secondaryModelId),
      ]),
    ),
  };
}

function hasDerivedSecondaryKey(usage: AppTeamUsage): boolean {
  if (SECONDARY_MODEL_ALIAS in usage.byModel) return true;
  for (const bucket of Object.values(usage.byMember)) {
    if (SECONDARY_MODEL_ALIAS in bucket) return true;
  }
  return false;
}

/** Remap a model→usage bucket, merging entries that collide on the real id. */
function normalizeModelBucket(
  bucket: Record<string, AppTeamTokenUsage>,
  secondaryModelId: string,
): Record<string, AppTeamTokenUsage> {
  if (!(SECONDARY_MODEL_ALIAS in bucket)) return bucket;
  const out: Record<string, AppTeamTokenUsage> = {};
  for (const [model, row] of Object.entries(bucket)) {
    const key = model === SECONDARY_MODEL_ALIAS ? secondaryModelId : model;
    const merged = out[key];
    out[key] = merged === undefined ? { ...row } : addTokenUsage(merged, row);
  }
  return out;
}

function addTokenUsage(a: AppTeamTokenUsage, b: AppTeamTokenUsage): AppTeamTokenUsage {
  return {
    inputOther: a.inputOther + b.inputOther,
    output: a.output + b.output,
    inputCacheRead: a.inputCacheRead + b.inputCacheRead,
    inputCacheCreation: a.inputCacheCreation + b.inputCacheCreation,
  };
}

/** A single display row: label + aggregated input/output spend. */
export interface UsageAmountRow {
  label: string;
  input: number;
  output: number;
}

/** One row per model with recorded spend, largest total first (ties by name). */
export function modelUsageRows(usage: AppTeamUsage): UsageAmountRow[] {
  return Object.entries(usage.byModel)
    .map(([model, row]) => ({
      label: model,
      input: tokenInputTotal(row),
      output: row.output,
    }))
    .filter((row) => row.input + row.output > 0)
    .sort(byTotalThenLabel);
}

/** One row per member with recorded spend (all models summed), largest total
 *  first (ties by name). */
export function memberUsageRows(usage: AppTeamUsage): UsageAmountRow[] {
  return Object.entries(usage.byMember)
    .map(([name, bucket]) => {
      let input = 0;
      let output = 0;
      for (const row of Object.values(bucket)) {
        input += tokenInputTotal(row);
        output += row.output;
      }
      return { label: name, input, output };
    })
    .filter((row) => row.input + row.output > 0)
    .sort(byTotalThenLabel);
}

/** A single member's current-session token spend (all models summed), or null
 *  when the member has no recorded usage this session. Used by the member
 *  detail's token-usage section. */
export function memberSessionUsage(
  usage: AppTeamUsage,
  name: string,
): { input: number; output: number } | null {
  const bucket = usage.byMember[name];
  if (!bucket) return null;
  let input = 0;
  let output = 0;
  for (const row of Object.values(bucket)) {
    input += tokenInputTotal(row);
    output += row.output;
  }
  return { input, output };
}

function byTotalThenLabel(a: UsageAmountRow, b: UsageAmountRow): number {
  const byTotal = b.input + b.output - (a.input + a.output);
  if (byTotal !== 0) return byTotal;
  return a.label.localeCompare(b.label);
}
