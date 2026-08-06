import { describe, expect, it } from 'vitest';

import '#/session/agentLifecycle/profile/profiles';
import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import { TODO_LIST_TOOL_NAME } from '#/session/todo/todoItem';

function profileTools(name: string): readonly string[] {
  const profile = getAgentProfileContributions().find((entry) => entry.name === name);
  expect(profile).toBeDefined();
  return profile!.tools ?? [];
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
