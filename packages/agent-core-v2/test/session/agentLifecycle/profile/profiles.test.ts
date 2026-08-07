import { describe, expect, it } from 'vitest';

import '#/session/agentLifecycle/profile/profiles';
import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { TODO_LIST_TOOL_NAME } from '#/session/todo/todoItem';

function profileTools(name: string): readonly string[] {
  const found = getAgentProfileContributions().find((entry) => entry.name === name);
  expect(found).toBeDefined();
  return found!.tools ?? [];
}

function profile(name: string): AgentProfile {
  const found = getAgentProfileContributions().find((entry) => entry.name === name);
  expect(found).toBeDefined();
  return found!;
}

describe('builtin agent profiles — TodoList is main-only', () => {
  it('keeps TodoList on the main `agent` profile', () => {
    expect(profileTools('agent')).toContain(TODO_LIST_TOOL_NAME);
  });

  it('excludes TodoList from the `coder` subagent profile', () => {
    expect(profileTools('coder')).not.toContain(TODO_LIST_TOOL_NAME);
  });

  it('excludes TodoList from the `explore` subagent profile', () => {
    expect(profileTools('explore')).not.toContain(TODO_LIST_TOOL_NAME);
  });
});

describe('builtin `agent` profile — role depends on main vs subagent', () => {
  it('renders the tech-lead role when bound to the main agent', () => {
    const rendered = profile('agent').renderSystemPrompt({ agentId: 'main' });
    expect(rendered.text).toContain('general manager');
    expect(rendered.text).toContain('tech-lead');
    expect(rendered.text).toContain('delegate in minimal verifiable');
    // The executor role must not leak into the main agent.
    expect(rendered.text).not.toContain('running as a subagent');
    expect(rendered.text).not.toContain('no subordinates');
  });

  it('renders the executor role with no-delegation constraints when dispatched as a subagent', () => {
    const rendered = profile('agent').renderSystemPrompt({ agentId: 'agent-3' });
    // Task-agent positioning: the parent is the caller.
    expect(rendered.text).toContain('running as a subagent');
    expect(rendered.text).toContain('parent agent');
    // Executor positioning: complete the task yourself, never delegate.
    expect(rendered.text).toContain('no subordinates');
    expect(rendered.text).toContain('never hand the task off');
    expect(rendered.text).toContain('request a reassignment');
    expect(rendered.text).toContain('brief technical conclusion');
    // The tech-lead role must not leak into a subagent.
    expect(rendered.text).not.toContain('general manager');
    expect(rendered.text).not.toContain('accept, score, and review');
  });

  it('treats a missing agentId as a subagent (safe default: executor, not lead)', () => {
    const rendered = profile('agent').renderSystemPrompt({});
    expect(rendered.text).toContain('running as a subagent');
    expect(rendered.text).not.toContain('general manager');
  });
});
