// apps/kimi-web/src/lib/providerForm.test.ts
import { describe, expect, it } from 'vitest';
import type { AppModel } from '../api/types';
import {
  DEFAULT_MAX_CONTEXT_SIZE,
  emptyProviderForm,
  isValidProviderId,
  PROVIDER_WIRE_TYPES,
  providerModelsFromCatalog,
  validateProviderForm,
} from './providerForm';

const model = (id: string, rawModel: string, maxContextSize = 200_000): AppModel => ({
  id,
  provider: id.split('/')[0]!,
  model: rawModel,
  maxContextSize,
});

describe('PROVIDER_WIRE_TYPES — the server providerWireTypeSchema', () => {
  it('matches the kap-server enum exactly', () => {
    expect(PROVIDER_WIRE_TYPES).toEqual([
      'kimi',
      'openai',
      'openai_responses',
      'anthropic',
      'google-genai',
      'vertexai',
    ]);
  });
});

describe('isValidProviderId — providerIdSchema', () => {
  it('accepts ids starting with a letter/digit and only [A-Za-z0-9 _-]', () => {
    expect(isValidProviderId('my-openai')).toBe(true);
    expect(isValidProviderId('My_Provider 2')).toBe(true);
    expect(isValidProviderId('0abc')).toBe(true);
  });

  it('rejects empty, leading-symbol and symbol-only ids', () => {
    expect(isValidProviderId('')).toBe(false);
    expect(isValidProviderId('-leading')).toBe(false);
    expect(isValidProviderId('_x')).toBe(false);
    expect(isValidProviderId('has/slash')).toBe(false);
    expect(isValidProviderId('a.b')).toBe(false);
  });
});

describe('emptyProviderForm — blank add form', () => {
  it('starts as openai with one empty model row (models is required, min 1)', () => {
    const form = emptyProviderForm();
    expect(form.type).toBe('openai');
    expect(form.id).toBe('');
    expect(form.apiKey).toBe('');
    expect(form.baseUrl).toBe('');
    expect(form.defaultModel).toBe('');
    expect(form.models).toEqual([{ model: '', maxContextSize: DEFAULT_MAX_CONTEXT_SIZE }]);
  });
});

describe('providerModelsFromCatalog — edit-form prefill', () => {
  const catalog = [
    model('openai/gpt-4o', 'gpt-4o', 128_000),
    model('anthropic/claude-sonnet-4', 'claude-sonnet-4', 200_000),
  ];

  it('maps alias ids through the catalog to real model names + context sizes', () => {
    expect(providerModelsFromCatalog(['openai/gpt-4o', 'anthropic/claude-sonnet-4'], 'openai', catalog)).toEqual([
      { model: 'gpt-4o', maxContextSize: 128_000 },
      { model: 'claude-sonnet-4', maxContextSize: 200_000 },
    ]);
  });

  it('synthesizes aliases the catalog does not know from the <provider>/<model> prefix', () => {
    expect(providerModelsFromCatalog(['openai/gpt-5'], 'openai', catalog)).toEqual([
      { model: 'gpt-5', maxContextSize: DEFAULT_MAX_CONTEXT_SIZE },
    ]);
  });

  it('keeps a bare alias (no provider prefix) as-is', () => {
    expect(providerModelsFromCatalog(['local-model'], 'openai', catalog)).toEqual([
      { model: 'local-model', maxContextSize: DEFAULT_MAX_CONTEXT_SIZE },
    ]);
  });

  it('dedupes repeated aliases and handles undefined', () => {
    expect(providerModelsFromCatalog(['openai/gpt-4o', 'openai/gpt-4o'], 'openai', catalog)).toHaveLength(1);
    expect(providerModelsFromCatalog(undefined, 'openai', catalog)).toEqual([]);
  });
});

describe('validateProviderForm', () => {
  const valid = (): ReturnType<typeof emptyProviderForm> => ({
    ...emptyProviderForm(),
    id: 'my-openai',
    apiKey: 'sk-123',
    models: [{ model: 'gpt-4o', maxContextSize: 128_000 }],
    defaultModel: 'gpt-4o',
  });

  it('accepts a valid add form', () => {
    expect(validateProviderForm(valid(), true)).toBeNull();
  });

  it('requires the provider id on add and on edit', () => {
    const noId = valid();
    noId.id = '';
    expect(validateProviderForm(noId, true)).toBe('providers.idRequired');
    expect(validateProviderForm(noId, false)).toBe('providers.idRequired');
  });

  it('rejects an id with invalid characters', () => {
    const bad = valid();
    bad.id = 'my/provider';
    expect(validateProviderForm(bad, true)).toBe('providers.idInvalid');
  });

  it('requires an api key only on add (edit may keep the stored key)', () => {
    const noKey = valid();
    noKey.apiKey = '';
    expect(validateProviderForm(noKey, true)).toBe('providers.apiKeyRequired');
    expect(validateProviderForm(noKey, false)).toBeNull();
  });

  it('requires at least one model with a non-empty id', () => {
    const emptyRow = valid();
    emptyRow.models = [{ model: '', maxContextSize: 128_000 }];
    expect(validateProviderForm(emptyRow, true)).toBe('providers.modelsRequired');
    const noRows = valid();
    noRows.models = [];
    expect(validateProviderForm(noRows, true)).toBe('providers.modelsRequired');
  });

  it('rejects a non-positive max context', () => {
    const badCtx = valid();
    badCtx.models = [{ model: 'gpt-4o', maxContextSize: 0 }];
    expect(validateProviderForm(badCtx, true)).toBe('providers.contextInvalid');
  });

  it('rejects a default model that is not one of the entered models', () => {
    const badDefault = valid();
    badDefault.defaultModel = 'claude-sonnet-4';
    expect(validateProviderForm(badDefault, true)).toBe('providers.defaultModelInvalid');
  });

  it('allows an empty default model (server seeds the first model)', () => {
    const auto = valid();
    auto.defaultModel = '';
    expect(validateProviderForm(auto, true)).toBeNull();
  });
});
