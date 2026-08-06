export type MarkdownCodeRenderer = 'pre' | 'shiki';

export interface MarkdownRenderPlan {
  codeRenderer: MarkdownCodeRenderer;
  codeFenceCount: number;
  codeChars: number;
}

const HEAVY_TEXT_CHARS = 120_000;
const HEAVY_CODE_CHARS = 60_000;
const HEAVY_CODE_FENCES = 32;
const HEAVY_SINGLE_FENCE_CHARS = 30_000;

const CODE_FENCE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n)?\2(?=\n|$)/g;

/**
 * Choose the code renderer for a piece of markdown.
 *
 * While a turn is actively streaming, code renders as plain `<pre>`: shiki
 * tokenization runs on the main thread and is the input-lag hot path during
 * fast output — keeping it off the stream keeps keystrokes responsive. The
 * settled plan (below) upgrades light messages to `shiki` once the turn has
 * settled ("settle 后再高亮"); heavy messages stay `pre`. The one-time
 * renderer flip at settle remounts code blocks once on light messages —
 * accepted in exchange for removing per-delta tokenization while typing.
 */
export function markdownRenderPlan(
  text: string,
  opts?: { streaming?: boolean },
): MarkdownRenderPlan {
  if (opts?.streaming) return { codeRenderer: 'pre', codeFenceCount: 0, codeChars: 0 };
  let codeFenceCount = 0;
  let codeChars = 0;
  let longestFence = 0;
  CODE_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    const code = match[3] ?? '';
    codeFenceCount += 1;
    codeChars += code.length;
    longestFence = Math.max(longestFence, code.length);
  }

  const heavy =
    text.length >= HEAVY_TEXT_CHARS ||
    codeChars >= HEAVY_CODE_CHARS ||
    codeFenceCount >= HEAVY_CODE_FENCES ||
    longestFence >= HEAVY_SINGLE_FENCE_CHARS;

  return {
    codeRenderer: heavy ? 'pre' : 'shiki',
    codeFenceCount,
    codeChars,
  };
}
