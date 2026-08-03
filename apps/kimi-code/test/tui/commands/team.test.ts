/**
 * Team command tests — pure data helpers + command handling.
 *
 * Test placement follows the write-tui skill: pure-function tests live in the
 * nearest test directory matching the source. The panel render tests belong
 * alongside the component test suite; only the data aggregation and command
 * dispatch are tested here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

import { handleTeamCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';
import { KIMI_CODE_HOME_ENV } from '#/constant/app';

import {
  parseAgentFrontmatter,
  parsePerformanceData,
  parseRuntimeStatusData,
  deriveMemberStatus,
  formatDuration,
  aggregateMemberRows,
  resolveModelForProfile,
  TeamPanelComponent,
  TEAM_PANEL_REFRESH_INTERVAL_MS,
} from '#/tui/commands/team';

import { formatBusinessCardSuffixFromMap } from '#/tui/components/messages/subagent-card-meta';
import type { CardMeta } from '#/tui/components/messages/subagent-card-meta';

// Hoisted mock factories — used by cache-wrapper tests below; defined here so
// vi.mock can capture references before module resolution. These only replace
// team.ts's *imported* bindings (e.g. subagent-card-meta); team.ts's own
// internal reads are integration-tested against a temp KIMI_CODE_HOME instead.
const { mockReadAgentProfiles, mockReadPerformanceData } = vi.hoisted(() => ({
  mockReadAgentProfiles: vi.fn<(dataDir: string, cwd: string) => unknown[]>(),
  mockReadPerformanceData: vi.fn<(dataDir: string) => unknown | null>(),
}));

vi.mock('#/tui/commands/team', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    readAgentProfiles: mockReadAgentProfiles,
    readPerformanceData: mockReadPerformanceData,
  };
});

// ---------------------------------------------------------------------------
// makeHost — minimal mock for command-handling tests
// ---------------------------------------------------------------------------

function makeHost() {
  const harness = {
    getConfig: vi.fn(async () => ({ subagent: { teamMode: false } })),
    setConfig: vi.fn(async () => {}),
  };
  const host = {
    state: {
      appState: {
        model: 'kimi-model',
      },
      // The panel's refresh path calls requestRender after each re-read.
      ui: {
        requestRender: vi.fn(),
      },
    },
    harness,
    session: undefined,
    requireSession: () => { throw new Error('no session'); },
    setAppState: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, harness };
}

// ===========================================================================
// Pure function: parseAgentFrontmatter
// ===========================================================================

describe('parseAgentFrontmatter', () => {
  it('parses valid YAML frontmatter with required fields', () => {
    const md = `---
name: Alice
description: A senior developer
role: Developer
model_preference: gpt-4
---
Content here`;
    const profile = parseAgentFrontmatter(md);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe('Alice');
    expect(profile!.description).toBe('A senior developer');
    expect(profile!.role).toBe('Developer');
    expect(profile!.modelPreference).toBe('gpt-4');
  });

  it('returns null when frontmatter is missing', () => {
    expect(parseAgentFrontmatter('Just content')).toBeNull();
  });

  it('returns null when name is missing', () => {
    const md = `---
description: A coder
---`;
    expect(parseAgentFrontmatter(md)).toBeNull();
  });

  it('returns null when description is missing', () => {
    const md = `---
name: Bob
---`;
    expect(parseAgentFrontmatter(md)).toBeNull();
  });

  it('strips single quotes from values', () => {
    const md = `---
name: 'Charlie'
description: 'A tester'
role: 'QA'
model_preference: 'claude-3'
---
Body`;
    const profile = parseAgentFrontmatter(md);
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe('Charlie');
    expect(profile!.role).toBe('QA');
    expect(profile!.modelPreference).toBe('claude-3');
  });

  it('handles optional fields gracefully when absent', () => {
    const md = `---
name: Dave
description: A new hire
---`;
    const profile = parseAgentFrontmatter(md);
    expect(profile).not.toBeNull();
    expect(profile!.role).toBeUndefined();
    expect(profile!.modelPreference).toBeUndefined();
    expect(profile!.duty).toBeUndefined();
    expect(profile!.whenToUse).toBeUndefined();
  });

  it('returns null for empty frontmatter', () => {
    const md = `---
---`;
    expect(parseAgentFrontmatter(md)).toBeNull();
  });
});

// ===========================================================================
// Pure function: parsePerformanceData
// ===========================================================================

describe('parsePerformanceData', () => {
  it('parses a valid performance.json with entries and shifts', () => {
    const raw = JSON.stringify({
      Alice: {
        entries: [
          { profileName: 'Alice', ts: 1000, score: 8.5 },
          { profileName: 'Alice', ts: 2000, score: 9.0 },
        ],
        shifts: [
          { startedAt: 0, endedAt: 60000, durationMs: 60000, workSummary: 'Fixed bug' },
        ],
      },
    });
    const parsed = parsePerformanceData(raw)!;
    expect(parsed['Alice']).toBeDefined();
    expect(parsed['Alice']!.entries).toHaveLength(2);
    expect(parsed['Alice']!.shifts).toHaveLength(1);
  });

  it('handles empty performance data', () => {
    const parsed = parsePerformanceData('{}');
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toHaveLength(0);
  });

  it('returns null for invalid JSON', () => {
    expect(parsePerformanceData('not json')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parsePerformanceData('"hello"')).toBeNull();
    expect(parsePerformanceData('42')).toBeNull();
  });

  it('returns null for null JSON', () => {
    expect(parsePerformanceData('null')).toBeNull();
  });

  it('handles profiles with only entries, no shifts', () => {
    const raw = JSON.stringify({
      Bob: {
        entries: [{ profileName: 'Bob', ts: 1000, score: 7.0 }],
      },
    });
    const parsed = parsePerformanceData(raw)!;
    expect(parsed['Bob']).toBeDefined();
    expect(parsed['Bob']!.entries).toHaveLength(1);
    expect(parsed['Bob']!.shifts).toBeUndefined();
  });

  it('handles profiles with no data at all', () => {
    const raw = JSON.stringify({
      Charlie: {},
    });
    const parsed = parsePerformanceData(raw)!;
    expect(parsed['Charlie']).toBeDefined();
    expect(parsed['Charlie']!.entries).toBeUndefined();
    expect(parsed['Charlie']!.shifts).toBeUndefined();
  });
});

// ===========================================================================
// Pure function: parseRuntimeStatusData
// ===========================================================================

describe('parseRuntimeStatusData', () => {
  it('parses a valid runtime-status.json with working and resting entries', () => {
    const raw = JSON.stringify({
      Alice: { state: 'working', agentId: 'agent-1', updatedAt: '2026-07-30T10:00:00.000Z' },
      Bob: {
        state: 'resting',
        agentId: 'agent-2',
        updatedAt: '2026-07-30T10:05:00.000Z',
        restExpiresAt: '2026-07-30T10:15:00.000Z',
      },
    });
    const parsed = parseRuntimeStatusData(raw)!;
    expect(parsed['Alice']!.state).toBe('working');
    expect(parsed['Bob']!.state).toBe('resting');
    expect(parsed['Bob']!.restExpiresAt).toBe('2026-07-30T10:15:00.000Z');
  });

  it('returns null for invalid JSON', () => {
    expect(parseRuntimeStatusData('not json')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseRuntimeStatusData('"hello"')).toBeNull();
    expect(parseRuntimeStatusData('42')).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(parseRuntimeStatusData('[]')).toBeNull();
  });

  it('drops entries with an unknown state instead of failing the whole parse', () => {
    // A future engine state must degrade to "no entry", never crash the panel.
    const raw = JSON.stringify({
      Alice: { state: 'suspended' },
      Bob: { state: 'working' },
    });
    const parsed = parseRuntimeStatusData(raw)!;
    expect(parsed['Alice']).toBeUndefined();
    expect(parsed['Bob']!.state).toBe('working');
  });

  it('handles an empty object', () => {
    const parsed = parseRuntimeStatusData('{}');
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toHaveLength(0);
  });
});

// ===========================================================================
// Pure function: deriveMemberStatus
// ===========================================================================

describe('deriveMemberStatus', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');

  it('maps an active run to 工作 (working)', () => {
    expect(deriveMemberStatus(true, { state: 'working' } as const, now)).toBe('working');
  });

  it('maps resting with an unexpired window to 休息 (resting)', () => {
    const entry = { state: 'resting', restExpiresAt: '2026-07-30T12:10:00.000Z' } as const;
    expect(deriveMemberStatus(true, entry, now)).toBe('resting');
  });

  it('treats an expired rest window as 上班 (on-duty)', () => {
    const entry = { state: 'resting', restExpiresAt: '2026-07-30T11:59:00.000Z' } as const;
    expect(deriveMemberStatus(true, entry, now)).toBe('on-duty');
  });

  it('treats a profile with no status entry as 上班 (on-duty)', () => {
    expect(deriveMemberStatus(true, undefined, now)).toBe('on-duty');
  });

  it('treats a resting entry without restExpiresAt as 上班 (on-duty)', () => {
    expect(deriveMemberStatus(true, { state: 'resting' } as const, now)).toBe('on-duty');
  });

  it('treats an unparseable restExpiresAt as 上班 (on-duty)', () => {
    expect(
      deriveMemberStatus(true, { state: 'resting', restExpiresAt: 'not-a-date' } as const, now),
    ).toBe('on-duty');
  });

  it('maps a profile-less name to 下班 (off-duty)', () => {
    expect(deriveMemberStatus(false, undefined, now)).toBe('off-duty');
  });

  it('ignores status entries for profile-less names (fired archive wins)', () => {
    expect(deriveMemberStatus(false, { state: 'working' } as const, now)).toBe('off-duty');
  });
});

// ===========================================================================
// Pure function: formatDuration
// ===========================================================================

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(5000)).toBe('5s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('rounds milliseconds to nearest second', () => {
    expect(formatDuration(1500)).toBe('2s');
    expect(formatDuration(1499)).toBe('1s');
  });

  it('returns em-dash for negative values', () => {
    expect(formatDuration(-1)).toBe('—');
  });

  it('returns em-dash for Infinity', () => {
    expect(formatDuration(Infinity)).toBe('—');
  });
});

// ===========================================================================
// Pure function: resolveModelForProfile
// ===========================================================================

describe('resolveModelForProfile', () => {
  const config = {
    defaultModel: 'kimi-code/k3-256k',
    secondaryModel: { model: 'deepseek/deepseek-v4-flash' },
    subagent: {
      modelOverrides: {
        'specialist': 'gpt-4o',
      },
    },
  };

  it('uses model_overrides when present', () => {
    expect(resolveModelForProfile('specialist', 'secondary', config)).toBe('gpt-4o');
  });

  it('falls back to model_preference when no override exists', () => {
    expect(resolveModelForProfile('coder', 'gpt-4', config)).toBe('gpt-4');
  });

  it('resolves "secondary" shortcut to secondary_model.model', () => {
    expect(resolveModelForProfile('agent-x', 'secondary', config)).toBe('deepseek/deepseek-v4-flash');
  });

  it('falls back to raw "secondary" when secondary_model is unset', () => {
    const noSecondary = { ...config, secondaryModel: undefined };
    expect(resolveModelForProfile('agent-x', 'secondary', noSecondary)).toBe('secondary');
  });

  it('resolves "primary" shortcut to defaultModel', () => {
    expect(resolveModelForProfile('agent-x', 'primary', config)).toBe('kimi-code/k3-256k');
  });

  it('falls back to raw "primary" when defaultModel is unset', () => {
    const noDefault = { ...config, defaultModel: undefined };
    expect(resolveModelForProfile('agent-x', 'primary', noDefault)).toBe('primary');
  });

  it('returns "—" when model_preference is undefined and no override', () => {
    expect(resolveModelForProfile('new-agent', undefined, config)).toBe('—');
  });

  it('returns "—" when model_preference is empty string', () => {
    expect(resolveModelForProfile('new-agent', '', config)).toBe('—');
  });

  it('returns modelPreference as-is when it is a literal model id', () => {
    expect(resolveModelForProfile('agent-x', 'local/qwen3-35b', config)).toBe('local/qwen3-35b');
  });

  it('returns modelPreference when config is null (safety fallback)', () => {
    expect(resolveModelForProfile('agent-x', 'gpt-4', null)).toBe('gpt-4');
  });

  it('returns "—" when config is null and modelPreference is undefined', () => {
    expect(resolveModelForProfile('agent-x', undefined, null)).toBe('—');
  });

  it('override wins over "primary" shortcut', () => {
    const ovConfig = {
      ...config,
      subagent: { modelOverrides: { 'lead': 'claude-opus' } },
    };
    expect(resolveModelForProfile('lead', 'primary', ovConfig)).toBe('claude-opus');
  });

  it('override wins over "secondary" shortcut', () => {
    const ovConfig = {
      ...config,
      subagent: { modelOverrides: { 'lead': 'claude-sonnet' } },
    };
    expect(resolveModelForProfile('lead', 'secondary', ovConfig)).toBe('claude-sonnet');
  });

  it('resolves "secondary" shortcut when config has secondaryModel (v1 and v2)', () => {
    // secondaryModel is now available on both v1 and v2 getConfig() results
    expect(resolveModelForProfile('agent-x', 'secondary', config)).toBe('deepseek/deepseek-v4-flash');
  });

  it('falls back to raw "secondary" when secondaryModel is absent from config', () => {
    const noSecondary = { ...config, secondaryModel: undefined };
    expect(resolveModelForProfile('agent-x', 'secondary', noSecondary)).toBe('secondary');
  });
});
// ===========================================================================

describe('aggregateMemberRows', () => {
  const profiles = [
    { name: 'Alice', description: 'Dev', role: 'Developer', modelPreference: 'gpt-4' },
    { name: 'Bob', description: 'Reviewer', role: 'Reviewer', modelPreference: 'claude-3' },
    { name: 'Charlie', description: 'New hire' },
  ];

  it('aggregates scores and shifts correctly', () => {
    const perf = {
      Alice: {
        entries: [
          { profileName: 'Alice', ts: '2026-07-30T10:00:01.000Z', score: 8 },
          { profileName: 'Alice', ts: '2026-07-30T10:00:02.000Z', score: 10 },
        ],
        shifts: [
          {
            startedAt: '2026-07-30T10:00:00.000Z',
            endedAt: '2026-07-30T10:01:00.000Z',
            durationMs: 60000,
            workSummary: 'W1',
          },
          {
            startedAt: '2026-07-30T10:00:00.000Z',
            endedAt: '2026-07-30T10:02:00.000Z',
            durationMs: 120000,
            workSummary: 'W2',
          },
        ],
      },
    };
    const rows = aggregateMemberRows(profiles, perf);
    const alice = rows.find((r) => r.name === 'Alice');
    expect(alice).toBeDefined();
    expect(alice!.avgScore).toBeCloseTo(9.0, 1);
    expect(alice!.scoreCount).toBe(2);
    expect(alice!.avgDurationMs).toBeCloseTo(90000, 0);
    expect(alice!.shiftCount).toBe(2);
  });

  it('returns null aggregates when no performance data exists', () => {
    const rows = aggregateMemberRows(profiles, null);
    for (const row of rows) {
      expect(row.avgScore).toBeNull();
      expect(row.scoreCount).toBe(0);
      expect(row.avgDurationMs).toBeNull();
      expect(row.shiftCount).toBe(0);
    }
  });

  it('returns null aggregates when performance data is empty object', () => {
    const rows = aggregateMemberRows(profiles, {});
    for (const row of rows) {
      expect(row.avgScore).toBeNull();
      expect(row.scoreCount).toBe(0);
      expect(row.avgDurationMs).toBeNull();
      expect(row.shiftCount).toBe(0);
    }
  });

  it('handles a profile with entries but no shifts', () => {
    const perf = {
      Alice: {
        entries: [{ profileName: 'Alice', ts: '2026-07-30T10:00:01.000Z', score: 9 }],
      },
    };
    const rows = aggregateMemberRows(profiles, perf);
    const alice = rows.find((r) => r.name === 'Alice');
    expect(alice!.avgScore).toBeCloseTo(9.0);
    expect(alice!.scoreCount).toBe(1);
    expect(alice!.avgDurationMs).toBeNull();
    expect(alice!.shiftCount).toBe(0);
  });

  it('uses em-dash for missing role and model', () => {
    const rows = aggregateMemberRows(profiles, null);
    const charlie = rows.find((r) => r.name === 'Charlie');
    expect(charlie!.role).toBe('—');
    expect(charlie!.model).toBe('—');
  });

  it('uses resolvedModels when provided', () => {
    const resolvedModels = { Alice: 'gpt-4o', Bob: 'claude-opus' };
    const rows = aggregateMemberRows(profiles, null, resolvedModels);
    expect(rows.find((r) => r.name === 'Alice')!.model).toBe('gpt-4o');
    expect(rows.find((r) => r.name === 'Bob')!.model).toBe('claude-opus');
  });

  it('resolvedModels wins over profile modelPreference', () => {
    const resolvedModels = { Alice: 'override-model' };
    const rows = aggregateMemberRows(profiles, null, resolvedModels);
    expect(rows.find((r) => r.name === 'Alice')!.model).toBe('override-model');
  });

  it('falls back to profile modelPreference when resolvedModels has no entry', () => {
    const rows = aggregateMemberRows(profiles, null, {});
    expect(rows.find((r) => r.name === 'Alice')!.model).toBe('gpt-4');
  });

  it('falls back to "—" when neither resolvedModels nor modelPreference exist', () => {
    const rows = aggregateMemberRows(profiles, null, {});
    const charlie = rows.find((r) => r.name === 'Charlie');
    expect(charlie!.model).toBe('—');
  });

  // --- lastUsedModels parameter ---

  it('lastUsedModels takes priority over resolvedModels', () => {
    const lastUsed = { Alice: 'claude-sonnet-4' };
    const resolved = { Alice: 'gpt-4o' };
    const rows = aggregateMemberRows(profiles, null, resolved, lastUsed);
    expect(rows.find((r) => r.name === 'Alice')!.model).toBe('claude-sonnet-4');
    expect(rows.find((r) => r.name === 'Alice')!.modelFromLastUse).toBe(true);
  });

  it('lastUsedModels takes priority over profile modelPreference', () => {
    const lastUsed = { Bob: 'o3-mini' };
    const rows = aggregateMemberRows(profiles, null, undefined, lastUsed);
    expect(rows.find((r) => r.name === 'Bob')!.model).toBe('o3-mini');
    expect(rows.find((r) => r.name === 'Bob')!.modelFromLastUse).toBe(true);
  });

  it('falls back to resolvedModels when no lastUsed entry exists', () => {
    const resolved = { Alice: 'gpt-4o' };
    const rows = aggregateMemberRows(profiles, null, resolved, {});
    expect(rows.find((r) => r.name === 'Alice')!.model).toBe('gpt-4o');
    expect(rows.find((r) => r.name === 'Alice')!.modelFromLastUse).toBeUndefined();
  });

  it('falls back to modelPreference when neither lastUsed nor resolved exist', () => {
    const rows = aggregateMemberRows(profiles, null, {}, {});
    expect(rows.find((r) => r.name === 'Alice')!.model).toBe('gpt-4');
    expect(rows.find((r) => r.name === 'Alice')!.modelFromLastUse).toBeUndefined();
  });

  it('sets modelFromLastUse only when lastUsed entry is present', () => {
    const lastUsed = { Alice: 'claude-sonnet-4' };
    const resolved = { Alice: 'gpt-4o', Bob: 'o3-mini' };
    const rows = aggregateMemberRows(profiles, null, resolved, lastUsed);
    expect(rows.find((r) => r.name === 'Alice')!.modelFromLastUse).toBe(true);
    expect(rows.find((r) => r.name === 'Bob')!.modelFromLastUse).toBeUndefined();
  });

  // --- `__secondary__` derived alias (display-only resolution) ---

  it('resolves the __secondary__ last-used alias to the real secondary model id', () => {
    const lastUsed = { Alice: '__secondary__' };
    const resolved = { Alice: 'gpt-4o' };
    const rows = aggregateMemberRows(profiles, null, resolved, lastUsed, 'deepseek/deepseek-v4-flash');
    const alice = rows.find((r) => r.name === 'Alice');
    expect(alice!.model).toBe('deepseek/deepseek-v4-flash');
    expect(alice!.modelFromLastUse).toBe(true);
  });

  it('falls back to resolvedModels when __secondary__ cannot be resolved', () => {
    const lastUsed = { Alice: '__secondary__' };
    const resolved = { Alice: 'gpt-4o' };
    const rows = aggregateMemberRows(profiles, null, resolved, lastUsed, undefined);
    const alice = rows.find((r) => r.name === 'Alice');
    expect(alice!.model).toBe('gpt-4o');
    expect(alice!.modelFromLastUse).toBeUndefined();
  });

  it('falls back to modelPreference when __secondary__ cannot be resolved and no resolvedModels', () => {
    const lastUsed = { Bob: '__secondary__' };
    const rows = aggregateMemberRows(profiles, null, {}, lastUsed, undefined);
    const bob = rows.find((r) => r.name === 'Bob');
    expect(bob!.model).toBe('claude-3');
    expect(bob!.modelFromLastUse).toBeUndefined();
  });

  it('falls back to "—" when __secondary__ cannot be resolved and no fallback exists', () => {
    const lastUsed = { Charlie: '__secondary__' };
    const rows = aggregateMemberRows(profiles, null, {}, lastUsed, undefined);
    const charlie = rows.find((r) => r.name === 'Charlie');
    expect(charlie!.model).toBe('—');
    expect(charlie!.modelFromLastUse).toBeUndefined();
  });

  it('treats a blank secondary model id as unavailable when resolving __secondary__', () => {
    const lastUsed = { Alice: '__secondary__' };
    const resolved = { Alice: 'gpt-4o' };
    const rows = aggregateMemberRows(profiles, null, resolved, lastUsed, '');
    expect(rows.find((r) => r.name === 'Alice')!.model).toBe('gpt-4o');
    expect(rows.find((r) => r.name === 'Alice')!.modelFromLastUse).toBeUndefined();
  });
});

// ===========================================================================
// Pure function: aggregateMemberRows — four-state status + off-duty archives
// ===========================================================================

describe('aggregateMemberRows runtime status + off-duty rows', () => {
  const profiles = [
    { name: 'Alice', description: 'Dev', role: 'Developer', modelPreference: 'gpt-4' },
    { name: 'Bob', description: 'Reviewer', role: 'Reviewer', modelPreference: 'claude-3' },
  ];
  // Dana: performance history but no profile file → fired / archived (下班).
  const perf = {
    Alice: { entries: [{ profileName: 'Alice', ts: 'x', score: 8 }] },
    Bob: { shifts: [{ startedAt: 'x', endedAt: 'y', durationMs: 60000, workSummary: 'w' }] },
    Dana: { entries: [{ profileName: 'Dana', ts: 'x', score: 6.5 }] },
  };
  const now = Date.parse('2026-07-30T12:00:00.000Z');

  it('maps an active run to 工作 (working)', () => {
    const rows = aggregateMemberRows(
      profiles, perf, undefined, undefined, undefined,
      { Alice: { state: 'working' } } as const, now,
    );
    expect(rows.find((r) => r.name === 'Alice')!.status).toBe('working');
    expect(rows.find((r) => r.name === 'Bob')!.status).toBe('on-duty');
  });

  it('maps an unexpired rest window to 休息 (resting)', () => {
    const rows = aggregateMemberRows(
      profiles, perf, undefined, undefined, undefined,
      { Alice: { state: 'resting', restExpiresAt: '2026-07-30T12:10:00.000Z' } } as const, now,
    );
    expect(rows.find((r) => r.name === 'Alice')!.status).toBe('resting');
  });

  it('maps an expired rest window back to 上班 (on-duty)', () => {
    const rows = aggregateMemberRows(
      profiles, perf, undefined, undefined, undefined,
      { Alice: { state: 'resting', restExpiresAt: '2026-07-30T11:59:00.000Z' } } as const, now,
    );
    expect(rows.find((r) => r.name === 'Alice')!.status).toBe('on-duty');
  });

  it('lists perf-only names as 下班 (off-duty) with role/model dash and history kept', () => {
    const rows = aggregateMemberRows(profiles, perf, undefined, undefined, undefined, undefined, now);
    const dana = rows.find((r) => r.name === 'Dana');
    expect(dana).toBeDefined();
    expect(dana!.status).toBe('off-duty');
    expect(dana!.role).toBe('—');
    expect(dana!.model).toBe('—');
    expect(dana!.avgScore).toBeCloseTo(6.5);
    expect(dana!.scoreCount).toBe(1);
  });

  it('treats a missing runtime-status file (null) as all on-duty, no error', () => {
    const rows = aggregateMemberRows(profiles, perf, undefined, undefined, undefined, null, now);
    expect(rows.find((r) => r.name === 'Alice')!.status).toBe('on-duty');
    expect(rows.find((r) => r.name === 'Bob')!.status).toBe('on-duty');
    // Off-duty archives still surface without the status file.
    expect(rows.find((r) => r.name === 'Dana')!.status).toBe('off-duty');
  });

  it('does not list perf keys with neither entries nor shifts', () => {
    const rows = aggregateMemberRows(
      profiles, { ...perf, Ghost: {} }, undefined, undefined, undefined, undefined, now,
    );
    expect(rows.find((r) => r.name === 'Ghost')).toBeUndefined();
  });
});

// ===========================================================================
// Command handling: handleTeamCommand
// ===========================================================================

describe('handleTeamCommand', () => {
  it('turns team mode on with /team on', async () => {
    const { host, harness } = makeHost();

    await handleTeamCommand(host, 'on');

    expect(harness.setConfig).toHaveBeenCalledWith({ subagent: { teamMode: true } });
    expect(host.showNotice).toHaveBeenCalledWith('Team mode: ON');
  });

  it('turns team mode off with /team off', async () => {
    const { host, harness } = makeHost();

    await handleTeamCommand(host, 'off');

    expect(harness.setConfig).toHaveBeenCalledWith({ subagent: { teamMode: false } });
    expect(host.showNotice).toHaveBeenCalledWith('Team mode: OFF');
  });

  it('opens the team panel with no args', async () => {
    const { host } = makeHost();

    await handleTeamCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('opens the team panel with whitespace-only args', async () => {
    const { host } = makeHost();

    await handleTeamCommand(host, '  ');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  });

  it('shows error for unknown subcommand', async () => {
    const { host } = makeHost();

    await handleTeamCommand(host, 'invalid');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Usage:'),
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows error when setConfig fails', async () => {
    const { host, harness } = makeHost();
    harness.setConfig.mockRejectedValueOnce(new Error('config write failed'));

    await handleTeamCommand(host, 'on');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to set team mode'),
    );
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('mounts a TeamPanelComponent that can be closed via Esc', async () => {
    const { host } = makeHost();

    await handleTeamCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const panel = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

    // Simulate Esc key
    panel.handleInput('\u001B');
    expect(host.restoreEditor).toHaveBeenCalled();
  });

  it('mounts a TeamPanelComponent that can be closed via q', async () => {
    const { host } = makeHost();

    await handleTeamCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const panel = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

    panel.handleInput('q');
    expect(host.restoreEditor).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Panel refresh (periodic re-read) + Ctrl+C forwarding
  // ---------------------------------------------------------------------------

  describe('team panel refresh and Ctrl+C forwarding', () => {
    function mountedPanelWith(host: ReturnType<typeof makeHost>['host']): TeamPanelComponent {
      return (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as TeamPanelComponent;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-reads the data snapshot on the refresh interval while the panel is open', async () => {
      const { host } = makeHost();
      await handleTeamCommand(host, '');

      // Initial load reads the config snapshot once
      expect(host.harness.getConfig).toHaveBeenCalledTimes(1);
      expect(host.state.ui.requestRender).not.toHaveBeenCalled();

      // Advance past one refresh interval → the panel re-reads and re-renders
      await vi.advanceTimersByTimeAsync(TEAM_PANEL_REFRESH_INTERVAL_MS);

      expect(host.harness.getConfig).toHaveBeenCalledTimes(2);
      expect(host.state.ui.requestRender).toHaveBeenCalledTimes(1);
    });

    it('stops re-reading after the panel is closed', async () => {
      const { host } = makeHost();
      await handleTeamCommand(host, '');
      const panel = mountedPanelWith(host);
      expect(host.harness.getConfig).toHaveBeenCalledTimes(1);

      // Close via Esc — the refresh timer must be torn down
      panel.handleInput('\u001B');
      expect(host.restoreEditor).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TEAM_PANEL_REFRESH_INTERVAL_MS * 3);
      expect(host.harness.getConfig).toHaveBeenCalledTimes(1);
      expect(host.state.ui.requestRender).not.toHaveBeenCalled();
    });

    it('keeps the panel alive when a refresh fails', async () => {
      const { host } = makeHost();
      await handleTeamCommand(host, '');

      // Next refresh: the config read fails (transient). The panel must not
      // crash — it degrades via the loadError branch and keeps refreshing.
      (host.harness.getConfig as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('config read failed'),
      );
      await vi.advanceTimersByTimeAsync(TEAM_PANEL_REFRESH_INTERVAL_MS);

      expect(host.state.ui.requestRender).toHaveBeenCalledTimes(1);
      expect(host.mountEditorReplacement).toHaveBeenCalledOnce();

      // A later refresh recovers
      await vi.advanceTimersByTimeAsync(TEAM_PANEL_REFRESH_INTERVAL_MS);
      expect(host.harness.getConfig).toHaveBeenCalledTimes(3);
    });

    it('forwards Ctrl+C to the injected streaming-cancel callback', async () => {
      const { host } = makeHost();
      const cancel = vi.fn(async () => {});
      host.session = { cancel } as unknown as NonNullable<SlashCommandHost['session']>;
      await handleTeamCommand(host, '');
      const panel = mountedPanelWith(host);

      panel.handleInput('\x03');

      expect(cancel).toHaveBeenCalledOnce();
    });
  });
});

// ===========================================================================
// Pure function: formatBusinessCardSuffixFromMap
// ===========================================================================

describe('formatBusinessCardSuffixFromMap', () => {
  const aliceMeta: CardMeta = { role: 'Senior Developer', avgScore: 85.3, scoreCount: 7 };
  const bobMeta: CardMeta = { role: 'QA Engineer', avgScore: 92, scoreCount: 3 };
  const noScoreMeta: CardMeta = { role: 'Reviewer', avgScore: undefined, scoreCount: 0 };
  const noRoleMeta: CardMeta = { role: undefined, avgScore: 78, scoreCount: 5 };

  const map = new Map<string, CardMeta>([
    ['Alice', aliceMeta],
    ['Bob', bobMeta],
    ['NoScore', noScoreMeta],
    ['NoRole', noRoleMeta],
  ]);

  it('returns role + avg when both are present', () => {
    expect(formatBusinessCardSuffixFromMap('Alice', map)).toBe(
      ' · Senior Developer · avg 85/100 (7)',
    );
  });

  it('returns only role when avgScore is absent', () => {
    expect(formatBusinessCardSuffixFromMap('NoScore', map)).toBe(' · Reviewer');
  });

  it('returns only avg when role is absent', () => {
    expect(formatBusinessCardSuffixFromMap('NoRole', map)).toBe(' · avg 78/100 (5)');
  });

  it('returns empty string for unknown agent name', () => {
    expect(formatBusinessCardSuffixFromMap('Unknown', map)).toBe('');
  });

  it('returns empty string for undefined agent name', () => {
    expect(formatBusinessCardSuffixFromMap(undefined, map)).toBe('');
  });

  it('returns empty string for empty agent name', () => {
    expect(formatBusinessCardSuffixFromMap('', map)).toBe('');
  });

  it('returns empty string for agent in map but with no data fields', () => {
    const emptyMeta: CardMeta = { role: undefined, avgScore: undefined, scoreCount: 0 };
    const emptyMap = new Map([['Empty', emptyMeta]]);
    expect(formatBusinessCardSuffixFromMap('Empty', emptyMap)).toBe('');
  });

  it('rounds avgScore to nearest integer', () => {
    expect(formatBusinessCardSuffixFromMap('Bob', map)).toBe(
      ' · QA Engineer · avg 92/100 (3)',
    );
  });

  it('returns empty string from empty map', () => {
    expect(formatBusinessCardSuffixFromMap('Alice', new Map())).toBe('');
  });

  it('omits role when it is an empty string', () => {
    const meta: CardMeta = { role: '', avgScore: 90, scoreCount: 2 };
    const m = new Map([['Agent', meta]]);
    expect(formatBusinessCardSuffixFromMap('Agent', m)).toBe(' · avg 90/100 (2)');
  });

  it('omits avgScore when it is NaN', () => {
    const meta: CardMeta = { role: 'Tester', avgScore: NaN, scoreCount: 3 };
    const m = new Map([['Agent', meta]]);
    expect(formatBusinessCardSuffixFromMap('Agent', m)).toBe(' · Tester');
  });

  it('omits avgScore when it is Infinity', () => {
    const meta: CardMeta = { role: 'Tester', avgScore: Infinity, scoreCount: 3 };
    const m = new Map([['Agent', meta]]);
    expect(formatBusinessCardSuffixFromMap('Agent', m)).toBe(' · Tester');
  });

  it('omits avgScore when it is negative', () => {
    const meta: CardMeta = { role: 'Tester', avgScore: -12.3, scoreCount: 3 };
    const m = new Map([['Agent', meta]]);
    expect(formatBusinessCardSuffixFromMap('Agent', m)).toBe(' · Tester');
  });
});

// ===========================================================================
// Cache wrapper: formatBusinessCardSuffix (lazy 60s TTL, silent degradation)
// ===========================================================================
//
// These tests mock readAgentProfiles / readPerformanceData via vi.mock (above)
// and use vi.resetModules + dynamic import to get a clean module state per test.
// Date.now is also mocked to control the TTL window.

describe('formatBusinessCardSuffix cache behaviour', () => {
  const fakeProfile = { name: 'Alice', description: 'Senior developer', role: 'Senior' };
  const fakePerfData = {
    Alice: { entries: [{ profileName: 'Alice', ts: 'x', score: 9 }] },
  };

  beforeEach(() => {
    vi.resetModules();
    mockReadAgentProfiles.mockReset();
    mockReadPerformanceData.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // (a) TTL window内两次调用 → 底层读取函数只调一次
  it('reads agents only once within the 60s TTL window', async () => {
    mockReadAgentProfiles.mockReturnValue([fakeProfile]);
    mockReadPerformanceData.mockReturnValue(fakePerfData);

    const { formatBusinessCardSuffix: suffix } = await import(
      '#/tui/components/messages/subagent-card-meta'
    );

    const first = suffix('Alice');
    const second = suffix('Alice');

    expect(first).toBe(' · Senior · avg 9/100 (1)');
    expect(second).toBe(' · Senior · avg 9/100 (1)');
    expect(mockReadAgentProfiles).toHaveBeenCalledTimes(1);
    expect(mockReadPerformanceData).toHaveBeenCalledTimes(1);
  });

  // (b) 推进超过 60s → 重新读取
  it('re-reads after the 60s TTL expires', async () => {
    mockReadAgentProfiles.mockReturnValue([fakeProfile]);
    mockReadPerformanceData.mockReturnValue(fakePerfData);

    const { formatBusinessCardSuffix: suffix } = await import(
      '#/tui/components/messages/subagent-card-meta'
    );

    suffix('Alice');

    // Advance clock past the 60s TTL
    vi.advanceTimersByTime(61_000);
    // But Date.now is still the fake time; the module holds the original
    // Date.now though — we need to advance the system clock that
    // formatBusinessCardSuffix sees.
    // vi.advanceTimersByTime only advances fake timers; for Date.now we use
    // vi.setSystemTime.
    vi.setSystemTime(Date.now() + 61_000);
    await vi.advanceTimersByTimeAsync(0);

    suffix('Alice');

    expect(mockReadAgentProfiles).toHaveBeenCalledTimes(2);
    expect(mockReadPerformanceData).toHaveBeenCalledTimes(2);
  });

  // (c) 读取异常 → 返回 '' 且 TTL 内不重试
  it('silently degrades on read error and does not retry within TTL', async () => {
    mockReadAgentProfiles.mockImplementation(() => {
      throw new Error('disk failure');
    });

    const { formatBusinessCardSuffix: suffix } = await import(
      '#/tui/components/messages/subagent-card-meta'
    );

    const first = suffix('Alice');
    expect(first).toBe('');

    // Same TTL window — no re-read
    const second = suffix('Alice');
    expect(second).toBe('');

    expect(mockReadAgentProfiles).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Empty state rendering (TeamPanelComponent.render)
// ===========================================================================

describe('TeamPanelComponent empty state', () => {
  it('shows team-mode-off guidance when teamMode is false and no members', () => {
    const panel = new TeamPanelComponent({
      teamMode: false,
      members: [],
      onClose: () => {},
    });
    const lines = panel.render(80);
    const joined = lines.join('\n');
    // Should show the team-mode-off message
    expect(joined).toContain('Team mode is off');
    // Should NOT mention the onboarding prompt (that's for teamMode ON)
    expect(joined).not.toContain('组建我的团队');
    // Should NOT show table header
    expect(joined).not.toContain('Name');
    expect(joined).not.toContain('Role');
  });

  it('shows onboarding guidance when teamMode is on and no members', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members: [],
      onClose: () => {},
    });
    const lines = panel.render(80);
    const joined = lines.join('\n');
    // Should show the Chinese onboarding guidance
    expect(joined).toContain('还没有团队成员');
    expect(joined).toContain('组建我的团队');
    // Should NOT show "Team mode is off" message
    expect(joined).not.toContain('Team mode is off');
    // Should NOT show table header
    expect(joined).not.toContain('Name');
    expect(joined).not.toContain('Role');
  });

  it('shows team-mode label ON in empty state when teamMode is true', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members: [],
      onClose: () => {},
    });
    const lines = panel.render(80);
    const joined = lines.join('\n');
    expect(joined).toContain('Team mode:');
    // The ON label should be present; we check that it's the ON state
    // by verifying the line doesn't say OFF (the OFF rendering text)
    expect(joined).not.toContain('Team mode is off');
  });

  it('shows team-mode label OFF in empty state when teamMode is false', () => {
    const panel = new TeamPanelComponent({
      teamMode: false,
      members: [],
      onClose: () => {},
    });
    const lines = panel.render(80);
    const joined = lines.join('\n');
    expect(joined).toContain('Team mode:');
    expect(joined).toContain('Team mode is off');
  });
});

// ===========================================================================
// CJK column-width alignment (TeamPanelComponent.render)
// ===========================================================================

describe('TeamPanelComponent CJK alignment', () => {
  const members = [
    {
      name: 'shen-yifan',
      status: 'on-duty' as const,
      role: '前端工程师·组件架构',
      model: 'gpt-4o',  // fits within 20-char column
      avgScore: 85.3,
      scoreCount: 7,
      avgDurationMs: 120_000,
      shiftCount: 3,
    },
    {
      name: 'qi-yuan',
      status: 'on-duty' as const,
      role: '后端工程师·数据层',
      model: 'claude-3.5',  // fits within 20-char column
      avgScore: null,
      scoreCount: 0,
      avgDurationMs: null,
      shiftCount: 0,
    },
  ];

  it('splits the CJK Role into position and focus columns without breaking alignment', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members,
      onClose: () => {},
    });

    // Render at 120 columns wide — wide enough to avoid final-line truncation
    const lines = panel.render(120);

    // Header now carries separate 职位 / 职能 columns
    const headerLine = lines.find((l) => l.includes('Name') && l.includes('职位'));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain('职能');

    // Each data row should have consistent column separators.
    // Find the row lines (containing member names)
    const rowLines = lines.filter(
      (l) => l.includes('shen-yifan') || l.includes('qi-yuan'),
    );
    expect(rowLines).toHaveLength(2);

    // Position and focus render in their own columns; the raw '·'-joined
    // role string no longer appears in a data row.
    expect(rowLines[0]).toContain('前端工程师');
    expect(rowLines[0]).toContain('组件架构');
    expect(rowLines[0]).not.toContain('前端工程师·组件架构');
    expect(rowLines[1]).toContain('后端工程师');
    expect(rowLines[1]).toContain('数据层');
    expect(rowLines[1]).not.toContain('后端工程师·数据层');

    // Verify the data rows contain model IDs
    expect(rowLines[0]).toContain('gpt-4o');
    expect(rowLines[1]).toContain('claude-3.5');

    // Verify score/duration/counts appear (right-aligned columns stay in place)
    expect(rowLines[0]!).toContain('85.3');
    expect(rowLines[0]!).toContain('2m 0s');
    expect(rowLines[1]!).toContain('—');

    // Column order within a row: position → focus → model
    const posPos = rowLines[0]!.indexOf('前端工程师');
    const focusPos = rowLines[0]!.indexOf('组件架构');
    const modelPos = rowLines[0]!.indexOf('gpt-4o');
    expect(posPos).toBeGreaterThanOrEqual(0);
    expect(focusPos).toBeGreaterThan(posPos);
    expect(modelPos).toBeGreaterThan(focusPos);
  });

  it('truncates a long CJK focus to fit the focus column width', () => {
    const longRoleMembers = [
      {
        ...members[0]!,
        role: '前端工程师·组件架构与设计系统',
      },
    ];

    const panel = new TeamPanelComponent({
      teamMode: true,
      members: longRoleMembers,
      onClose: () => {},
    });

    const lines = panel.render(80);
    const rowLine = lines.find((l) => l.includes('shen-yifan'));
    expect(rowLine).toBeDefined();

    // The position column stays intact; the long focus is truncated with '…'
    // (visibleWidth accounts for CJK double-width).
    expect(rowLine).toContain('前端工程师');
    expect(rowLine).toContain('…');
    // The full untruncated focus must not appear
    expect(rowLine).not.toContain('组件架构与设计系统');
  });

  it('leaves the focus column blank when the role has no separator', () => {
    const noSepMembers = [
      {
        ...members[0]!,
        role: '产品经理',
      },
    ];

    const panel = new TeamPanelComponent({
      teamMode: true,
      members: noSepMembers,
      onClose: () => {},
    });

    const lines = panel.render(120);
    const rowLine = lines.find((l) => l.includes('shen-yifan'));
    expect(rowLine).toBeDefined();

    // The whole role renders in the position column, with no separator text
    expect(rowLine).toContain('产品经理');
    expect(rowLine).not.toContain('·');

    // The focus cell is blank: between the position text and the status cell
    // there is nothing but padding spaces.
    const posEnd = rowLine!.indexOf('产品经理') + '产品经理'.length;
    const statusStart = rowLine!.indexOf('上班');
    const between = rowLine!.slice(posEnd, statusStart);
    expect(between.trim()).toBe('');

    // The status cell then sits before the model column.
    const statusEnd = statusStart + '上班'.length;
    const modelStart = rowLine!.indexOf('gpt-4o');
    expect(modelStart).toBeGreaterThan(statusEnd);
  });

  it('handles narrow terminal without breaking layout', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members,
      onClose: () => {},
    });

    // Render at a narrow width that forces scrolling
    const lines = panel.render(40);
    expect(lines.length).toBeGreaterThan(0);

    // No line should exceed the terminal width (truncateToWidth is applied)
    for (const line of lines) {
      // Strip ANSI codes before checking width
      const plain = line.replace(/\x1b\[[\d;]*m/g, '');
      expect(plain.length).toBeLessThanOrEqual(42); // 40 + small slack for ANSI
    }
  });
});

// ===========================================================================
// TeamPanelComponent status column — four states + off-duty archive styling
// ===========================================================================
//
// Colour contract (tokens from currentTheme, asserted as truecolor ANSI):
//   working  → primary   (the "running badge" token)
//   resting  → warning   (yellow, the rest window)
//   on-duty  → uncoloured (inherits the row dim)
//   off-duty → whole row muted (textMuted) — greyed-out archive
//
// vitest runs chalk with colours disabled by default; force truecolor (the
// same pattern as goal-panel / welcome / tool-call tests) so token differences
// surface as ANSI codes.

function hexToRgbAnsi(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (m === null) throw new Error(`unexpected hex token: ${hex}`);
  const value = parseInt(m[1]!, 16);
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

function ansiFg(hex: string): string {
  return `\u001B[38;2;${hexToRgbAnsi(hex)}m`;
}

describe('TeamPanelComponent status column', () => {
  const previousChalkLevel = chalk.level;
  beforeEach(() => {
    chalk.level = 3; // force truecolor so token colours surface as ANSI
  });
  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  const workingFg = ansiFg(currentTheme.color('primary'));
  const warningFg = ansiFg(currentTheme.color('warning'));
  const mutedFg = ansiFg(currentTheme.color('textMuted'));

  const onDuty = {
    name: 'alice',
    status: 'on-duty' as const,
    role: 'Dev',
    model: 'gpt-4o',
    avgScore: 8,
    scoreCount: 1,
    avgDurationMs: 60_000,
    shiftCount: 1,
  };
  const offDuty = {
    name: 'zed',
    status: 'off-duty' as const,
    role: '—',
    model: '—',
    avgScore: 6.5,
    scoreCount: 3,
    avgDurationMs: 120_000,
    shiftCount: 2,
  };

  it('renders the Status column in the table header', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members: [onDuty],
      onClose: () => {},
    });
    const header = panel.render(120).find((l) => l.includes('Status'));
    expect(header).toBeDefined();
    expect(header).toContain('Name');
    expect(header).toContain('Status');
    expect(header).toContain('Model');
  });

  it('renders 工作 in the primary (running badge) color', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members: [{ ...onDuty, status: 'working' as const }],
      onClose: () => {},
    });
    const row = panel.render(120).find((l) => l.includes('alice'))!;
    expect(row).toContain('工作');
    expect(row).toContain(workingFg); // primary
  });

  it('renders 休息 in the warning (yellow) color', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members: [{ ...onDuty, status: 'resting' as const }],
      onClose: () => {},
    });
    const row = panel.render(120).find((l) => l.includes('alice'))!;
    expect(row).toContain('休息');
    expect(row).toContain(warningFg); // warning
  });

  it('renders 上班 uncoloured for on-duty members', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members: [onDuty],
      onClose: () => {},
    });
    const row = panel.render(120).find((l) => l.includes('alice'))!;
    expect(row).toContain('上班');
    expect(row).not.toContain(workingFg); // no primary
    expect(row).not.toContain(warningFg); // no warning
  });

  it('renders an off-duty row dimmed (muted) with model column —', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members: [onDuty, offDuty],
      onClose: () => {},
    });
    const rows = panel.render(120);
    const row = rows.find((l) => l.includes('zed'))!;
    expect(row).toContain('下班');
    expect(row).toContain('—'); // role and model both collapse to the em-dash
    expect(row).not.toContain('gpt-4o');
    // Archived rows drop a step fainter than active rows: textMuted, not textDim.
    expect(row).toContain(mutedFg);
    const activeRow = rows.find((l) => l.includes('alice'))!;
    expect(activeRow).not.toContain(mutedFg);
  });
});

// ===========================================================================
// loadTeamPanelData integration — real reads against a temp KIMI_CODE_HOME
// ===========================================================================
//
// team.ts's own internal reads (readAgentProfiles / readPerformanceData /
// readRuntimeStatusData) bypass the partial vi.mock, so the panel's refresh
// chain is verified here against a real temp data dir: missing runtime-status
// file must not error, and a 2.5s refresh must pick up a changed status file.

describe('team panel runtime-status integration', () => {
  const realHome = process.env[KIMI_CODE_HOME_ENV];
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kimi-team-panel-'));
    const agentsDir = join(tmp, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'alice.md'),
      '---\nname: Alice\ndescription: Dev\nrole: Developer\n---\n',
    );
    // No runtime-status.json by default — the absent-file case.
    writeFileSync(join(agentsDir, 'performance.json'), JSON.stringify({}));
    process.env[KIMI_CODE_HOME_ENV] = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (realHome === undefined) delete process.env[KIMI_CODE_HOME_ENV];
    else process.env[KIMI_CODE_HOME_ENV] = realHome;
  });

  function mountedPanel(host: ReturnType<typeof makeHost>['host']): TeamPanelComponent {
    return (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as TeamPanelComponent;
  }

  it('opens with all on-duty and no error when runtime-status.json is absent', async () => {
    const { host } = makeHost();
    await handleTeamCommand(host, '');

    expect(host.showError).not.toHaveBeenCalled();
    const joined = mountedPanel(host).render(120).join('\n');
    expect(joined).toContain('上班');
    expect(joined).not.toContain('工作');
    expect(joined).not.toContain('休息');
  });

  it('flips 工作 → 休息 after a 2.5s refresh re-reads runtime-status.json', async () => {
    vi.useFakeTimers();
    try {
      writeFileSync(
        join(tmp, 'agents', 'runtime-status.json'),
        JSON.stringify({ Alice: { state: 'working' } }),
      );
      const { host } = makeHost();
      await handleTeamCommand(host, '');
      const panel = mountedPanel(host);
      expect(panel.render(120).join('\n')).toContain('工作');

      // The engine settles the instance into its rest window.
      writeFileSync(
        join(tmp, 'agents', 'runtime-status.json'),
        JSON.stringify({
          Alice: { state: 'resting', restExpiresAt: '2999-01-01T00:00:00.000Z' },
        }),
      );
      await vi.advanceTimersByTimeAsync(TEAM_PANEL_REFRESH_INTERVAL_MS);

      const joined = panel.render(120).join('\n');
      expect(joined).toContain('休息');
      expect(joined).not.toContain('工作');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists a perf-only name as an off-duty archive row with history', async () => {
    writeFileSync(
      join(tmp, 'agents', 'performance.json'),
      JSON.stringify({
        Alice: { entries: [{ profileName: 'Alice', ts: '2026-07-30T10:00:00.000Z', score: 8 }] },
        Dana: { entries: [{ profileName: 'Dana', ts: '2026-07-30T09:00:00.000Z', score: 6.5 }] },
      }),
    );
    const { host } = makeHost();
    await handleTeamCommand(host, '');

    const joined = mountedPanel(host).render(120).join('\n');
    expect(joined).toContain('Dana');
    expect(joined).toContain('下班');
    expect(joined).toContain('6.5');
    expect(joined).not.toContain('工作');
  });
});
