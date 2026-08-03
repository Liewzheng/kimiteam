/**
 * `toolPolicy` service — team-mode gate tests with stubbed collaborators.
 *
 * The five Team* tools are hidden (isToolActive === false) while
 * `[subagent] team_mode` is off, and the gate is read per call so a runtime
 * config write (`/team on|off`) takes effect on the next check. Run:
 * `npx vitest run test/agent/toolPolicy/toolPolicyService.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';

import { AgentToolPolicyService } from '#/agent/toolPolicy/toolPolicyService';

interface BuildOptions {
  teamMode?: boolean;
}

function buildService(options: BuildOptions = {}) {
  const state = { teamMode: options.teamMode };
  const profile = {
    data: () => ({
      profileName: 'agent',
      activeToolNames: ['Read', 'TeamScore', 'TeamHire'],
      disallowedTools: undefined,
    }),
  };
  const config = {
    get: (section: string) =>
      section === 'subagent' ? { teamMode: state.teamMode } : undefined,
  };
  const sessionToolPolicy = { disabledTools: () => [] };
  const toolPolicyGate = {
    _serviceBrand: undefined,
    disabledTools: [] as readonly string[],
    onDidChange: Event.None,
  };
  const toolExecutor = { registerToolCallGuard: () => ({ dispose: () => {} }) };
  const service = new AgentToolPolicyService(
    profile as never,
    config as never,
    sessionToolPolicy as never,
    toolPolicyGate as never,
    toolExecutor as never,
  );
  return { service, state };
}

describe('AgentToolPolicyService team-mode gate', () => {
  it('hides Team* tools when team mode is off', () => {
    const { service } = buildService({ teamMode: false });
    expect(service.isToolActive('TeamScore')).toBe(false);
    expect(service.isToolActive('TeamHire')).toBe(false);
    expect(service.isToolActive('TeamMessage')).toBe(false);
    expect(service.isToolActive('TeamConcurrency')).toBe(false);
    expect(service.isToolActive('TeamFire')).toBe(false);
  });

  it('keeps ordinary tools active when team mode is off', () => {
    const { service } = buildService({ teamMode: false });
    expect(service.isToolActive('Read')).toBe(true);
  });

  it('shows Team* tools when team mode is on', () => {
    const { service } = buildService({ teamMode: true });
    expect(service.isToolActive('TeamScore')).toBe(true);
    expect(service.isToolActive('TeamHire')).toBe(true);
  });

  it('defaults to off when the config section has no teamMode', () => {
    const { service } = buildService();
    expect(service.isToolActive('TeamScore')).toBe(false);
  });

  it('reflects a runtime config flip on the next check (no re-activation)', () => {
    const { service, state } = buildService({ teamMode: false });
    expect(service.isToolActive('TeamScore')).toBe(false);
    state.teamMode = true;
    expect(service.isToolActive('TeamScore')).toBe(true);
    state.teamMode = false;
    expect(service.isToolActive('TeamScore')).toBe(false);
  });
});
