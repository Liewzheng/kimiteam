// apps/kimi-web/src/lib/teamCommand.test.ts
// Pure tests for the web `/team` slash-command decision (see teamCommand.ts).
import { describe, expect, it } from 'vitest';
import { resolveTeamCommand } from './teamCommand';

const withSession = { hasSession: true, hasWorkspace: true };
const workspaceOnly = { hasSession: false, hasWorkspace: true };
const nothing = { hasSession: false, hasWorkspace: false };

describe('resolveTeamCommand — /team init', () => {
  it('activates the skill directly when a session exists', () => {
    expect(resolveTeamCommand('init', withSession)).toEqual({ type: 'activate-skill' });
  });

  it('starts a new session in the workspace when only a workspace exists', () => {
    expect(resolveTeamCommand('init', workspaceOnly)).toEqual({ type: 'activate-new-session' });
  });

  it('falls back to adding a workspace when neither session nor workspace exists', () => {
    expect(resolveTeamCommand('init', nothing)).toEqual({ type: 'add-workspace' });
  });

  it('ignores extra trailing arguments after init', () => {
    expect(resolveTeamCommand('init please', withSession)).toEqual({ type: 'activate-skill' });
    expect(resolveTeamCommand('init   ', withSession)).toEqual({ type: 'activate-skill' });
  });
});

describe('resolveTeamCommand — team mode + panel', () => {
  it('maps /team on and /team off to set-team-mode', () => {
    expect(resolveTeamCommand('on', withSession)).toEqual({ type: 'set-team-mode', on: true });
    expect(resolveTeamCommand('off', withSession)).toEqual({ type: 'set-team-mode', on: false });
  });

  it('opens the panel for a bare /team (empty arg)', () => {
    expect(resolveTeamCommand('', withSession)).toEqual({ type: 'open-panel' });
    expect(resolveTeamCommand('  ', nothing)).toEqual({ type: 'open-panel' });
  });

  it('opens the panel for TUI-only or unknown subcommands (auto, status, foo)', () => {
    expect(resolveTeamCommand('auto', withSession)).toEqual({ type: 'open-panel' });
    expect(resolveTeamCommand('status', withSession)).toEqual({ type: 'open-panel' });
    expect(resolveTeamCommand('foo', nothing)).toEqual({ type: 'open-panel' });
  });
});
