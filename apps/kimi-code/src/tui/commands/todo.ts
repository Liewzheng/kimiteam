/**
 * Todo command (`/todo`) — view the session's completed work.
 *
 * Data source
 * -----------
 * The TUI's todo data arrives through the existing chain: the engine's
 * TodoList tool result (live) and session replay both funnel into
 * `streamingUI.setTodoList` → the chrome `TodoPanelComponent`. The chrome
 * panel *collapses* a fully-done list at turn end (display optimization), so
 * `/todo` reads the panel's accumulated completed-work history
 * (`getCompletedTodos()`) instead of the live list — that history survives
 * the collapse and is rebuilt on replay. There is deliberately no direct
 * engine-todo RPC: the SDK exposes none, and adding one would cross packages.
 *
 * Architecture (mirrors `team.ts`)
 * --------------------------------
 * Pure data functions at the module top (unit-testable without a TUI harness);
 * `handleTodoCommand` is the dispatch entry; the panel is a Container +
 * Focusable with an internal list → detail two-level view (no re-mount).
 */

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import { currentTheme } from '#/tui/theme';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { SearchableList } from '#/tui/utils/searchable-list';
import { printableChar } from '#/tui/utils/printable-key';
import type { TodoItem } from '../components/chrome/todo-panel';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Public API — exported for dispatch.ts
// ---------------------------------------------------------------------------

export async function handleTodoCommand(host: SlashCommandHost): Promise<void> {
  const completed = host.state.todoPanel.getCompletedTodos();
  const panel = new TodoPanelComponent({
    todos: completed,
    onCancel: () => {
      // Same streaming-cancel path as the editor's Ctrl+C (editor-keyboard):
      // the panel is readable while a turn runs, so Ctrl+C must still work.
      void host.session?.cancel();
    },
    onClose: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(panel);
}

// ---------------------------------------------------------------------------
// Pure data helpers
// ---------------------------------------------------------------------------

/** Keep only completed items — the `/todo` list. */
export function completedTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.filter((t) => t.status === 'done');
}

/** One display row of the completed-work list. */
export interface DoneTodoRow {
  readonly todo: TodoItem;
  /** `todo.id`, or the 1-based position when the engine assigned no id. */
  readonly num: string;
  /** Assignee, or '—' when absent. */
  readonly who: string;
  /** whatDone, falling back to title, then '—'. */
  readonly what: string;
}

/** Project a done todo into a `num / who / what` row for the list. */
export function formatTodoRow(todo: TodoItem, index: number): DoneTodoRow {
  const id = todo.id ?? '';
  const num = id.length > 0 ? id : String(index + 1);
  const assignee = todo.assignee ?? '';
  const who = assignee.length > 0 ? assignee : '—';
  const whatDone = todo.whatDone ?? '';
  const title = todo.title ?? '';
  const what = whatDone.length > 0 ? whatDone : title.length > 0 ? title : '—';
  return { todo, num, who, what };
}

/** Render an ISO-8601 completion timestamp as a local `YYYY-MM-DD HH:mm`
 *  string, or '—' when absent / unparseable. Deterministic for tests. */
export function formatCompletedAt(iso: string | undefined): string {
  if (iso === undefined || iso.length === 0) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Word-wrap `text` to `maxWidth` visible columns (CJK-aware). */
export function wrapText(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= width ? word : truncateToWidth(word, width, '…');
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

export interface TodoPanelOptions {
  /** Completed-work list (done items) to show. */
  readonly todos: readonly TodoItem[];
  readonly onClose: () => void;
  /** Ctrl+C forwarding for the streaming-cancel path (see handleTodoCommand). */
  readonly onCancel?: () => void;
  /** Items per list page. Defaults to SearchableList's 8. */
  readonly pageSize?: number;
  /** Max detail lines visible before the detail view scrolls. */
  readonly maxVisible?: number;
}

export class TodoPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TodoPanelOptions;
  private readonly list: SearchableList<TodoItem>;
  /** When set, the panel shows the detail view for this completed item. */
  private detail: DoneTodoRow | null = null;
  private detailScroll = 0;

  constructor(opts: TodoPanelOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: completedTodos(opts.todos),
      toSearchText: (t) => `${t.id ?? ''} ${t.assignee ?? ''} ${t.whatDone ?? ''} ${t.title}`,
      pageSize: opts.pageSize,
      searchable: false,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.opts.onCancel?.();
      return;
    }
    const printable = printableChar(data);
    if (this.detail !== null) {
      // Detail view: Esc / q go back to the list; ↑↓ scroll long content.
      if (matchesKey(data, Key.escape) || printable === 'q' || printable === 'Q') {
        this.detail = null;
        this.detailScroll = 0;
        return;
      }
      if (matchesKey(data, Key.up)) this.detailScroll = Math.max(0, this.detailScroll - 1);
      if (matchesKey(data, Key.down)) this.detailScroll += 1;
      return;
    }
    // List view: Esc / q close; Enter opens the selected item's detail.
    if (matchesKey(data, Key.escape) || printable === 'q' || printable === 'Q') {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        const items = completedTodos(this.opts.todos);
        const index = Math.max(0, items.findIndex((t) => t === selected));
        this.detail = formatTodoRow(selected, index);
        this.detailScroll = 0;
      }
      return;
    }
    this.list.handleKey(data);
  }

  override render(width: number): string[] {
    const muted = (text: string) => currentTheme.fg('textMuted', text);
    if (this.detail === null) return this.renderList(width, muted);
    return this.renderDetail(width, muted);
  }

  private renderList(
    width: number,
    muted: (text: string) => string,
  ): string[] {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const boldAccent = (text: string) => currentTheme.boldFg('primary', text);
    const text = (s: string) => currentTheme.fg('text', s);
    const boldFg = (text: string) => currentTheme.boldFg('primary', text);

    const view = this.list.view();
    const items = view.items;
    const lines: string[] = [
      accent('─'.repeat(width)),
      boldAccent(' Todo') + muted(' · Completed work'),
      muted(' ↑↓ navigate · Enter details · Esc cancel'),
      '',
    ];

    if (items.length === 0) {
      lines.push(muted('   No completed work'));
    }
    for (let i = view.page.start; i < view.page.end; i++) {
      const item = items[i];
      if (item === undefined) continue;
      const row = formatTodoRow(item, i);
      const isSelected = i === view.selectedIndex;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const body = `${row.num}  ${row.who}  ${row.what}`;
      const bodyStyled = isSelected ? boldFg(body) : text(body);
      lines.push(currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `) + bodyStyled);
    }

    lines.push('');
    if (view.page.pageCount > 1) {
      lines.push(
        muted(` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`),
      );
    }
    lines.push(accent('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderDetail(
    width: number,
    muted: (text: string) => string,
  ): string[] {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const boldAccent = (text: string) => currentTheme.boldFg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const success = (text: string) => currentTheme.fg('success', text);

    const detail = this.detail as DoneTodoRow;
    const todo = detail.todo;
    const bodyWidth = Math.max(1, width - 2);
    // Longest label ('Completed:' / 'What done:' = 10 chars) + one space.
    const labelWidth = 11;

    const field = (label: string, value: string): string[] => {
      const prefix = `  ${dim(label.padEnd(labelWidth))}`;
      const valueWidth = Math.max(1, bodyWidth - labelWidth);
      return wrapText(value, valueWidth).map((line, idx) =>
        idx === 0 ? `${prefix}${line}` : `  ${' '.repeat(labelWidth)}${line}`,
      );
    };

    const content: string[] = [
      accent('─'.repeat(width)),
      boldAccent(' Todo') + muted(` · #${detail.num}`),
      muted(' Esc back'),
      '',
      ...field('Status:', success(todo.status)),
      ...field('Assignee:', detail.who),
      ...field('Completed:', formatCompletedAt(todo.completedAt)),
      ...field('What done:', detail.what),
      ...field('Title:', todo.title),
      '',
      accent('─'.repeat(width)),
    ];

    const inner = content.slice(1, content.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (inner.length > maxVisible) {
      this.detailScroll = Math.max(0, Math.min(this.detailScroll, inner.length - maxVisible));
      const slice = inner.slice(this.detailScroll, this.detailScroll + maxVisible);
      const scrollInfo = muted(
        ` showing ${String(this.detailScroll + 1)}-${String(this.detailScroll + slice.length)} of ${String(inner.length)}`,
      );
      return [content[0] ?? '', ...slice, scrollInfo, content.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }

    this.detailScroll = 0;
    return content.map((line) => truncateToWidth(line, width));
  }
}
