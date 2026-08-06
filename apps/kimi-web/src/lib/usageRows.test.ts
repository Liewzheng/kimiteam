// apps/kimi-web/src/lib/usageRows.test.ts
import { describe, expect, it } from 'vitest';
import type { AppTeamTokenUsage, AppTeamUsage } from '../api/types';
import {
  mainUsageRows,
  mainUsageTotal,
  memberSessionUsage,
  memberUsageRows,
  modelUsageRows,
  normalizeTeamUsage,
  SECONDARY_MODEL_ALIAS,
  tokenInputTotal,
  tokenTotal,
} from './usageRows';

const tokens = (inputOther = 0, output = 0, cacheRead = 0, cacheCreation = 0): AppTeamTokenUsage => ({
  inputOther,
  output,
  inputCacheRead: cacheRead,
  inputCacheCreation: cacheCreation,
});

const usage = (partial: Partial<AppTeamUsage> = {}): AppTeamUsage => ({
  runs: 0,
  byModel: {},
  byMember: {},
  secondaryModelId: null,
  ...partial,
});

describe('tokenInputTotal / tokenTotal', () => {
  it('counts cache reads and creation as input spend', () => {
    expect(tokenInputTotal(tokens(10, 5, 3, 2))).toBe(15);
    expect(tokenTotal(tokens(10, 5, 3, 2))).toBe(20);
  });
});

describe('normalizeTeamUsage', () => {
  it('passes through when the server already normalized (no secondary id)', () => {
    const u = usage({
      byModel: { 'kimi-k2': tokens(10, 5) },
      byMember: { alpha: { 'kimi-k2': tokens(2, 1) } },
    });
    expect(normalizeTeamUsage(u)).toBe(u);
  });

  it('passes through when the secondary id is empty or the alias itself', () => {
    const u = usage({
      secondaryModelId: '',
      byModel: { [SECONDARY_MODEL_ALIAS]: tokens(10, 5) },
    });
    expect(normalizeTeamUsage(u)).toBe(u);
    const self = usage({
      secondaryModelId: SECONDARY_MODEL_ALIAS,
      byModel: { [SECONDARY_MODEL_ALIAS]: tokens(10, 5) },
    });
    expect(normalizeTeamUsage(self)).toBe(self);
  });

  it('passes through when no __secondary__ key is present', () => {
    const u = usage({
      secondaryModelId: 'kimi-k2',
      byModel: { 'kimi-k2': tokens(10, 5) },
      byMember: { alpha: { 'kimi-k2': tokens(2, 1) } },
    });
    expect(normalizeTeamUsage(u)).toBe(u);
  });

  it('resolves __secondary__ in byModel to the real model id', () => {
    const u = usage({
      secondaryModelId: 'kimi-k2',
      byModel: { [SECONDARY_MODEL_ALIAS]: tokens(10, 5) },
      byMember: {},
    });
    expect(normalizeTeamUsage(u).byModel).toEqual({ 'kimi-k2': tokens(10, 5) });
  });

  it('merges a colliding real-id bucket when resolving __secondary__', () => {
    const u = usage({
      secondaryModelId: 'kimi-k2',
      byModel: {
        [SECONDARY_MODEL_ALIAS]: tokens(10, 5, 1, 1),
        'kimi-k2': tokens(4, 2),
      },
      byMember: {},
    });
    expect(normalizeTeamUsage(u).byModel).toEqual({ 'kimi-k2': tokens(14, 7, 1, 1) });
  });

  it('resolves __secondary__ inside each member bucket too', () => {
    const u = usage({
      secondaryModelId: 'kimi-k2',
      byModel: {},
      byMember: {
        alpha: {
          [SECONDARY_MODEL_ALIAS]: tokens(6, 3),
          'kimi-k2': tokens(1, 1),
        },
        beta: { [SECONDARY_MODEL_ALIAS]: tokens(2, 1) },
      },
    });
    const normalized = normalizeTeamUsage(u);
    expect(normalized.byMember).toEqual({
      alpha: { 'kimi-k2': tokens(7, 4) },
      beta: { 'kimi-k2': tokens(2, 1) },
    });
  });

  it('passes main through untouched when resolving __secondary__', () => {
    const u = usage({
      secondaryModelId: 'kimi-k2',
      byModel: { [SECONDARY_MODEL_ALIAS]: tokens(10, 5) },
      byMember: {},
      main: {
        byModel: { 'kimi-k2': tokens(100, 50) },
        total: tokens(100, 50),
      },
    });
    expect(normalizeTeamUsage(u).main).toEqual(u.main);
  });
});

describe('mainUsageRows', () => {
  it('emits one row per main model with recorded spend, largest total first', () => {
    const rows = mainUsageRows(
      usage({
        main: {
          byModel: {
            'kimi-k2': tokens(10, 5),
            'kimi-lite': tokens(2, 1, 4, 0),
            'kimi-empty': tokens(0, 0),
          },
          total: tokens(16, 6),
        },
      }),
    );
    expect(rows).toEqual([
      { label: 'kimi-k2', input: 10, output: 5 },
      { label: 'kimi-lite', input: 6, output: 1 },
    ]);
  });

  it('breaks total ties by label', () => {
    const rows = mainUsageRows(
      usage({
        main: {
          byModel: { beta: tokens(4, 2), alpha: tokens(4, 2) },
          total: tokens(8, 4),
        },
      }),
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'beta']);
  });

  it('is empty when main is absent (older daemons / cold sessions)', () => {
    expect(mainUsageRows(usage())).toEqual([]);
    expect(
      mainUsageRows(usage({ main: { byModel: {}, total: tokens(0, 0) } })),
    ).toEqual([]);
  });
});

describe('mainUsageTotal', () => {
  it('returns null for an empty or single-model breakdown', () => {
    expect(mainUsageTotal([])).toBeNull();
    expect(mainUsageTotal([{ label: 'kimi-k2', input: 10, output: 5 }])).toBeNull();
  });

  it('sums input and output across multiple models', () => {
    expect(
      mainUsageTotal([
        { label: 'kimi-k2', input: 10, output: 5 },
        { label: 'kimi-lite', input: 6, output: 1 },
      ]),
    ).toEqual({ input: 16, output: 6 });
  });
});

describe('modelUsageRows', () => {
  it('emits one row per model with recorded spend, largest total first', () => {
    const rows = modelUsageRows(
      usage({
        byModel: {
          'kimi-k2': tokens(10, 5),
          'kimi-lite': tokens(2, 1, 4, 0),
          'kimi-empty': tokens(0, 0),
        },
      }),
    );
    expect(rows).toEqual([
      { label: 'kimi-k2', input: 10, output: 5 },
      { label: 'kimi-lite', input: 6, output: 1 },
    ]);
  });

  it('breaks total ties by label', () => {
    const rows = modelUsageRows(
      usage({ byModel: { beta: tokens(4, 2), alpha: tokens(4, 2) } }),
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'beta']);
  });
});

describe('memberUsageRows', () => {
  it('sums all models per member, largest total first', () => {
    const rows = memberUsageRows(
      usage({
        byMember: {
          alpha: { 'kimi-k2': tokens(10, 5), 'kimi-lite': tokens(2, 1) },
          beta: { 'kimi-k2': tokens(1, 1) },
          empty: { 'kimi-k2': tokens(0, 0) },
        },
      }),
    );
    expect(rows).toEqual([
      { label: 'alpha', input: 12, output: 6 },
      { label: 'beta', input: 1, output: 1 },
    ]);
  });
});

describe('memberSessionUsage', () => {
  it('sums all models for one member, or null when absent', () => {
    const u = usage({
      byMember: {
        alpha: { 'kimi-k2': tokens(10, 5, 3), 'kimi-lite': tokens(2, 1) },
        beta: { 'kimi-k2': tokens(0, 0) },
      },
    });
    expect(memberSessionUsage(u, 'alpha')).toEqual({ input: 15, output: 6 });
    // A member with a bucket but zero spend is still "present" (not null).
    expect(memberSessionUsage(u, 'beta')).toEqual({ input: 0, output: 0 });
    expect(memberSessionUsage(u, 'missing')).toBeNull();
  });
});
