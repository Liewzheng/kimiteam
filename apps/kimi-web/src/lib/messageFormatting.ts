// apps/kimi-web/src/lib/messageFormatting.ts
// Pure rendering-routing policy: which text surfaces go through the Markdown
// renderer vs stay plain. "Injected messages" — a TeamMessage a lead sends a
// subagent, the task prompt, and the subagent's own formatted output — are
// prose the user reads, so they must render Markdown (bold / lists / tables /
// code). Tool-progress lines, user input and thinking stay plain on purpose.
// Keeping the decision in one pure, tested function stops a future "make it
// render" change from accidentally routing terminal output or user input
// through Markdown (and re-introducing raw-markdown display for this family).

export type MarkdownSurface =
  /** Main-chat assistant prose — already rendered via Markdown.vue. */
  | 'assistant-text'
  /** Subagent live output (`member.text`) — where a TeamMessage-injected
   *  instruction and the subagent's formatted reply surface. */
  | 'subagent-output'
  /** Subagent task prompt / injected instruction (`member.prompt`). */
  | 'subagent-task'
  /** Subagent final summary (`member.summary`). */
  | 'subagent-result'
  /** User input — verbatim (pre-wrap), never Markdown. */
  | 'user-text'
  /** Tool-progress lines (`outputLines`, "Calling …") — mono log, never Markdown. */
  | 'subagent-progress'
  /** Raw chain-of-thought — plain, never Markdown. */
  | 'thinking';

const MARKDOWN_SURFACES: ReadonlySet<MarkdownSurface> = new Set<MarkdownSurface>([
  'assistant-text',
  'subagent-output',
  'subagent-task',
  'subagent-result',
]);

/** True when the surface should render through the Markdown component. */
export function shouldRenderMarkdown(surface: MarkdownSurface): boolean {
  return MARKDOWN_SURFACES.has(surface);
}
