/**
 * `todo` domain — todo item data shape and pure render helpers.
 *
 * `TodoItem` / `TodoStatus` are the persistent shape carried by the
 * `tools.update_store` (`key: 'todo'`) wire record. Pure and scope-less — no
 * scoped state lives here.
 */

export const TODO_LIST_TOOL_NAME = 'TodoList' as const;

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
  /**
   * Stable auto-assigned id (`T1`/`T42`) referenced by the lead for dispatch.
   * Absent on legacy data written before ids existed — such items read fine
   * and are assigned an id on the next full-list write.
   */
  readonly id?: string;
  /** Who the todo is assigned to (a subagent profile / agent id). */
  readonly assignee?: string;
  /** Detail of what was done, filled in when the todo completes. */
  readonly whatDone?: string;
  /** ISO timestamp of completion, filled in when the todo completes. */
  readonly completedAt?: string;
}

/** Carry over every known field onto a fresh `TodoItem` (defensive copy). */
export function sanitizeTodoItem(todo: TodoItem): TodoItem {
  return {
    title: todo.title,
    status: todo.status,
    ...(todo.id !== undefined ? { id: todo.id } : {}),
    ...(todo.assignee !== undefined ? { assignee: todo.assignee } : {}),
    ...(todo.whatDone !== undefined ? { whatDone: todo.whatDone } : {}),
    ...(todo.completedAt !== undefined ? { completedAt: todo.completedAt } : {}),
  };
}

export function readTodoItems(raw: unknown): readonly TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTodoItem).map(sanitizeTodoItem);
}

export function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['title'] === 'string' && isTodoStatus(record['status']);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}

export function renderTodoList(todos: readonly TodoItem[], title = 'Current todo list:'): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const lines = todos.map((t) => {
    const marker = statusMarker(t.status);
    return `  ${marker} ${t.title}`;
  });
  return [title, ...lines].join('\n');
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[done]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
