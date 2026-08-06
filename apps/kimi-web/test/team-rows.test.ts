// apps/kimi-web/test/team-rows.test.ts
// Pure team-roster helpers — the counting contract behind the dock's
// 「团队 (working/total)」 badge and the /team TeamStatusPanel.
import { describe, expect, it } from 'vitest';
import { summarizeTeam, teamTabState, type TeamMemberStatus } from '../src/lib/teamRows';

function member(status: TeamMemberStatus): { status: TeamMemberStatus } {
  return { status };
}

describe('summarizeTeam — working/total counting', () => {
  it('counts each lifecycle status and the roster total', () => {
    const s = summarizeTeam([
      member('working'),
      member('working'),
      member('resting'),
      member('on-duty'),
      member('off-duty'),
    ]);
    expect(s).toEqual({ total: 5, working: 2, onDuty: 1, resting: 1, offDuty: 1 });
  });

  it('aggregates global + project scopes (the dock badge sum)', () => {
    const global = [member('working'), member('on-duty')];
    const project = [member('working'), member('working'), member('resting')];
    const combined = summarizeTeam([...global, ...project]);
    expect(combined).toEqual({ total: 5, working: 3, onDuty: 1, resting: 1, offDuty: 0 });
  });

  it('returns a zeroed summary for an empty roster', () => {
    expect(summarizeTeam([])).toEqual({ total: 0, working: 0, onDuty: 0, resting: 0, offDuty: 0 });
  });
});

describe('teamTabState — dock tab highlight / disabled decisions', () => {
  it('highlights while any member is working', () => {
    expect(teamTabState({ working: 2, total: 8, hasSession: true })).toEqual({
      hot: true,
      disabled: false,
    });
  });

  it('stays neutral when no member is working', () => {
    expect(teamTabState({ working: 0, total: 8, hasSession: true })).toEqual({
      hot: false,
      disabled: false,
    });
  });

  it('does not highlight an empty roster (no phantom working count)', () => {
    expect(teamTabState({ working: 0, total: 0, hasSession: true })).toEqual({
      hot: false,
      disabled: false,
    });
  });

  it('disables the entry without an active session (click is a no-op)', () => {
    expect(teamTabState({ working: 0, total: 0, hasSession: false })).toEqual({
      hot: false,
      disabled: true,
    });
  });
});
