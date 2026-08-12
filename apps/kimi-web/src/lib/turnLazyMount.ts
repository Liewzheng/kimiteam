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

/** Whole turns to keep pre-mounted ahead of the viewport when scaling the
 *  overscan buffer for tall turns (see lazyMountBufferFor). */
export const LAZY_MOUNT_OVERSCAN_TURNS = 2;

/**
 * Adaptive overscan buffer (px) for a transcript whose turns have the given
 * estimated heights. The fixed `LAZY_MOUNT_VIEWPORT_BUFFER` (480px) covers only
 * a fraction of a tall tool-output turn (1000-5000px), so scrolling into the
 * next band of a large session kept hitting white before the placeholder
 * mounted. Scaling by the mean estimated height keeps roughly
 * `LAZY_MOUNT_OVERSCAN_TURNS` whole turns pre-mounted ahead of the viewport;
 * the mean (not the max) keeps one outlier turn from over-mounting the window.
 */
export function lazyMountBufferFor(estimatedHeights: readonly number[]): number {
  if (estimatedHeights.length === 0) return LAZY_MOUNT_VIEWPORT_BUFFER;
  let sum = 0;
  for (const height of estimatedHeights) sum += height;
  const mean = sum / estimatedHeights.length;
  return Math.ceil(Math.max(LAZY_MOUNT_VIEWPORT_BUFFER, mean * LAZY_MOUNT_OVERSCAN_TURNS));
}

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

/** Estimated rendered line height used by the height heuristics (px). */
const ESTIMATE_LINE_HEIGHT = 24;

/** Tool cards render their output at ~1lh per line and cap the visible window at
 *  50 lines (ToolOutputBlock's `--tool-output-visible-lines`), so a long tool
 *  output contributes at most 50 * line-height per card. */
const TOOL_OUTPUT_VISIBLE_LINES = 50;

/** Average chars per rendered line for prose (browser wraps ~90 chars); code
 *  fences usually stay unwrapped, but then explicit newlines dominate and the
 *  max() below picks the larger term. */
const CHARS_PER_LINE = 90;

/** Estimate the rendered line count of `text`: explicit newlines are lines, and
 *  a very long single line wraps at ~CHARS_PER_LINE chars. */
function estimateTextLines(text: string): number {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  const wrapped = Math.ceil(text.length / CHARS_PER_LINE);
  return Math.max(newlines + 1, wrapped);
}

/**
 * Estimated rendered height (px) of an unmounted turn, used to size the
 * placeholder so the transcript's scrollbar stays in the right ballpark while
 * off-screen turns are not yet mounted. Cheap content heuristics only — the
 * placeholder is a stand-in, not a layout guarantee (growing to the real height
 * happens while the turn is still inside the viewport buffer).
 *
 * Deliberately a ceiling-ish estimate rather than a tight one: the previous
 * text/thinking caps (520px / 160px) badly underestimated long code fences and
 * tool outputs (a 500-line diff renders >10kpx), so a turn would jump to its
 * real height the moment it mounted and force the layout to re-converge
 * (scheduleStableFollow). Line-based estimation keeps long turns in the right
 * ballpark from the start. Result is cached per ChatTurn object — the incremental
 * turns builder reuses the same turn references for the stable prefix, so a
 * re-render re-reads the cache instead of re-splitting text.
 */
const heightCache = new WeakMap<ChatTurn, number>();

export function estimateTurnHeight(turn: ChatTurn): number {
  const cached = heightCache.get(turn);
  if (cached !== undefined) return cached;
  const height = computeEstimateTurnHeight(turn);
  heightCache.set(turn, height);
  return height;
}

function computeEstimateTurnHeight(turn: ChatTurn): number {
  if (turn.role === 'compaction' || turn.role === 'cron') return 40;
  const toolCount = turn.tools?.length ?? 0;
  if (turn.role === 'user') {
    // User bubbles stay short and wrap; the cap keeps a pathological paste from
    // producing a multi-thousand-px placeholder.
    const text = Math.min(estimateTextLines(turn.text) * ESTIMATE_LINE_HEIGHT, 240);
    const attachments = (turn.attachments?.length ?? 0) * 56;
    return Math.round(40 + text + attachments);
  }
  // Assistant: thinking block + markdown text + tool cards (headers + output).
  const thinking = estimateThinkingHeight(turn.thinking);
  const text = estimateTextLines(turn.text) * ESTIMATE_LINE_HEIGHT;
  let toolOutputLines = 0;
  for (const tool of turn.tools ?? []) {
    toolOutputLines += Math.min(tool.output?.length ?? 0, TOOL_OUTPUT_VISIBLE_LINES);
  }
  const tools = toolCount * 40 + toolOutputLines * ESTIMATE_LINE_HEIGHT;
  return Math.round(56 + thinking + text + tools);
}

/** A settled thinking block folds to a one-paragraph teaser (ThinkingBlock only
 *  stays open while streaming or when it is a single paragraph), so a
 *  multi-paragraph block is short; a single long paragraph renders in full. */
function estimateThinkingHeight(thinking: string | undefined): number {
  if (!thinking) return 0;
  let paragraphs = 0;
  for (const p of thinking.split(/\n{2,}/)) {
    if (p.trim().length > 0) paragraphs++;
  }
  const lines = estimateTextLines(thinking);
  if (paragraphs > 1) return Math.min(lines * ESTIMATE_LINE_HEIGHT, 160);
  return lines * ESTIMATE_LINE_HEIGHT;
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
