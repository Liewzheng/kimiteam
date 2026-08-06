// apps/kimi-web/src/lib/teamRows.test.ts
import { describe, expect, it } from 'vitest';
import {
  averageScoreLabel,
  filterUserTeamMembers,
  isBuiltinTeamProfileName,
  sortTeamMembers,
  summarizeTeam,
  teamStatusMeta,
  toMemberCard,
  toMemberCards,
  type TeamMemberStatus,
} from './teamRows';

describe('teamStatusMeta', () => {
  it('maps each of the four TUI statuses to a badge variant + i18n key', () => {
    expect(teamStatusMeta('working')).toEqual({ variant: 'info', key: 'working', busy: true });
    expect(teamStatusMeta('resting')).toEqual({ variant: 'warning', key: 'resting', busy: false });
    expect(teamStatusMeta('on-duty')).toEqual({ variant: 'success', key: 'on-duty', busy: false });
    expect(teamStatusMeta('off-duty')).toEqual({ variant: 'neutral', key: 'off-duty', busy: false });
  });

  it('marks only working as busy (concurrency-consumer)', () => {
    for (const status of ['resting', 'on-duty', 'off-duty'] as const) {
      expect(teamStatusMeta(status).busy).toBe(false);
    }
    expect(teamStatusMeta('working').busy).toBe(true);
  });
});

describe('summarizeTeam', () => {
  const member = (status: TeamMemberStatus) => ({ status });

  it('returns all-zero counts for an empty roster', () => {
    expect(summarizeTeam([])).toEqual({
      total: 0,
      working: 0,
      onDuty: 0,
      resting: 0,
      offDuty: 0,
    });
  });

  it('counts each of the four statuses separately', () => {
    const result = summarizeTeam([
      member('working'),
      member('working'),
      member('resting'),
      member('on-duty'),
      member('off-duty'),
    ]);
    expect(result).toEqual({ total: 5, working: 2, onDuty: 1, resting: 1, offDuty: 1 });
  });
});

describe('averageScoreLabel', () => {
  it('returns null when there are no scores yet', () => {
    expect(averageScoreLabel({ average: null, count: 0 })).toBeNull();
    expect(averageScoreLabel({ average: null, count: 3 })).toBeNull();
    expect(averageScoreLabel({ average: 4.2, count: 0 })).toBeNull();
  });

  it('formats a 1-decimal average', () => {
    expect(averageScoreLabel({ average: 4, count: 1 })).toBe('4');
    expect(averageScoreLabel({ average: 4.25, count: 2 })).toBe('4.3');
    expect(averageScoreLabel({ average: 3.04, count: 4 })).toBe('3');
    expect(averageScoreLabel({ average: 5, count: 8 })).toBe('5');
  });
});

describe('sortTeamMembers', () => {
  const member = (name: string, status: TeamMemberStatus) => ({ name, status });

  it('keeps an empty list empty', () => {
    expect(sortTeamMembers([])).toEqual([]);
  });

  it('orders working → resting → on-duty → off-duty (TUI lifecycle)', () => {
    const members = [
      member('zoe', 'off-duty'),
      member('amy', 'working'),
      member('bob', 'on-duty'),
      member('cal', 'resting'),
    ];
    expect(sortTeamMembers(members).map((m) => m.name)).toEqual([
      'amy', // working
      'cal', // resting
      'bob', // on-duty
      'zoe', // off-duty
    ]);
  });

  it('breaks status ties by name', () => {
    const members = [
      member('beta', 'working'),
      member('alpha', 'working'),
      member('delta', 'off-duty'),
      member('gamma', 'off-duty'),
    ];
    expect(sortTeamMembers(members).map((m) => m.name)).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
    ]);
  });

  it('does not mutate the input array', () => {
    const members = [member('b', 'on-duty'), member('a', 'working')];
    const snapshot = [...members];
    sortTeamMembers(members);
    expect(members).toEqual(snapshot);
  });
});

describe('toMemberCard / toMemberCards — TeamStatusPanel card grid', () => {
  const member = (overrides: Record<string, unknown> = {}) => ({
    name: 'Alice',
    role: 'Architect',
    model: 'kimi-k2',
    status: 'working' as const,
    score: { average: 4.25, count: 2 },
    ...overrides,
  });

  it('builds the four card rows: name, statusKey, title (role), model, score', () => {
    expect(toMemberCard(member())).toEqual({
      name: 'Alice',
      statusKey: 'working',
      title: 'Architect',
      model: 'kimi-k2',
      scoreLabel: '4.3',
    });
  });

  it('uses the role field as the card title (no separate title field exists)', () => {
    expect(toMemberCard(member({ role: 'Duty engineer' })).title).toBe('Duty engineer');
  });

  it('passes the status key through for i18n resolution', () => {
    expect(toMemberCard(member({ status: 'off-duty' })).statusKey).toBe('off-duty');
  });

  it('renders a null score label when there are no scores yet (card shows empty state)', () => {
    expect(toMemberCard(member({ score: { average: null, count: 0 } })).scoreLabel).toBeNull();
  });

  it('maps a roster 1:1 — N members → N cards, order preserved (grid card count)', () => {
    const roster = [
      member({ name: 'alpha' }),
      member({ name: 'beta' }),
      member({ name: 'gamma' }),
    ];
    const cards = toMemberCards(roster);
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns zero cards for an empty roster', () => {
    expect(toMemberCards([])).toEqual([]);
  });
});

describe('filterUserTeamMembers / isBuiltinTeamProfileName — hide engine built-ins', () => {
  const member = (name: string) => ({ name, status: 'off-duty' as const });

  it('flags exactly the four engine built-in default profiles', () => {
    expect(isBuiltinTeamProfileName('agent')).toBe(true);
    expect(isBuiltinTeamProfileName('coder')).toBe(true);
    expect(isBuiltinTeamProfileName('explore')).toBe(true);
    expect(isBuiltinTeamProfileName('plan')).toBe(true);
    expect(isBuiltinTeamProfileName('mail-checker')).toBe(false);
    expect(isBuiltinTeamProfileName('')).toBe(false);
  });

  it('drops engine built-ins and keeps user-created members', () => {
    const roster = [
      member('agent'),
      member('coder'),
      member('explore'),
      member('plan'),
      member('mail-checker'),
      member('yan-ge'),
    ];
    expect(filterUserTeamMembers(roster).map((m) => m.name)).toEqual([
      'mail-checker',
      'yan-ge',
    ]);
  });

  it('keeps user-fired archive rows (non-built-in names) intact', () => {
    const roster = [member('agent'), member('retired-member')];
    const filtered = filterUserTeamMembers(roster);
    expect(filtered.map((m) => m.name)).toEqual(['retired-member']);
    expect(filtered[0]!.status).toBe('off-duty');
  });

  it('keeps an empty list empty and does not mutate the input', () => {
    expect(filterUserTeamMembers([])).toEqual([]);
    const roster = [member('coder'), member('ok')];
    const snapshot = [...roster];
    filterUserTeamMembers(roster);
    expect(roster).toEqual(snapshot);
  });
});
