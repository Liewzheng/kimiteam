/**
 * `todoCounter` domain — `ITodoService` contract.
 *
 * The cross-session source of todo ids: allocates strictly-increasing `T{n}`
 * numbers (last assigned persisted in `<homeDir>/agents/todo-counter.json`)
 * so references stay unique across sessions and reboots. This is deliberately
 * distinct from the Session-scoped `ISessionTodoService`, which owns the todo
 * *list* state for one session; `ITodoService` owns only the id counter and is
 * bound at App scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface ITodoService {
  readonly _serviceBrand: undefined;

  /**
   * Allocate and persist the next todo id (`T1`, `T2`, …). Strictly
   * increasing, never re-issued, and safe under concurrent callers (in-process
   * calls are serialized).
   */
  nextTodoId(): Promise<string>;
}

export const ITodoService = createDecorator<ITodoService>('todoService');
