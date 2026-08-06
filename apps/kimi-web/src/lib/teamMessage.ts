// apps/kimi-web/src/lib/teamMessage.ts
// Pure parsing for the `TeamMessage` tool call. A lead messages a member by
// calling TeamMessage with a JSON input `{ agent_id, message, interrupt? }`
// (agent-core-v2 TeamMessageInput). Before the dedicated card existed, the web
// rendered that JSON verbatim as the tool args — this module extracts the
// human-facing parts (target + message) so the card can show a structured,
// Markdown-rendered message instead of raw JSON.

export interface TeamMessageInput {
  agentId?: string;
  message?: string;
  interrupt?: boolean;
}

/**
 * Conservative unwrap of the TeamMessage tool input. Returns the structured
 * fields only when the arg really is a JSON object with string `message` /
 * `agent_id`; anything else (plain text, malformed JSON, arrays, numbers) yields
 * an empty result so the caller falls back to the raw text. Never throws, and
 * never mis-parses normal text that merely starts with `{`.
 */
export function parseTeamMessageInput(arg: string): TeamMessageInput {
  const s = (arg ?? '').trim();
  if (!s.startsWith('{')) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return {};
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
  const rec = obj as Record<string, unknown>;
  const out: TeamMessageInput = {};
  if (typeof rec['agent_id'] === 'string' && rec['agent_id'].length > 0) {
    out.agentId = rec['agent_id'];
  }
  if (typeof rec['message'] === 'string') {
    out.message = rec['message'];
  }
  if (rec['interrupt'] === true) {
    out.interrupt = true;
  }
  return out;
}

/** True when the arg unwrapped into the expected envelope (has a target or a
 *  message) — i.e. the card can render it structurally instead of as raw text. */
export function isTeamMessageEnvelope(input: TeamMessageInput): boolean {
  return input.agentId !== undefined || input.message !== undefined;
}

/** Collapsed header text: `→ <agent_id>`, with an `[interrupt]` prefix when the
 *  message interrupts the target's turn (mirrors agent-core's own description). */
export function teamMessageSummary(input: TeamMessageInput): string {
  const target = input.agentId ? `→ ${input.agentId}` : '';
  return input.interrupt && target ? `[interrupt] ${target}` : target;
}
