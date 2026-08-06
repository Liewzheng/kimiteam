// apps/kimi-web/src/api/daemon/mappers.test.ts
// Pure wire→app mapper tests — no DOM, no Vue.
import { describe, expect, it } from 'vitest';
import type { WireTeamMember, WireTeamTokenUsage, WireTeamUsageResponse } from './wire';
import { toAppTeamMember, toAppTeamUsage } from './mappers';

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

describe('toAppTeamMember — three-state display model', () => {
  const wireMember = (partial: Partial<WireTeamMember> = {}): WireTeamMember => ({
    name: 'gu-wanqing',
    role: '前端工程师·交互与无障碍',
    description: '前端工程师「顾晚晴」,交互细节与无障碍专家',
    when_to_use: '需要实现交互逻辑、表单、动效、键盘导航时',
    model: 'kimi-k2',
    tools: ['Read', 'Edit'],
    status: 'resting',
    score: { average: 4.25, count: 3 },
    ...partial,
  });

  it('passes the three display states through unchanged', () => {
    for (const status of ['working', 'resting', 'off-duty'] as const) {
      expect(toAppTeamMember(wireMember({ status })).status).toBe(status);
    }
  });

  it('folds wire on-duty into resting (employed-but-idle → on-roster bucket)', () => {
    expect(toAppTeamMember(wireMember({ status: 'on-duty' })).status).toBe('resting');
  });

  it('carries duty + display_name through to the app member', () => {
    const mapped = toAppTeamMember(
      wireMember({ duty: true, display_name: '顾晚晴', status: 'resting' }),
    );
    expect(mapped.duty).toBe(true);
    expect(mapped.displayName).toBe('顾晚晴');
  });
});
