/**
 * Todo command tests — pure data helpers + command handling + panel keyboard
 * navigation. Test placement follows the write-tui skill: pure-function and
 * command tests live under test/tui/commands; the chrome panel's completed-
 * work accumulation lives in test/tui/components/panels/todo-panel.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { TodoPanelComponent as ChromeTodoPanel } from '#/tui/components/chrome/todo-panel';
import {
  TodoPanelComponent,
  completedTodos,
  formatCompletedAt,
  formatTodoRow,
  handleTodoCommand,
  wrapText,
} from '#/tui/commands/todo';
import {
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
} from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TodoItem } from '#/tui/components/chrome/todo-panel';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function done(overrides: Partial<TodoItem> & { title: string }): TodoItem {
  return { status: 'done', ...overrides };
}

// ---------------------------------------------------------------------------
// makeHost — minimal mock for command-handling tests
// ---------------------------------------------------------------------------

function makeHost() {
  const todoPanel = new ChromeTodoPanel();
  const host = {
    state: { todoPanel },
    session: undefined,
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, todoPanel };
}

function mountedPanel(host: ReturnType<typeof makeHost>['host']): TodoPanelComponent {
  return (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as TodoPanelComponent;
}

// ===========================================================================
// Pure function: completedTodos
// ===========================================================================

describe('completedTodos', () => {
  it('keeps only done items', () => {
    expect(
      completedTodos([
        { title: 'a', status: 'done' },
        { title: 'b', status: 'in_progress' },
        { title: 'c', status: 'pending' },
      ]).map((t) => t.title),
    ).toEqual(['a']);
  });

  it('returns an empty list for no done items', () => {
    expect(completedTodos([{ title: 'a', status: 'pending' }])).toEqual([]);
    expect(completedTodos([])).toEqual([]);
  });
});

// ===========================================================================
// Pure function: formatTodoRow
// ===========================================================================

describe('formatTodoRow', () => {
  it('uses id / assignee / whatDone when present (extended contract)', () => {
    const row = formatTodoRow(
      done({ title: 'Fix parser', id: 'T3', assignee: 'Alice', whatDone: 'Fixed the parser crash' }),
      0,
    );
    expect(row.num).toBe('T3');
    expect(row.who).toBe('Alice');
    expect(row.what).toBe('Fixed the parser crash');
  });

  it('falls back to 1-based index / "—" / title on a pre-extension engine', () => {
    const row = formatTodoRow(done({ title: 'Open PR' }), 4);
    expect(row.num).toBe('5');
    expect(row.who).toBe('—');
    expect(row.what).toBe('Open PR');
  });

  it('falls back to "—" when even the title is empty (defensive)', () => {
    const row = formatTodoRow({ title: '', status: 'done' }, 0);
    expect(row.what).toBe('—');
  });
});

// ===========================================================================
// Pure function: formatCompletedAt
// ===========================================================================

describe('formatCompletedAt', () => {
  it('formats an ISO timestamp as local YYYY-MM-DD HH:mm', () => {
    const iso = '2026-07-30T10:05:00.000Z';
    const d = new Date(iso);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatCompletedAt(iso)).toBe(expected);
  });

  it('returns "—" for absent or unparseable timestamps', () => {
    expect(formatCompletedAt(undefined)).toBe('—');
    expect(formatCompletedAt('')).toBe('—');
    expect(formatCompletedAt('not-a-date')).toBe('—');
  });
});

// ===========================================================================
// Pure function: wrapText
// ===========================================================================

describe('wrapText', () => {
  it('wraps long text at the column limit', () => {
    const lines = wrapText('one two three four five', 10);
    expect(lines.join(' ').replaceAll('  ', ' ')).toBe('one two three four five');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 10)).toBe(true);
  });

  it('returns a single empty line for empty input', () => {
    expect(wrapText('', 10)).toEqual(['']);
  });
});

// ===========================================================================
// Command registration
// ===========================================================================

describe('/todo registration', () => {
  it('is a registered builtin, always available (read-only panel)', () => {
    const command = findBuiltInSlashCommand('todo');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });
});

// ===========================================================================
// Panel render — list view
// ===========================================================================

describe('TodoPanelComponent list render', () => {
  it('renders one row per done todo as num / who / what', () => {
    const panel = new TodoPanelComponent({
      todos: [
        done({ title: 'Fix parser', id: 'T3', assignee: 'Alice', whatDone: 'Fixed the parser crash' }),
        done({ title: 'Write tests', id: 'T4', assignee: 'Bob', whatDone: 'Added unit tests' }),
      ],
      onClose: vi.fn(),
    });
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('T3  Alice  Fixed the parser crash');
    expect(out).toContain('T4  Bob  Added unit tests');
    expect(out).toMatch(/↑↓ navigate · Enter details · Esc cancel/);
    expect(out).toMatch(/· Completed work/);
  });

  it('falls back to index / "—" / title when the extended fields are absent', () => {
    const panel = new TodoPanelComponent({
      todos: [done({ title: 'Open PR' })],
      onClose: vi.fn(),
    });
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('1  —  Open PR');
  });

  it('shows an empty state when no work is completed', () => {
    const panel = new TodoPanelComponent({ todos: [], onClose: vi.fn() });
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('No completed work');
  });

  it('paginates long lists with a page indicator', () => {
    const todos: TodoItem[] = Array.from({ length: 12 }, (_, i) =>
      done({ title: `task ${i}`, id: `T${i}` }),
    );
    const panel = new TodoPanelComponent({ todos, onClose: vi.fn() });
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toMatch(/Page 1\/2/);
    expect(out).toContain('T0');
    expect(out).not.toContain('T11');
  });
});

// ===========================================================================
// Panel render — detail view
// ===========================================================================

describe('TodoPanelComponent detail render', () => {
  function openDetail(panel: TodoPanelComponent): void {
    panel.handleInput('\r');
  }

  it('shows the full fields for the selected item', () => {
    const panel = new TodoPanelComponent({
      todos: [
        done({
          title: 'Fix parser',
          id: 'T3',
          assignee: 'Alice',
          whatDone: 'Fixed the parser crash on unicode input',
          completedAt: '2026-07-30T10:05:00.000Z',
        }),
      ],
      onClose: vi.fn(),
    });
    openDetail(panel);
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toMatch(/· #T3/);
    expect(out).toMatch(/Status: +done/);
    expect(out).toContain('Assignee:  Alice');
    expect(out).toContain('What done: Fixed the parser crash on unicode input');
    expect(out).toContain('Title:     Fix parser');
    expect(out).toContain(formatCompletedAt('2026-07-30T10:05:00.000Z'));
    expect(out).toMatch(/Esc back/);
  });

  it('falls back to title / "—" in the detail for a pre-extension todo', () => {
    const panel = new TodoPanelComponent({
      todos: [done({ title: 'Open PR' })],
      onClose: vi.fn(),
    });
    openDetail(panel);
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('What done: Open PR');
    expect(out).toContain('Assignee:  —');
    expect(out).toContain('Completed: —');
  });
});

// ===========================================================================
// Panel keyboard navigation
// ===========================================================================

describe('TodoPanelComponent keyboard navigation', () => {
  const three = (): TodoItem[] => [
    done({ title: 'a', id: 'T1', assignee: 'Alice', whatDone: 'did a' }),
    done({ title: 'b', id: 'T2', assignee: 'Bob', whatDone: 'did b' }),
    done({ title: 'c', id: 'T3', assignee: 'Cal', whatDone: 'did c' }),
  ];

  it('moves the selection with ↑/↓', () => {
    const panel = new TodoPanelComponent({ todos: three(), onClose: vi.fn() });
    const rowLines = (): string[] => panel.render(80).map(strip);

    expect(rowLines()[4]).toContain('❯ T1');
    expect(rowLines()[4]).not.toContain('❯ T2');

    panel.handleInput('\u001B[B'); // down
    expect(rowLines()[4]).not.toContain('❯'); // T1 deselected
    expect(rowLines()[5]).toContain('❯ T2'); // T2 selected

    panel.handleInput('\u001B[A'); // up
    expect(rowLines()[4]).toContain('❯ T1');
    expect(rowLines()[5]).not.toContain('❯');
  });

  it('Enter opens the detail of the selected item and Esc returns to the list', () => {
    const panel = new TodoPanelComponent({ todos: three(), onClose: vi.fn() });
    panel.handleInput('\u001B[B'); // select T2
    panel.handleInput('\r'); // open detail

    let out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('· #T2');
    expect(out).toContain('What done: did b');

    panel.handleInput('\u001B'); // back to list
    out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('· Completed work');
    expect(out).not.toContain('What done:');
  });

  it('Esc in the list closes the panel via onClose', () => {
    const onClose = vi.fn();
    const panel = new TodoPanelComponent({ todos: three(), onClose });
    panel.handleInput('\u001B');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('q closes the panel from the list', () => {
    const onClose = vi.fn();
    const panel = new TodoPanelComponent({ todos: three(), onClose });
    panel.handleInput('q');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('q in the detail view goes back to the list instead of closing', () => {
    const onClose = vi.fn();
    const panel = new TodoPanelComponent({ todos: three(), onClose });
    panel.handleInput('\r'); // open detail
    panel.handleInput('q');
    expect(onClose).not.toHaveBeenCalled();
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('· Completed work');
  });

  it('forwards Ctrl+C to the injected streaming-cancel callback', () => {
    const onCancel = vi.fn();
    const panel = new TodoPanelComponent({ todos: three(), onClose: vi.fn(), onCancel });
    panel.handleInput('\u0003');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// Command handling: handleTodoCommand
// ===========================================================================

describe('handleTodoCommand', () => {
  it('mounts a panel showing the accumulated completed todos', async () => {
    const { host, todoPanel } = makeHost();
    todoPanel.setTodos([
      done({ title: 'a', id: 'T1', assignee: 'Alice', whatDone: 'did a' }),
      { title: 'b', status: 'in_progress' },
    ]);
    await handleTodoCommand(host);

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const panel = mountedPanel(host);
    expect(panel).toBeInstanceOf(TodoPanelComponent);
    const out = panel.render(80).map(strip).join('\n');
    expect(out).toContain('T1  Alice  did a');
    expect(out).not.toContain('in_progress');
  });

  it('mounts a panel that closes via Esc and restores the editor', async () => {
    const { host } = makeHost();
    await handleTodoCommand(host);
    const panel = mountedPanel(host);

    panel.handleInput('\u001B');
    expect(host.restoreEditor).toHaveBeenCalled();
  });

  it('forwards Ctrl+C to the session cancel path', async () => {
    const cancel = vi.fn(async () => {});
    const { host } = makeHost();
    host.session = { cancel } as unknown as NonNullable<SlashCommandHost['session']>;
    await handleTodoCommand(host);
    const panel = mountedPanel(host);

    panel.handleInput('\u0003');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
