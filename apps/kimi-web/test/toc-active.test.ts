// apps/kimi-web/test/toc-active.test.ts
// Pure active-TOC resolution (lib/tocActive) — the O(log N) replacement for
// the old per-scroll O(N) anchor loop in ConversationPane.updateActiveTocQuery.
import { describe, expect, it } from 'vitest';
import { findActiveTurnIndex } from '../src/lib/tocActive';

/** Build a monotonic topAt over a pane of `height` (anchors evenly stacked). */
function paneTops(count: number, height: number): (i: number) => number {
  const step = height / count;
  return (i) => i * step;
}

describe('findActiveTurnIndex', () => {
  it('returns the last user anchor at or above the pane middle', () => {
    const tops = paneTops(6, 600); // 0,100,...,500
    // anchors 1,3,5 are user turns; middle = 300 → anchor 3 (top 300) qualifies.
    const idx = findActiveTurnIndex(6, (i) => [1, 3, 5].includes(i), tops, 300);
    expect(idx).toBe(3);
  });

  it('skips non-user anchors when walking back from the boundary', () => {
    const tops = paneTops(6, 600);
    // Only anchor 1 is a user turn; the boundary (last at/above 300) is anchor 3.
    const idx = findActiveTurnIndex(6, (i) => i === 1, tops, 300);
    expect(idx).toBe(1);
  });

  it('returns the last anchor when all are at or above the middle', () => {
    const tops = paneTops(4, 400); // 0,100,200,300 — all <= 200? no: middle=200
    // middle 400 → all tops <= 400 → boundary = 4 → last user = 3.
    const idx = findActiveTurnIndex(4, (i) => i % 2 === 1, tops, 400);
    expect(idx).toBe(3);
  });

  it('returns null when every anchor is below the middle', () => {
    const tops = paneTops(4, 400); // 0,100,200,300
    const idx = findActiveTurnIndex(4, () => true, tops, -1);
    expect(idx).toBeNull();
  });

  it('returns null for an empty anchor list', () => {
    expect(findActiveTurnIndex(0, () => true, () => 0, 100)).toBeNull();
  });

  it('matches the old O(N) scan result for a dense mixed list', () => {
    // Regression: the binary search must agree with the previous linear walk.
    const count = 50;
    const tops = paneTops(count, 1000);
    const middle = 400;
    const isUser = (i: number) => i % 3 !== 0; // 2 of 3 anchors are user turns
    const expected = (() => {
      let best: number | null = null;
      for (let i = 0; i < count; i++) if (isUser(i) && tops(i) <= middle) best = i;
      return best;
    })();
    const got = findActiveTurnIndex(count, isUser, tops, middle);
    expect(got).toBe(expected);
    expect(got).not.toBeNull();
  });
});
