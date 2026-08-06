// apps/kimi-web/src/lib/markdownPerformance.test.ts
// Streaming render-plan decisions: while a turn is live, Markdown renders as
// plain pre-wrap text (code renderer = pre, and the component's whole-message
// pre branch) so the main thread never runs the markdown parser per frame;
// settled messages upgrade light code to shiki and keep heavy ones on pre.
import { describe, expect, it } from 'vitest';
import { markdownRenderPlan } from './markdownPerformance';

describe('markdownRenderPlan — streaming whole-message pre strategy', () => {
  it('always renders code as plain pre while a turn is streaming', () => {
    expect(markdownRenderPlan('# hi\n\n```ts\nconst x = 1\n```', { streaming: true })).toEqual({
      codeRenderer: 'pre',
      codeFenceCount: 0,
      codeChars: 0,
    });
    // Even heavy settled content stays pre under the streaming flag — the live
    // turn must never tokenize on the main thread.
    expect(markdownRenderPlan('plain text', { streaming: true }).codeRenderer).toBe('pre');
  });

  it('upgrades light settled messages to shiki with fence stats', () => {
    const plan = markdownRenderPlan('# hi\n\n```ts\nconst x = 1\n```');
    expect(plan.codeRenderer).toBe('shiki');
    expect(plan.codeFenceCount).toBe(1);
    expect(plan.codeChars).toBe(11);
  });

  it('keeps heavy settled messages on pre (no highlighter queue)', () => {
    expect(markdownRenderPlan('x'.repeat(120_000)).codeRenderer).toBe('pre');
    expect(markdownRenderPlan('```ts\n' + 'y'.repeat(30_000) + '\n```').codeRenderer).toBe('pre');
  });

  it('keeps light settled prose on shiki', () => {
    expect(markdownRenderPlan('hello world').codeRenderer).toBe('shiki');
  });
});
