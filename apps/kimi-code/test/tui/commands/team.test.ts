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
// Pure function: aggregateMemberRows
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
