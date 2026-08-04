// apps/kimi-web/src/lib/teamRows.test.ts
import { describe, expect, it } from 'vitest';
import {
  averageScoreLabel,
  sortTeamMembers,
  summarizeTeam,
  teamStatusMeta,
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
