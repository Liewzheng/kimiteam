// apps/kimi-web/src/lib/turnLazyMount.ts
// Pure helpers for ChatPane's off-screen turn lazy-mounting (F2).
//
// A cold open / evicted re-open used to mount EVERY assistant turn's Markdown
// on the main thread: markstream parses each message and shiki tokenizes each
// code block even for turns far outside the viewport (content-visibility:auto
// only skips layout/paint, not the parse/mount cost). These helpers decide
// which turns mount eagerly and estimate a placeholder height for the rest, so
// the scrollbar stays in the right ballpark while off-screen turns stay cheap.
import type { ChatTurn } from '../types';

/** Transcripts at or below this many turns render fully — deferring a short
 *  conversation costs more churn than it saves. */
export const LAZY_MOUNT_TURN_THRESHOLD = 24;

/** The tail turns that always mount (auto-follow keeps them in view; the last
 *  assistant turn is also the streaming turn while the main turn is in flight). */
export const LAZY_MOUNT_TAIL_TURNS = 3;

/** Vertical buffer (px) around the viewport inside which a turn counts as
 *  near-visible and mounts before the user actually reaches it. */
export const LAZY_MOUNT_VIEWPORT_BUFFER = 480;

/**
 * Whether a turn must mount regardless of its visibility:
 * - short transcripts (deferral is pure churn);
 * - the tail turns (auto-follow keeps them in view; the streaming turn is the
 *   last assistant turn while the main turn is in flight);
 * - the streaming turn itself, when it is not among the tail turns.
 */
export function shouldEagerlyMountTurn(
  turnIndex: number,
  turnCount: number,
  streamingTurnIndex: number | null,
): boolean {
  if (turnCount <= LAZY_MOUNT_TURN_THRESHOLD) return true;
  if (turnIndex >= turnCount - LAZY_MOUNT_TAIL_TURNS) return true;
  if (streamingTurnIndex !== null && turnIndex === streamingTurnIndex) return true;
  return false;
}

/**
 * Estimated rendered height (px) of an unmounted turn, used to size the
 * placeholder so the transcript's scrollbar stays in the right ballpark while
 * off-screen turns are not yet mounted. Cheap content heuristics only — the
 * placeholder is a stand-in, not a layout guarantee (growing to the real height
 * happens while the turn is still inside the viewport buffer).
 */
export function estimateTurnHeight(turn: ChatTurn): number {
  if (turn.role === 'compaction' || turn.role === 'cron') return 40;
  const textLen = turn.text.length;
  const thinkLen = turn.thinking?.length ?? 0;
  const toolCount = turn.tools?.length ?? 0;
  if (turn.role === 'user') {
    const text = Math.min(textLen * 0.35, 240);
    const attachments = (turn.attachments?.length ?? 0) * 56;
    return Math.round(40 + text + attachments);
  }
  // Assistant: thinking block + text + collapsed tool-card headers.
  const text = Math.min(textLen * 0.3, 520);
  const thinking = Math.min(thinkLen * 0.2, 160);
  const tools = toolCount * 40;
  return Math.round(56 + thinking + text + tools);
}

/**
 * Whether an element whose bounding rect is `rect` should mount now because it
 * is inside (or within `buffer` px of) a viewport of `viewportHeight` px.
 * Returns false when the element is not rendered (zero rect — e.g. a
 * KeepAlive-deactivated pane under display:none), so a hidden pane never mounts
 * content; the caller re-checks on activation.
 */
export function isTurnNearViewport(
  rect: Pick<DOMRect, 'top' | 'bottom' | 'width' | 'height'>,
  viewportHeight: number,
  buffer = LAZY_MOUNT_VIEWPORT_BUFFER,
): boolean {
  if (rect.width === 0 && rect.height === 0) return false;
  return rect.bottom >= -buffer && rect.top <= viewportHeight + buffer;
}
