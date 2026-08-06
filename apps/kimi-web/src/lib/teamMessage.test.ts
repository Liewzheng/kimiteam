// apps/kimi-web/src/lib/teamMessage.test.ts
// Pure tests for the TeamMessage tool-input unwrap: a valid envelope extracts
// the target + message (Markdown preserved verbatim), while malformed / plain
// text stays untouched so the card falls back to raw rendering without crashing.
import { describe, expect, it } from 'vitest';
import {
  isTeamMessageEnvelope,
  parseTeamMessageInput,
  teamMessageSummary,
} from './teamMessage';

describe('parseTeamMessageInput (TeamMessage tool envelope)', () => {
  it('extracts agent_id + message + interrupt from a valid envelope', () => {
    const input = parseTeamMessageInput(
      JSON.stringify({ agent_id: 'agent-70', message: '需求更新：**加粗**', interrupt: true }),
    );
    expect(input).toEqual({ agentId: 'agent-70', message: '需求更新：**加粗**', interrupt: true });
    expect(isTeamMessageEnvelope(input)).toBe(true);
  });

  it('preserves Markdown and line breaks in the message verbatim', () => {
    const message = '需求更新\n\n- 第一点 **加粗**\n- 第二点\n\n代码：`npm test`';
    const input = parseTeamMessageInput(JSON.stringify({ agent_id: 'a1', message }));
    expect(input.message).toBe(message);
  });

  it('treats a plain, non-JSON arg as empty (never mis-parses normal text)', () => {
    expect(parseTeamMessageInput('需求更新：**加粗**')).toEqual({});
    expect(parseTeamMessageInput('{"not the real envelope')).toEqual({});
    expect(parseTeamMessageInput('')).toEqual({});
  });

  it('rejects non-object JSON and wrong-typed fields', () => {
    expect(parseTeamMessageInput('[1,2,3]')).toEqual({});
    expect(parseTeamMessageInput('null')).toEqual({});
    expect(parseTeamMessageInput('42')).toEqual({});
    // message must be a string; agent_id must be a non-empty string
    expect(parseTeamMessageInput(JSON.stringify({ agent_id: 7, message: 'hi' }))).toEqual({
      message: 'hi',
    });
    expect(parseTeamMessageInput(JSON.stringify({ agent_id: '', message: 'hi' }))).toEqual({
      message: 'hi',
    });
    expect(parseTeamMessageInput(JSON.stringify({ agent_id: 'a1', message: 42 }))).toEqual({
      agentId: 'a1',
    });
  });
});

describe('teamMessageSummary (collapsed header)', () => {
  it('shows the target arrow, with an [interrupt] prefix when interrupting', () => {
    expect(teamMessageSummary({ agentId: 'agent-70' })).toBe('→ agent-70');
    expect(teamMessageSummary({ agentId: 'agent-70', interrupt: true })).toBe('[interrupt] → agent-70');
    expect(teamMessageSummary({ message: 'hi' })).toBe('');
    expect(teamMessageSummary({})).toBe('');
  });
});
