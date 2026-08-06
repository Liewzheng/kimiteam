// apps/kimi-web/src/lib/agentUsage.test.ts
import { describe, expect, it } from 'vitest';
import { formatUsage, hasUsage } from './agentUsage';
import type { AgentUsage } from '../types';

describe('hasUsage', () => {
  it('is false when the server sent no usage aggregate', () => {
    expect(hasUsage(undefined)).toBe(false);
  });

  it('is false for an all-zero summary (queued / not-yet-run subagent)', () => {
    expect(hasUsage({ input: 0, output: 0, total: 0 })).toBe(false);
  });

  it('is false for junk values (negative / NaN)', () => {
    expect(hasUsage({ input: -5, output: 0, total: 0 })).toBe(false);
    expect(hasUsage({ input: Number.NaN, output: 0, total: 0 })).toBe(false);
  });

  it('is true when input, output or total carries real consumption', () => {
    expect(hasUsage({ input: 12, output: 0, total: 12 })).toBe(true);
    expect(hasUsage({ input: 0, output: 3, total: 3 })).toBe(true);
    expect(hasUsage({ input: 0, output: 0, total: 100 })).toBe(true);
  });
});

describe('formatUsage', () => {
  it('formats input/output/total with the app-wide 1024-based token formatter', () => {
    const usage: AgentUsage = { input: 50552, output: 1536, total: 52088 };
    expect(formatUsage(usage)).toEqual({ input: '49.4k', output: '1.5k', total: '50.9k' });
  });

  it('falls back to input+output when the server total is still 0 mid-stream', () => {
    const usage: AgentUsage = { input: 1024, output: 2048, total: 0 };
    expect(formatUsage(usage)).toEqual({ input: '1k', output: '2k', total: '3k' });
  });

  it('coerces negative / NaN fields to zero instead of rendering garbage', () => {
    const usage = { input: -1, output: Number.NaN, total: 512 } as AgentUsage;
    expect(formatUsage(usage)).toEqual({ input: '0', output: '0', total: '512' });
  });

  it('renders an explicit "0" strip for an empty summary when forced', () => {
    expect(formatUsage({ input: 0, output: 0, total: 0 })).toEqual({
      input: '0',
      output: '0',
      total: '0',
    });
  });
});
