/**
 * `todo` domain — `ISessionTodoService` contract.
 *
 * The session-shared todo list: an in-memory list materialized from the main
 * agent's `tools.update_store` (`key: 'todo'`) wire records, mutated through
 * `setTodos` (which appends a fresh `tools.update_store` to the main agent's
 * wire), and readable by every agent in the session. Items carry a stable
 * auto-assigned `id` (`T1`, `T42`, …) that dispatch hooks (`/todo` 派工) use
 * to reference individual todos; `setTodoCompleted` writes completion details
 * back by that id. Bound at Session scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { TodoItem } from './todoItem';

/** Completion details recorded by `setTodoCompleted` when a todo finishes. */
export interface TodoCompletionUpdate {
  /** What was actually done (detail of the completion). */
  readonly whatDone?: string;
  /** Who completed it (a subagent profile / agent id). */
  readonly assignee?: string;
}

export interface ISessionTodoService {
  readonly _serviceBrand: undefined;

  getTodos(): readonly TodoItem[];
  setTodos(todos: readonly TodoItem[]): void;
  clear(): void;

  /** Look up a todo by its stable id. Returns `undefined` when absent. */
  getTodo(id: string): TodoItem | undefined;
  /** Whether a todo with the given id exists. */
  hasTodo(id: string): boolean;
  /**
   * Mark the todo with `id` done and record completion details (`whatDone`,
   * `assignee`, `completedAt`). Returns `false` (no change) when no todo with
   * that id exists.
   */
  setTodoCompleted(id: string, update: TodoCompletionUpdate): boolean;
  readonly onDidChange: Event<readonly TodoItem[]>;
}

export const ISessionTodoService = createDecorator<ISessionTodoService>('sessionTodoService');
