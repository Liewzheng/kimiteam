/**
 * TranscriptTodo — the agent's todo list as a global latest-state entity.
 *
 * The list is one mutable document per agent transcript: every `todo.upsert`
 * replaces it wholesale (idempotent), and it lives beside `tasks` — global,
 * never paginated, visible at 'turn' grade — so a task panel or a coarse
 * subscriber always sees the current list.
 *
 * History vs present: `TodoList` tool frames keep their own point-in-time
 * snapshots in `display` (the scrollback shows the list as of that call);
 * this entity carries the latest state. A mutating tool call links back via
 * `ToolCallFrame.todoId`.
 */

import type { TodoId } from './ids';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
  /**
   * Stable engine-assigned id (`T1`/`T42`), the dispatch handle referenced by
   * the lead. Absent on legacy sessions written before ids existed — such items
   * read fine and are assigned an id on the next full-list write.
   */
  readonly id?: string;
}

export interface TranscriptTodo {
  readonly todoId: TodoId;
  readonly items: readonly TodoItem[];
  readonly updatedAt?: string;
}
