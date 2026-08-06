// apps/kimi-web/src/composables/latestTodos.ts
// Derives the CURRENT todo list and the COMPLETED-todo HISTORY from a session
// transcript. The model manages todos via the TodoList tool: every write
// carries the FULL list in `input.todos` (an empty array clears it), and a
// call without `todos` is a read-only query. So:
//  - the newest toolUse that carries a `todos` array is the current state;
//  - the union of `done` items across EVERY write is the completed-work
//    history (the web counterpart of the TUI `/todo` view). Each TodoList
//    call is its own assistant message, and `messagesBySession` keeps them
//    all, so the whole history is reconstructable from the transcript.
// The extended fields (id / assignee / whatDone / completedAt) ride along in
// the tool args and pass through the wire untouched (wire `tool_use.input` is
// opaque — see api/daemon/mappers.ts toAppMessageContent).

import type { AppMessage } from '../api/types';
import type { TodoView } from '../types';
import { normalizeToolName } from '../lib/toolMeta';

function toStatus(raw: unknown): TodoView['status'] {
  if (raw === 'in_progress') return 'in_progress';
  // Kimi's TodoList says 'done'; Claude-style TodoWrite says 'completed'.
  if (raw === 'done' || raw === 'completed') return 'done';
  return 'pending';
}

/** Parse one raw todo item into a TodoView list (empty when it has no title —
 *  array return so `flatMap` filters invalid rows naturally). */
function toTodoView(item: unknown): TodoView[] {
  const it = (item ?? {}) as Record<string, unknown>;
  const title =
    typeof it['title'] === 'string'
      ? it['title']
      : typeof it['content'] === 'string'
        ? it['content']
        : '';
  if (!title) return [];
  const view: TodoView = { title, status: toStatus(it['status']) };
  if (typeof it['id'] === 'string' && it['id'].length > 0) view.id = it['id'];
  if (typeof it['assignee'] === 'string') view.assignee = it['assignee'];
  if (typeof it['whatDone'] === 'string') view.whatDone = it['whatDone'];
  if (typeof it['completedAt'] === 'string') view.completedAt = it['completedAt'];
  return [view];
}

/** The TodoList writes (calls that carry a `todos` array) in chronological
 *  order. Read-only queries and non-todo tool calls are skipped. */
function todoWrites(messages: AppMessage[]): TodoView[][] {
  const writes: TodoView[][] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const c of msg.content) {
      if (c.type !== 'toolUse' || normalizeToolName(c.toolName) !== 'todo') continue;
      let input: unknown = c.input;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          continue;
        }
      }
      const todos = (input as { todos?: unknown } | null)?.todos;
      if (!Array.isArray(todos)) continue; // read-only query
      writes.push(todos.flatMap(toTodoView));
    }
  }
  return writes;
}

/** The CURRENT todo list of the session — the latest TodoList write wins. */
export function latestTodos(messages: AppMessage[]): TodoView[] {
  const writes = todoWrites(messages);
  return writes.length === 0 ? [] : writes[writes.length - 1]!;
}

/** Completed-todo HISTORY of the session — the union of `done` items across
 *  every TodoList write, deduped by id (fallback: title, for legacy items
 *  written before ids existed), keeping the first-seen entry. Sorted by
 *  completion time descending; items without a completion timestamp trail
 *  behind in first-seen order (deterministic for tests).
 *
 * Mirrors the TUI's `/todo` completed-work list: each row renders
 * `todo num / who / what done` (id or position / assignee / whatDone). */
export function todoHistory(messages: AppMessage[]): TodoView[] {
  const seen = new Set<string>();
  const merged: TodoView[] = [];
  for (const write of todoWrites(messages)) {
    for (const todo of write) {
      if (todo.status !== 'done') continue;
      const key =
        todo.id !== undefined && todo.id.length > 0 ? `id:${todo.id}` : `title:${todo.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(todo);
    }
  }
  return merged.sort((a, b) => {
    if (a.completedAt !== undefined && b.completedAt !== undefined) {
      return b.completedAt.localeCompare(a.completedAt);
    }
    if (a.completedAt !== undefined) return -1;
    if (b.completedAt !== undefined) return 1;
    return 0;
  });
}
