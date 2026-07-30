/**
 * Config-mapper unit tests: `resolvedConfigToKimiConfig` field projection.
 *
 * These cover the pure mapping layer — v2's domain-resolved config view
 * projected onto the v1 KimiConfig shape. The integration parity test
 * (v1-v2-parity.test.ts) exercises the full engine round-trip.
 */
import { describe, expect, it } from 'vitest';

import { resolvedConfigToKimiConfig } from '#/v2/config-mapper';

describe('resolvedConfigToKimiConfig', () => {
  it('preserves secondaryModel from the resolved config', () => {
    const resolved = {
      subagent: { teamMode: true, modelOverrides: { coder: 'gpt-4o' } },
      secondaryModel: { model: 'deepseek/deepseek-v4-flash', defaultEffort: 'high' },
      defaultModel: 'kimi-code/k3-256k',
    };
    const config = resolvedConfigToKimiConfig(resolved);
    expect(config.secondaryModel).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      defaultEffort: 'high',
    });
  });

  it('drops secondaryModel when absent from resolved config', () => {
    const resolved = {
      subagent: { teamMode: true },
      defaultModel: 'kimi-code/k3-256k',
    };
    const config = resolvedConfigToKimiConfig(resolved);
    expect(config.secondaryModel).toBeUndefined();
  });

  it('preserves subagent, defaultModel and other standard fields', () => {
    const resolved = {
      defaultModel: 'kimi-code/k3-256k',
      subagent: { teamMode: true },
      providers: { 'managed:kimi-code': { type: 'kimi' } },
      models: { 'kimi-code/k3-256k': { provider: 'managed:kimi-code', model: 'k3-256k' } },
    };
    const config = resolvedConfigToKimiConfig(resolved);
    expect(config.defaultModel).toBe('kimi-code/k3-256k');
    expect(config.subagent).toEqual({ teamMode: true });
    expect(config.providers).toEqual({ 'managed:kimi-code': { type: 'kimi' } });
    expect(config.models).toEqual({
      'kimi-code/k3-256k': { provider: 'managed:kimi-code', model: 'k3-256k' },
    });
  });

  it('strips v2-only domains (cron, tools, extraAgentDirs)', () => {
    const resolved = {
      defaultModel: 'kimi-code/k3-256k',
      cron: { entries: [] },
      tools: { myTool: 'enabled' },
      extraAgentDirs: ['/some/dir'],
    };
    const config = resolvedConfigToKimiConfig(resolved);
    expect(config.defaultModel).toBe('kimi-code/k3-256k');
    // v2-only domains are dropped
    expect((config as Record<string, unknown>)['cron']).toBeUndefined();
    expect((config as Record<string, unknown>)['tools']).toBeUndefined();
    expect((config as Record<string, unknown>)['extraAgentDirs']).toBeUndefined();
  });
});
