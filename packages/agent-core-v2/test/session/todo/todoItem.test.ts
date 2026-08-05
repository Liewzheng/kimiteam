/**
 * `todo` domain — pure data-shape tests for `TodoItem` / `readTodoItems`.
 *
 * Covers backward compatibility (legacy items without `id` still parse and
 * read as pending/in_progress/done), the new optional fields (`id`,
 * `assignee`, `whatDone`, `completedAt`) being carried through the defensive
 * copy, and malformed entries being dropped.
 */

import { describe, expect, it } from 'vitest';

import { isTodoItem, readTodoItems, sanitizeTodoItem, type TodoItem } from '#/session/todo/todoItem';

describe('TodoItem data shape', () => {
  it('reads legacy items without an id (backward compatible)', () => {
    const items = readTodoItems([
      { title: 'old pending', status: 'pending' },
      { title: 'old done', status: 'done' },
    ]);

    expect(items).toEqual([
      { title: 'old pending', status: 'pending' },
      { title: 'old done', status: 'done' },
    ]);
    expect(items[0]!.id).toBeUndefined();
  });

  it('carries the new optional fields through readTodoItems', () => {
    const items = readTodoItems([
      {
        title: 'assigned',
        status: 'done',
        id: 'T42',
        assignee: 'coder',
        whatDone: 'shipped',
        completedAt: '2025-06-01T08:00:00.000Z',
      },
    ]);

    expect(items[0]).toEqual({
      title: 'assigned',
      status: 'done',
      id: 'T42',
      assignee: 'coder',
      whatDone: 'shipped',
      completedAt: '2025-06-01T08:00:00.000Z',
    });
  });

  it('isTodoItem accepts items with and without the optional fields', () => {
    expect(isTodoItem({ title: 'x', status: 'pending' })).toBe(true);
    expect(isTodoItem({ title: 'x', status: 'done', id: 'T1', whatDone: 'd', completedAt: 'c' })).toBe(true);
    expect(isTodoItem({ title: 'x', status: 'wip' })).toBe(false);
    expect(isTodoItem({ status: 'pending' })).toBe(false);
    expect(isTodoItem('garbage')).toBe(false);
    expect(isTodoItem(null)).toBe(false);
  });

  it('sanitizeTodoItem preserves only known fields and drops extras', () => {
    const copy = sanitizeTodoItem({
      title: 'a',
      status: 'pending',
      id: 'T7',
      assignee: 'explore',
      whatDone: 'note',
      completedAt: '2025-01-01T00:00:00.000Z',
      extra: 'dropped',
    } as TodoItem);

    expect(copy).toEqual({
      title: 'a',
      status: 'pending',
      id: 'T7',
      assignee: 'explore',
      whatDone: 'note',
      completedAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('readTodoItems drops malformed entries while keeping valid ones', () => {
    const items = readTodoItems([
      { title: 'valid', status: 'in_progress', id: 'T1' },
      { title: 'missing status' },
      'garbage',
      { title: 'bad status', status: 'wip' },
      42,
    ]);

    expect(items).toEqual([{ title: 'valid', status: 'in_progress', id: 'T1' }]);
  });
});
