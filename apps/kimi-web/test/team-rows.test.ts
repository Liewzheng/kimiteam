// apps/kimi-web/test/team-rows.test.ts
// Pure team-roster helpers — the counting contract behind the dock's
// 「团队 (working/total)」 badge and the /team TeamStatusPanel.
import { describe, expect, it } from 'vitest';
import {
  findMemberTask,
  findTeamMember,
  replaceTeamMember,
  summarizeTeam,
  teamTabState,
  type TeamMemberStatus,
} from '../src/lib/teamRows';

function member(status: TeamMemberStatus): { status: TeamMemberStatus } {
  return { status };
}

describe('summarizeTeam — working/total counting', () => {
  it('counts each lifecycle status and the roster total', () => {
    const s = summarizeTeam([
      member('working'),
      member('working'),
      member('resting'),
      member('off-duty'),
    ]);
    expect(s).toEqual({ total: 4, working: 2, resting: 1, offDuty: 1 });
  });

  it('aggregates global + project scopes (the dock badge sum)', () => {
    const global = [member('working'), member('resting')];
    const project = [member('working'), member('working'), member('resting')];
    const combined = summarizeTeam([...global, ...project]);
    expect(combined).toEqual({ total: 5, working: 3, resting: 2, offDuty: 0 });
  });

  it('returns a zeroed summary for an empty roster', () => {
    expect(summarizeTeam([])).toEqual({ total: 0, working: 0, resting: 0, offDuty: 0 });
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

describe('findTeamMember / replaceTeamMember — drill-in + edit realtime', () => {
  interface RosterMember { name: string; model: string; role: string; }
  function roster(): { teamMode: boolean; global: RosterMember[]; project: RosterMember[] } {
    return {
      teamMode: true,
      global: [{ name: 'coder', model: 'm1', role: 'Coder' }],
      project: [{ name: 'reviewer', model: 'm2', role: 'Reviewer' }],
    };
  }

  it('finds a member in global then project scope', () => {
    const r = roster();
    expect(findTeamMember(r, 'coder')?.role).toBe('Coder');
    expect(findTeamMember(r, 'reviewer')?.model).toBe('m2');
    expect(findTeamMember(r, 'missing')).toBeNull();
    expect(findTeamMember(null, 'coder')).toBeNull();
  });

  it('replaces a member in whichever scope holds it, preserving teamMode', () => {
    const r = roster();
    const next = replaceTeamMember(r, { name: 'coder', model: 'm9', role: 'Coder' });
    expect(next).not.toBe(r);
    expect(next?.teamMode).toBe(true);
    expect(next?.global.find((m) => m.name === 'coder')?.model).toBe('m9');
    expect(next?.project).toBe(r.project); // untouched scope keeps the reference
    // Other members unchanged.
    expect(next?.global.find((m) => m.name === 'coder')?.role).toBe('Coder');
  });

  it('returns the same roster when the member is not present, and null for null', () => {
    const r = roster();
    expect(replaceTeamMember(r, { name: 'ghost', model: 'm', role: 'R' })).toBe(r);
    expect(replaceTeamMember(null, { name: 'ghost', model: 'm', role: 'R' })).toBeNull();
  });
});

describe('findMemberTask — member → live subagent task mapping', () => {
  it('joins a roster member to its running subagent by profile name', () => {
    const tasks = [
      { id: 'a', kind: 'bash', subagentType: 'coder' },
      { id: 'b', kind: 'subagent', subagentType: 'coder' },
      { id: 'c', kind: 'subagent', subagentType: 'reviewer' },
    ];
    expect(findMemberTask(tasks, 'coder')?.id).toBe('b');
    expect(findMemberTask(tasks, 'reviewer')?.id).toBe('c');
  });

  it('returns undefined when the member has no live instance', () => {
    const tasks = [{ id: 'a', kind: 'subagent', subagentType: 'other' }];
    expect(findMemberTask(tasks, 'coder')).toBeUndefined();
    expect(findMemberTask([], 'coder')).toBeUndefined();
  });
});
