// apps/kimi-web/src/lib/tocActive.ts
// Pure active-TOC resolution: which user turn owns the current viewport.
// The chat pane's per-turn anchors are stacked in document order, so their
// tops relative to the pane are monotonic — the active turn is the LAST user
// anchor at or above the pane's vertical middle. Binary search finds it in
// O(log N) rect reads instead of measuring every anchor on each scroll tick
// (the old onPanesScroll path forced N layouts per scroll event).

/**
 * Index of the last user-turn anchor at or above `paneMiddle`, or null when no
 * user anchor qualifies (all anchors below the middle, or none).
 *
 * @param count     number of anchors (document order = scroll order)
 * @param isUser    whether the anchor at `index` is a user turn
 * @param topAt     anchor top relative to the pane (`getBoundingClientRect`)
 * @param paneMiddle the pane's vertical middle (pane height / 2)
 */
export function findActiveTurnIndex(
  count: number,
  isUser: (index: number) => boolean,
  topAt: (index: number) => number,
  paneMiddle: number,
): number | null {
  // Binary search for the first anchor strictly below the middle; the active
  // candidate is the anchor just before it (the last one at/above the middle).
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (topAt(mid) <= paneMiddle) lo = mid + 1;
    else hi = mid;
  }
  // Walk back to the nearest USER turn within the qualifying prefix.
  for (let i = lo - 1; i >= 0; i--) {
    if (isUser(i)) return i;
  }
  return null;
}
