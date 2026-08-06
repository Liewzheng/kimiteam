// apps/kimi-web/src/lib/messageFormatting.test.ts
import { describe, expect, it } from 'vitest';
import { shouldRenderMarkdown } from './messageFormatting';

describe('shouldRenderMarkdown (injected-message routing policy)', () => {
  it('routes assistant prose through Markdown', () => {
    expect(shouldRenderMarkdown('assistant-text')).toBe(true);
  });

  it('routes subagent-facing prose through Markdown — the TeamMessage family', () => {
    // A TeamMessage a lead sends a subagent surfaces in the subagent's live
    // output / task / result — all three must render Markdown so bold, lists
    // and tables are formatted instead of raw text.
    expect(shouldRenderMarkdown('subagent-output')).toBe(true);
    expect(shouldRenderMarkdown('subagent-task')).toBe(true);
    expect(shouldRenderMarkdown('subagent-result')).toBe(true);
  });

  it('never routes user input, tool-progress lines or thinking through Markdown', () => {
    // User input is verbatim; progress lines are a mono log ("Calling …"); raw
    // chain-of-thought stays plain. Routing these through Markdown would mangle
    // shell output / code snippets containing markdown-ish syntax.
    expect(shouldRenderMarkdown('user-text')).toBe(false);
    expect(shouldRenderMarkdown('subagent-progress')).toBe(false);
    expect(shouldRenderMarkdown('thinking')).toBe(false);
  });
});
