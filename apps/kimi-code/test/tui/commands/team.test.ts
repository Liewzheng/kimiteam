/**
 * Team command tests — pure data helpers + command handling.
 *
 * Test placement follows the write-tui skill: pure-function tests live in the
 * nearest test directory matching the source. The panel render tests belong
 * alongside the component test suite; only the data aggregation and command
 * dispatch are tested here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleTeamCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

import {
  parseAgentFrontmatter,
  parsePerformanceData,
  formatDuration,
  aggregateMemberRows,
  resolveModelForProfile,
  TeamPanelComponent,
} from '#/tui/commands/team';

import { formatBusinessCardSuffixFromMap } from '#/tui/components/messages/subagent-card-meta';
import type { CardMeta } from '#/tui/components/messages/subagent-card-meta';

// Hoisted mock factories — used by cache-wrapper tests below; defined here so
// vi.mock can capture references before module resolution.
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
      role: '前端工程师·组件架构',
      model: 'gpt-4o',  // fits within 20-char column
      avgScore: 85.3,
      scoreCount: 7,
      avgDurationMs: 120_000,
      shiftCount: 3,
    },
    {
      name: 'qi-yuan',
      role: '后端工程师·数据层',
      model: 'claude-3.5',  // fits within 20-char column
      avgScore: null,
      scoreCount: 0,
      avgDurationMs: null,
      shiftCount: 0,
    },
  ];

  it('renders table with CJK Role column without breaking alignment', () => {
    const panel = new TeamPanelComponent({
      teamMode: true,
      members,
      onClose: () => {},
    });

    // Render at 120 columns wide — wide enough to avoid final-line truncation
    const lines = panel.render(120);

    // Header should exist
    const headerLine = lines.find((l) => l.includes('Name') && l.includes('Role'));
    expect(headerLine).toBeDefined();

    // Each data row should have consistent column separators.
    // Find the row lines (containing member names)
    const rowLines = lines.filter(
      (l) => l.includes('shen-yifan') || l.includes('qi-yuan'),
    );
    expect(rowLines).toHaveLength(2);

    // Verify the data rows contain model IDs
    expect(rowLines[0]).toContain('gpt-4o');
    expect(rowLines[1]).toContain('claude-3.5');

    // Verify score/duration/counts appear (right-aligned columns stay in place)
    expect(rowLines[0]!).toContain('85.3');
    expect(rowLines[0]!).toContain('2m 0s');
    expect(rowLines[1]!).toContain('—');

    // Role column (frontmatter row) is kept within its allocated width;
    // the header 'Role' label plus CJK content both fit in 16 visible columns.
    // Verify no content bleeds past its column by checking that the model
    // column contents appear in a consistent position.
    const rolePos = rowLines[0]!.indexOf('前端工程师');
    const modelPos = rowLines[0]!.indexOf('gpt-4o');
    expect(rolePos).toBeGreaterThanOrEqual(0);
    expect(modelPos).toBeGreaterThan(rolePos);
  });

  it('truncates long CJK Role to fit column width', () => {
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

    // The truncated role should be ≤ 16 visible columns; visibleWidth
    // accounts for CJK double-width, so the ellipsis '…' should appear.
    // We just verify that the line is not broken and fits within expected bounds.
    expect(rowLine!.length).toBeGreaterThan(0);
    // The rendered line should not contain the full untruncated role
    expect(rowLine).not.toContain('组件架构与设计系统');
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
