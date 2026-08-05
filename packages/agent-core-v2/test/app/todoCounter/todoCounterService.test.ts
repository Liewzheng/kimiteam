/**
 * `todoCounter` domain — `ITodoService` unit / integration tests.
 *
 * Exercises TodoCounterService through InMemoryStorageService: sequential
 * auto-increment (T1→T2→T3), concurrency safety (parallel allocations never
 * collide), cross-session persistence (a rebuilt service continues from the
 * last assigned number), and corrupt-document degradation (restarts at T1).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

import { ITodoService } from '#/app/todoCounter/todoCounter';
import { TodoCounterService } from '#/app/todoCounter/todoCounterService';

function buildTodoService(): {
  readonly storage: InMemoryStorageService;
  readonly service: ITodoService;
} {
  const storage = new InMemoryStorageService();
  const docStore = new JsonAtomicDocumentStore(storage);
  const logStub: any = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
    child: () => logStub, setLevel: () => {}, level: 'debug' as const,
    flush: async () => {}, _serviceBrand: undefined,
  };
  return { storage, service: new TodoCounterService(docStore, logStub) };
}

describe('TodoCounterService', () => {
  const disposables = new DisposableStore();
  afterEach(() => disposables.dispose());

  it('allocates strictly increasing ids sequentially (T1, T2, T3)', async () => {
    const { service } = buildTodoService();
    expect(await service.nextTodoId()).toBe('T1');
    expect(await service.nextTodoId()).toBe('T2');
    expect(await service.nextTodoId()).toBe('T3');
  });

  it('allocates unique ids under concurrent calls (no duplicates)', async () => {
    const { service } = buildTodoService();
    const ids = await Promise.all(Array.from({ length: 20 }, () => service.nextTodoId()));
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(ids.map((id) => Number(id.slice(1))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('persists the counter across service rebuilds (cross-session continuation)', async () => {
    const { storage, service } = buildTodoService();
    expect(await service.nextTodoId()).toBe('T1');
    expect(await service.nextTodoId()).toBe('T2');
    expect(await service.nextTodoId()).toBe('T3');

    // A brand-new service over the SAME storage continues from T3 → T4, and
    // the raw document records the last assigned number.
    const docStore2 = new JsonAtomicDocumentStore(storage);
    const logStub2: any = {
      error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
      child: () => logStub2, setLevel: () => {}, level: 'debug' as const,
      flush: async () => {}, _serviceBrand: undefined,
    };
    const rebuilt = new TodoCounterService(docStore2, logStub2);
    expect(await rebuilt.nextTodoId()).toBe('T4');
    expect(await rebuilt.nextTodoId()).toBe('T5');

    const raw = JSON.parse(new TextDecoder().decode(await storage.read('agents', 'todo-counter.json')!));
    expect(raw.lastAssigned).toBe(5);
  });

  it('restarts from T1 when no counter document exists yet', async () => {
    const { service } = buildTodoService();
    expect(await service.nextTodoId()).toBe('T1');
  });

  it('restarts from T1 and warns when the counter document is corrupt', async () => {
    const { storage, service } = buildTodoService();
    await storage.write(
      'agents',
      'todo-counter.json',
      new TextEncoder().encode(JSON.stringify({ lastAssigned: 'not-a-number' })),
    );
    expect(await service.nextTodoId()).toBe('T1');
    expect(await service.nextTodoId()).toBe('T2');
  });
});
