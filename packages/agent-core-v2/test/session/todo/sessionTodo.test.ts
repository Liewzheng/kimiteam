/**
 * Scenario: session-shared Todo state, including undo restoration.
 * Responsibility: SessionTodoService exposes the main wire state and emits observable changes.
 * Wiring: lightweight lifecycle/agent fakes with real event-bus behavior.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 test -- test/session/todo/sessionTodo.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IInstantiationService } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { Emitter, Event } from '#/_base/event';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { readTodoItems, type TodoItem } from '#/session/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/session/todo/todoListReminder';
import { IWireService, type WireHooks } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

interface RecordedTodoSet {
  readonly type: string;
  readonly key?: string;
  readonly value?: unknown;
}

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly registeredTools: string[];
  readonly registeredVariants: string[];
  readonly appended: RecordedTodoSet[];
  readonly eventBus: EventBusService;
  readonly restore: (records: readonly WireRecord[]) => Promise<void>;
}

function makeFakeAgent(agentId: string): FakeAgent {
  const registeredTools: string[] = [];
  const registeredVariants: string[] = [];
  const appended: RecordedTodoSet[] = [];
  const eventBus = new EventBusService();

  let todoState: readonly TodoItem[] = [];

  const registryStub = {
    _serviceBrand: undefined,
    register: (tool: { name: string }) => {
      registeredTools.push(tool.name);
      return toDisposable(() => {});
    },
    list: () => [],
    resolve: () => undefined,
    hooks: {},
  };

  const injectorStub = {
    _serviceBrand: undefined,
    register: (variant: string) => {
      registeredVariants.push(variant);
      return toDisposable(() => {});
    },
  };

  const instantiationStub = {
    createInstance: (ctor: { name: string }) => ({ name: ctor.name }),
  };

  const memoryStub = {
    _serviceBrand: undefined,
    get: () => [],
  };

  const profileStub = {
    _serviceBrand: undefined,
    isToolActive: () => false,
  };

  const restore = async (records: readonly WireRecord[]): Promise<void> => {
    for (const record of records) {
      if (record.type === 'tools.update_store' && record['key'] === 'todo') {
        todoState = readTodoItems(record['value']);
      }
    }
  };

  const wireStub: IWireService = {
    _serviceBrand: undefined,
    hooks: createHooks<WireHooks, keyof WireHooks>(['onDidRestore']),
    dispatch: (...ops: unknown[]) => {
      for (const raw of ops) {
        const op = raw as { type: string; payload: unknown };
        const payload = op.payload;
        const record =
          payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : { payload };
        appended.push({ type: op.type, ...record } as unknown as RecordedTodoSet);
        if (op.type === 'tools.update_store' && record['key'] === 'todo') {
          todoState = readTodoItems(record['value']);
        }
      }
    },
    restore: async () => {},
    flush: async () => {},
    getModel: () => ({ current: todoState, checkpoints: [] }),
    subscribe: () => toDisposable(() => {}),
  } as unknown as IWireService;

  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IAgentToolRegistryService) return registryStub as unknown as T;
      if (id === IAgentContextInjectorService) return injectorStub as unknown as T;
      if (id === IInstantiationService) return instantiationStub as unknown as T;
      if (id === IAgentContextMemoryService) return memoryStub as unknown as T;
      if (id === IAgentProfileService) return profileStub as unknown as T;
      if (id === IAgentToolPolicyService) return profileStub as unknown as T;
      if (id === IEventBus) return eventBus as unknown as T;
      if (id === IWireService) return wireStub as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };

  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor,
    dispose: () => {},
  };

  return {
    handle,
    registeredTools,
    registeredVariants,
    appended,
    eventBus,
    restore,
  };
}

interface LifecycleStub {
  readonly service: IAgentLifecycleService;
  readonly fireCreate: (handle: IAgentScopeHandle) => void;
  readonly fireDispose: (agentId: string) => void;
}

function makeLifecycleStub(handles: readonly IAgentScopeHandle[] = []): LifecycleStub {
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const onDidDispose = new Emitter<string>();
  const byId = new Map(handles.map((h) => [h.id, h]));

  const service: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onDidCreate: onDidCreate.event,
    onDidDispose: onDidDispose.event,
    onDidRestore: Event.None as Event<string>,
    get: (id: string) => byId.get(id),
    list: () => [...byId.values()],
    broadcastPermissionMode: () => {},
    create: async () => {
      throw new Error('not implemented');
    },
    fork: async () => {
      throw new Error('not implemented');
    },
    remove: async () => {},
  };

  return {
    service,
    fireCreate: (h) => {
      byId.set(h.id, h);
      onDidCreate.fire(h);
    },
    fireDispose: (id) => {
      byId.delete(id);
      onDidDispose.fire(id);
    },
  };
}

describe('SessionTodoService', () => {
  it('starts empty and updates the list on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    expect(service.getTodos()).toEqual([]);

    const next: TodoItem[] = [
      { title: 'a', status: 'pending' },
      { title: 'b', status: 'in_progress' },
    ];
    service.setTodos(next);
    expect(service.getTodos()).toEqual(next);

    service.clear();
    expect(service.getTodos()).toEqual([]);
  });

  it('fires onDidChange after each setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    const seen: Array<readonly TodoItem[]> = [];
    const d = service.onDidChange((todos) => seen.push(todos));
    service.setTodos([{ title: 'x', status: 'pending' }]);
    service.setTodos([{ title: 'y', status: 'done' }]);
    d.dispose();

    expect(seen).toEqual([
      [{ title: 'x', status: 'pending' }],
      [{ title: 'y', status: 'done' }],
    ]);
  });

  it('fires the restored list once when undo changes the main wire state', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);
    service.setTodos([{ title: 'doomed', status: 'in_progress' }]);

    const seen: Array<readonly TodoItem[]> = [];
    const subscription = service.onDidChange((todos) => seen.push(todos));
    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'kept', status: 'pending' }] },
    ]);
    main.eventBus.publish({ type: 'context.undone', turns: 1 });
    main.eventBus.publish({ type: 'context.undone', turns: 1 });
    subscription.dispose();

    expect(seen).toEqual([[{ title: 'kept', status: 'pending' }]]);
  });

  it('appends a tools.update_store record to the main agent wire on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    service.setTodos([{ title: 'persist me', status: 'in_progress' }]);

    expect(main.appended).toEqual([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'persist me', status: 'in_progress' }],
      },
    ]);
  });

  it('does not append to the wire when the main agent is absent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    expect(() => service.setTodos([{ title: 'x', status: 'pending' }])).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('binds the stale-todo reminder into every created agent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    void service;

    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    lifecycle.fireCreate(main.handle);
    lifecycle.fireCreate(sub.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(sub.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
  });

  it('rebuilds the list when a todo tools.update_store record is replayed', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: [{ title: 'restored', status: 'done' }] },
    ]);

    expect(service.getTodos()).toEqual([{ title: 'restored', status: 'done' }]);
  });

  it('disposes per-agent bindings when the agent is disposed', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    const main = makeFakeAgent('main');
    lifecycle.fireCreate(main.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(() => lifecycle.fireDispose('main')).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('satisfies the ISessionTodoService contract', () => {
    const lifecycle = makeLifecycleStub();
    const service: ISessionTodoService = new SessionTodoService(lifecycle.service);
    expect(typeof service.getTodos).toBe('function');
    expect(typeof service.setTodos).toBe('function');
    expect(typeof service.clear).toBe('function');
    expect(typeof service.getTodo).toBe('function');
    expect(typeof service.hasTodo).toBe('function');
    expect(typeof service.setTodoCompleted).toBe('function');
    expect(typeof service.onDidChange).toBe('function');
  });

  it('cleans malformed items from a replayed todo tools.update_store record', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    await main.restore([
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'valid', status: 'done' },
          { title: 'missing status' },
          { title: 123, status: 'pending' },
          'garbage',
          { title: 'bad status', status: 'wip' },
        ],
      } as unknown as WireRecord,
    ]);

    expect(service.getTodos()).toEqual([{ title: 'valid', status: 'done' }]);
  });

  it('treats a non-array todo tools.update_store value as an empty list on replay', async () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    await main.restore([
      { type: 'tools.update_store', key: 'todo', value: 'not-an-array' } as unknown as WireRecord,
    ]);

    expect(service.getTodos()).toEqual([]);
  });

  it('getTodo/hasTodo look up items by their stable id', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);
    service.setTodos([
      { title: 'a', status: 'pending', id: 'T1' },
      { title: 'b', status: 'in_progress', id: 'T2' },
    ]);

    expect(service.hasTodo('T1')).toBe(true);
    expect(service.hasTodo('T2')).toBe(true);
    expect(service.hasTodo('T99')).toBe(false);
    expect(service.getTodo('T2')).toEqual({ title: 'b', status: 'in_progress', id: 'T2' });
    expect(service.getTodo('T99')).toBeUndefined();
  });

  it('setTodoCompleted records delivery details and moves pending → in_progress (not done)', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);
    service.setTodos([
      { title: 'a', status: 'pending', id: 'T1', assignee: 'coder' },
      { title: 'b', status: 'pending', id: 'T2' },
    ]);

    const completed = service.setTodoCompleted('T1', { whatDone: 'shipped the fix', assignee: 'explore' });

    expect(completed).toBe(true);
    const updated = service.getTodo('T1');
    // Delivered, awaiting acceptance — never auto-done (done is the lead's call).
    expect(updated?.status).toBe('in_progress');
    expect(updated?.whatDone).toBe('shipped the fix');
    expect(updated?.assignee).toBe('explore');
    expect(updated?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(updated?.id).toBe('T1'); // id and title survive the writeback
    expect(updated?.title).toBe('a');
    // Unrelated todos are untouched.
    expect(service.getTodo('T2')).toEqual({ title: 'b', status: 'pending', id: 'T2' });
  });

  it('setTodoCompleted keeps an existing whatDone/completedAt when the update omits them', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);
    service.setTodos([
      { title: 'a', status: 'pending', id: 'T1', whatDone: 'old note', completedAt: '2025-01-01T00:00:00.000Z' },
    ]);

    service.setTodoCompleted('T1', {});

    const updated = service.getTodo('T1');
    expect(updated?.status).toBe('in_progress');
    expect(updated?.whatDone).toBe('old note');
    expect(updated?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('setTodoCompleted returns false and changes nothing for an unknown id', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);
    service.setTodos([{ title: 'a', status: 'pending', id: 'T1' }]);

    expect(service.setTodoCompleted('T99', { whatDone: 'nope' })).toBe(false);
    expect(service.getTodos()).toEqual([{ title: 'a', status: 'pending', id: 'T1' }]);
  });

  it('setTodoCompleted appends a tools.update_store record for the updated list', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);
    service.setTodos([{ title: 'a', status: 'pending', id: 'T1' }]);
    main.appended.length = 0; // reset to only observe the completion write

    service.setTodoCompleted('T1', { whatDone: 'done' });

    expect(main.appended).toHaveLength(1);
    expect(main.appended[0]).toMatchObject({
      type: 'tools.update_store',
      key: 'todo',
    });
    const value = main.appended[0]!['value'] as readonly TodoItem[];
    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({
      title: 'a',
      status: 'in_progress',
      id: 'T1',
      whatDone: 'done',
    });
  });
});
