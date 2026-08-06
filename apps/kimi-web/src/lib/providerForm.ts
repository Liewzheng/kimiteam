// apps/kimi-web/src/lib/providerForm.ts
// Pure helpers for the provider settings forms (add + edit in ProviderManager).
// No Vue, no i18n imports. The wire-type list mirrors the server's
// providerWireTypeSchema (packages/kap-server/src/protocol/rest-modelCatalog.ts);
// validation returns i18n KEYS the component resolves (same pattern as
// lib/teamRows.ts teamStatusMeta).

import type { AppModel, AppProviderModelInput } from '../api/types';

/** The six wire provider types the server accepts (providerWireTypeSchema in
 *  rest-modelCatalog.ts). The legacy web add form's 'moonshot'/'custom' values
 *  were never accepted by that contract — these are the real, persisted types. */
export const PROVIDER_WIRE_TYPES = [
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
] as const;
export type ProviderWireType = (typeof PROVIDER_WIRE_TYPES)[number];

/** i18n key for each wire type's display label — resolve `providers.type.<key>`
 *  in the component. */
export const PROVIDER_TYPE_LABEL_KEYS: Record<ProviderWireType, string> = {
  kimi: 'providers.type.kimi',
  openai: 'providers.type.openai',
  openai_responses: 'providers.type.openaiResponses',
  anthropic: 'providers.type.anthropic',
  'google-genai': 'providers.type.googleGenai',
  vertexai: 'providers.type.vertexai',
};

/** Default max-context for a hand-entered model row (the server requires a
 *  positive int; users can adjust per row). */
export const DEFAULT_MAX_CONTEXT_SIZE = 128_000;

/** The add/edit form shape. `id` is read-only in edit mode (the path identity
 *  of the provider being replaced). */
export interface ProviderFormState {
  id: string;
  type: ProviderWireType;
  apiKey: string;
  baseUrl: string;
  /** One of the entered model names, or '' (server seeds the first model). */
  defaultModel: string;
  /** Model rows; the server requires at least one on both create and replace. */
  models: AppProviderModelInput[];
}

/** Server-accepted provider id: starts with a letter/digit, then letters,
 *  digits, "-", "_" and spaces (providerIdSchema, rest-modelCatalog.ts). */
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

export function isValidProviderId(id: string): boolean {
  return PROVIDER_ID_RE.test(id);
}

/** A blank add form: openai (most common third-party wire type), one empty
 *  model row so the required `models` list is never a blank surprise. */
export function emptyProviderForm(): ProviderFormState {
  return {
    id: '',
    type: 'openai',
    apiKey: '',
    baseUrl: '',
    defaultModel: '',
    models: [{ model: '', maxContextSize: DEFAULT_MAX_CONTEXT_SIZE }],
  };
}

/**
 * Build the edit-form model rows from a provider's current aliases + the model
 * catalog. Catalog matches give real context sizes; aliases the catalog does
 * not know (provider not refreshed yet) synthesize from the `<provider>/<model>`
 * alias id so the form never drops a model the provider already has.
 */
export function providerModelsFromCatalog(
  providerModels: readonly string[] | undefined,
  providerId: string,
  catalog: readonly AppModel[],
): AppProviderModelInput[] {
  const rows: AppProviderModelInput[] = [];
  const seen = new Set<string>();
  for (const alias of providerModels ?? []) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    const match = catalog.find((m) => m.id === alias);
    if (match !== undefined) {
      rows.push({ model: match.model, maxContextSize: match.maxContextSize });
      continue;
    }
    const prefix = `${providerId}/`;
    const raw = alias.startsWith(prefix) ? alias.slice(prefix.length) : alias;
    rows.push({ model: raw, maxContextSize: DEFAULT_MAX_CONTEXT_SIZE });
  }
  return rows;
}

/**
 * Validate the add/edit form. Returns an i18n key (providers.*) to surface, or
 * null when valid. apiKey is required only on ADD — edit may leave it blank to
 * keep the stored key (the wire tri-state: omitted = keep).
 */
export function validateProviderForm(
  form: ProviderFormState,
  requireApiKey: boolean,
): string | null {
  if (form.id.trim().length === 0) return 'providers.idRequired';
  if (!isValidProviderId(form.id.trim())) return 'providers.idInvalid';
  if (requireApiKey && form.apiKey.trim().length === 0) return 'providers.apiKeyRequired';
  if (form.models.length === 0 || form.models.some((row) => row.model.trim().length === 0)) {
    return 'providers.modelsRequired';
  }
  if (
    form.models.some(
      (row) => !Number.isFinite(row.maxContextSize) || row.maxContextSize <= 0,
    )
  ) {
    return 'providers.contextInvalid';
  }
  if (
    form.defaultModel !== '' &&
    !form.models.some((row) => row.model === form.defaultModel)
  ) {
    return 'providers.defaultModelInvalid';
  }
  return null;
}
