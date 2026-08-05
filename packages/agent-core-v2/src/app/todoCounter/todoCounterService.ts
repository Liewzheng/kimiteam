/**
 * `todoCounter` domain — `ITodoService` implementation.
 *
 * Allocates strictly-increasing todo ids across sessions, persisting the last
 * assigned number as a single JSON document under `<homeDir>/agents/todo-counter.json`
 * (scope `'agents'`, key `'todo-counter.json'`). On corrupt/missing data it
 * restarts from `T1` and logs a warning — it must not break the calling tool.
 * In-process allocations run through a serial promise queue (the atomic store
 * makes each write atomic but its `acquire` is a no-op), so concurrent
 * `nextTodoId` calls never hand out the same id; cross-process lost updates
 * remain possible and are accepted (todo ids are advisory dispatch handles).
 * Bound at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { ITodoService } from './todoCounter';

const STORAGE_SCOPE = 'agents';
const STORAGE_KEY = 'todo-counter.json';

interface TodoCounterState {
  readonly lastAssigned: number;
}

export class TodoCounterService implements ITodoService {
  declare readonly _serviceBrand: undefined;

  private _queue: Promise<void> = Promise.resolve();

  constructor(
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {}

  nextTodoId(): Promise<string> {
    const run = this._queue.then(() => this._nextTodoId());
    // Keep the chain alive even when one allocation fails.
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  private async _nextTodoId(): Promise<string> {
    const current = await this._readCounter();
    const next = current.lastAssigned + 1;
    await this.store.set<TodoCounterState>(STORAGE_SCOPE, STORAGE_KEY, { lastAssigned: next });
    return `T${next}`;
  }

  private async _readCounter(): Promise<TodoCounterState> {
    const raw = await this.store.get<TodoCounterState>(STORAGE_SCOPE, STORAGE_KEY);
    if (raw === undefined) return { lastAssigned: 0 };
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof raw.lastAssigned !== 'number' ||
      !Number.isInteger(raw.lastAssigned) ||
      raw.lastAssigned < 0
    ) {
      this.log.warn('todo-counter: corrupt document replaced', {
        scope: STORAGE_SCOPE,
        key: STORAGE_KEY,
      });
      return { lastAssigned: 0 };
    }
    return { lastAssigned: raw.lastAssigned };
  }
}

registerScopedService(
  LifecycleScope.App,
  ITodoService,
  TodoCounterService,
  ScopeActivation.OnDemand,
  'todoCounter',
);
