// apps/kimi-web/test/markdown-performance.test.ts
// Code-renderer plan behind Markdown.vue: streaming turns render code as plain
// `<pre>` (no main-thread shiki tokenization during fast output), settled turns
// upgrade light messages to shiki and keep heavy ones on `pre`.
import { describe, expect, it } from 'vitest';
import { markdownRenderPlan } from '../src/lib/markdownPerformance';

function codeBlock(lang: string, chars: number): string {
  return `\`\`\`${lang}\n${'x'.repeat(chars)}\n\`\`\``;
}

describe('markdownRenderPlan — streaming', () => {
  it('uses the plain pre renderer while streaming (input-lag hot path)', () => {
    expect(markdownRenderPlan('', { streaming: true }).codeRenderer).toBe('pre');
    expect(markdownRenderPlan(codeBlock('ts', 2000), { streaming: true }).codeRenderer).toBe('pre');
  });
});

describe('markdownRenderPlan — settled', () => {
  it('upgrades a light message to shiki once settled', () => {
    const plan = markdownRenderPlan('text\n' + codeBlock('ts', 200));
    expect(plan.codeRenderer).toBe('shiki');
  });

  it('keeps heavy messages on pre even after settling', () => {
    const heavy = markdownRenderPlan(codeBlock('ts', 70_000));
    expect(heavy.codeRenderer).toBe('pre');
    expect(heavy.codeFenceCount).toBe(1);
    expect(heavy.codeChars).toBe(70_000);
  });
});
