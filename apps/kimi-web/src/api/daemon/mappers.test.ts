// apps/kimi-web/src/api/daemon/mappers.test.ts
// Pure wire→app mapper tests — no DOM, no Vue.
import { describe, expect, it } from 'vitest';
import type { WireTeamTokenUsage, WireTeamUsageResponse } from './wire';
import { toAppTeamUsage } from './mappers';

const wireTokens = (input = 0, output = 0, total = 0): WireTeamTokenUsage => ({
  input,
  output,
  total,
});

const wireUsage = (partial: Partial<WireTeamUsageResponse> = {}): WireTeamUsageResponse => ({
  runs: 0,
  byModel: {},
  byMember: {},
  ...partial,
});

describe('toAppTeamUsage', () => {
  it('maps the main bucket with toAppTeamTokenUsage and keeps the collapsed total', () => {
    const mapped = toAppTeamUsage(
      wireUsage({
        main: {
          byModel: {
            'kimi-k2': wireTokens(100, 50, 150),
            'kimi-lite': wireTokens(20, 10, 30),
          },
          total: wireTokens(120, 60, 180),
        },
      }),
    );
    expect(mapped.main).toEqual({
      byModel: {
        // input folds into inputOther; cache buckets stay zero (not on the wire).
        'kimi-k2': { inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
        'kimi-lite': { inputOther: 20, output: 10, inputCacheRead: 0, inputCacheCreation: 0 },
      },
      total: { inputOther: 120, output: 60, inputCacheRead: 0, inputCacheCreation: 0 },
    });
  });

  it('omits main when the wire response has none (older daemons / cold sessions)', () => {
    const mapped = toAppTeamUsage(wireUsage());
    expect(mapped.main).toBeUndefined();
  });

  it('still maps runs / byModel / byMember alongside main', () => {
    const mapped = toAppTeamUsage(
      wireUsage({
        runs: 3,
        byModel: { 'kimi-k2': wireTokens(10, 5, 15) },
        byMember: { alpha: { 'kimi-k2': wireTokens(2, 1, 3) } },
        main: {
          byModel: { 'kimi-k2': wireTokens(4, 2, 6) },
          total: wireTokens(4, 2, 6),
        },
      }),
    );
    expect(mapped.runs).toBe(3);
    expect(mapped.byModel['kimi-k2']).toEqual({
      inputOther: 10,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(mapped.byMember['alpha']!['kimi-k2']!.output).toBe(1);
    expect(mapped.main!.byModel['kimi-k2']!.inputOther).toBe(4);
    expect(mapped.secondaryModelId).toBeNull();
  });
});
