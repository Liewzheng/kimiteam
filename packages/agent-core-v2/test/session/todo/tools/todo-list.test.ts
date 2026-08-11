import { describe, expect, it } from 'vitest';

import { type ISessionTodoService } from '#/session/todo/sessionTodo';
import { TODO_LIST_TOOL_NAME, type TodoItem } from '#/session/todo/todoItem';
import { ITodoService } from '#/app/todoCounter/todoCounter';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TodoListInputSchema } from '#/agent/tools/todo-list/todo-list';
import { TodoListTool } from '#/agent/tools/todo-list/todoListTool';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function makeScopeContext(agentId: string): IAgentScopeContext {
  return {
    _serviceBrand: undefined,
    agentId,
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? `agents/${agentId}` : `agents/${agentId}/${subKey}`,
  };
}

function makeTodoService(initial: readonly TodoItem[] = []): {
  readonly service: ISessionTodoService;
  readonly getTodos: () => readonly TodoItem[];
} {
  let todos = [...initial];
  return {
    service: {
      _serviceBrand: undefined,
      getTodos: () => todos,
      setTodos: (next: readonly TodoItem[]) => {
        todos = next.map((todo) => ({ ...todo }));
      },
      clear: () => {
        todos = [];
      },
      getTodo: (id: string) => todos.find((todo) => todo.id === id),
      hasTodo: (id: string) => todos.some((todo) => todo.id === id),
      setTodoCompleted: () => false,
      onDidChange: () => ({ dispose: () => {} }),
    },
    getTodos: () => todos,
  };
}

function makeTodoIdService(start = 0): ITodoService & { readonly issued: string[] } {
  let current = start;
  const issued: string[] = [];
  return {
    _serviceBrand: undefined,
    nextTodoId: async () => {
      current += 1;
      const id = `T${current}`;
      issued.push(id);
      return id;
    },
    issued,
  };
}

function makeTool(
  initial: readonly TodoItem[] = [],
  agentId: string = 'main',
): {
  readonly tool: TodoListTool;
  readonly getTodos: () => readonly TodoItem[];
  readonly issued: string[];
} {
  const { service, getTodos } = makeTodoService(initial);
  const todoId = makeTodoIdService();
  return {
    tool: new TodoListTool(makeScopeContext(agentId), service, todoId),
    getTodos,
    issued: todoId.issued,
  };
}

describe('TodoListTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const { tool } = makeTool();

    expect(TODO_LIST_TOOL_NAME).toBe('TodoList');
    expect(tool.name).toBe(TODO_LIST_TOOL_NAME);
    expect(tool.description.length).toBeGreaterThan(0);
    expect(TodoListInputSchema.safeParse({}).success).toBe(true);
    expect(
      TodoListInputSchema.safeParse({ todos: [{ title: 'x', status: 'wip' }] }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        todos: { type: 'array' },
      },
    });
  });

  it('description includes the anti-churn guardrails', () => {
    const { description } = makeTool().tool;

    expect(description).toContain('**Avoid churn:**');
    expect(description).toMatch(/nothing meaningful has changed/i);
    expect(description).toMatch(/real progress/i);
    expect(description).toMatch(/query mode/i);
    expect(description).toMatch(/tell the user/i);
  });

  it('description encourages proactive progress updates without allowing churn', () => {
    const { description } = makeTool().tool;

    expect(description).toMatch(/proactively and often/i);
    expect(description).toMatch(/immediately after finishing/i);
    expect(description).toMatch(/exactly one/i);
    expect(description).toMatch(/in_progress/i);
    expect(description).toMatch(/tests are failing/i);
    expect(description).toContain('**Avoid churn:**');
  });

  it('query mode renders the current list without mutating it', async () => {
    const { tool, getTodos } = makeTool([{ title: 'existing', status: 'in_progress' }]);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Current todo list');
    expect(result.output).toContain('[in_progress] existing');
    expect(getTodos()).toEqual([{ title: 'existing', status: 'in_progress' }]);
  });

  it('write mode replaces the list and defensively copies todos into the service', async () => {
    const { tool, getTodos } = makeTool();
    const todos: TodoItem[] = [
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ];

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { todos },
      signal,
    });
    todos[0] = { title: 'leaked', status: 'done' };

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Todo list updated');
    expect(result.output).toContain('[pending] first');
    expect(result.output).toContain('[in_progress] second');
    expect(result.output).toContain(
      'Ensure that you continue to use the todo list to track progress.',
    );
    expect(result.output).toContain('exactly one task in_progress');
    expect(getTodos()).toEqual([
      { title: 'first', status: 'pending', id: 'T1' },
      { title: 'second', status: 'in_progress', id: 'T2' },
    ]);
  });

  it('renders a done todo with a marker matching the status enum value', async () => {
    const { tool } = makeTool([{ title: 'shipped', status: 'done' }]);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('[done] shipped');
    expect(result.output).not.toContain('[completed]');
  });

  it('clear mode empties the list without adding the progress-tracking reminder', async () => {
    const { tool, getTodos } = makeTool([{ title: 'x', status: 'pending' }]);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { todos: [] },
      signal,
    });

    expect(result).toMatchObject({ isError: false, output: 'Todo list cleared.' });
    expect(getTodos()).toEqual([]);
  });

  it('resolveExecution description reflects the mode', () => {
    const { tool } = makeTool();
    const readExecution = tool.resolveExecution({});
    const clearExecution = tool.resolveExecution({ todos: [] });
    const updateExecution = tool.resolveExecution({
      todos: [{ title: 'x', status: 'pending' }],
    });

    if (
      readExecution.isError === true ||
      clearExecution.isError === true ||
      updateExecution.isError === true
    ) {
      throw new TypeError('expected runnable executions');
    }
    expect(readExecution.description).toBe('Reading todo list');
    expect(clearExecution.description).toBe('Clearing todo list');
    expect(updateExecution.description).toBe('Updating todo list');
  });

  it('assigns a fresh id to every todo that lacks one (T1, T2, T3, …)', async () => {
    const { tool, getTodos, issued } = makeTool();

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: {
        todos: [
          { title: 'a', status: 'pending' },
          { title: 'b', status: 'in_progress' },
          { title: 'c', status: 'pending' },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(issued).toEqual(['T1', 'T2', 'T3']);
    expect(getTodos()).toEqual([
      { title: 'a', status: 'pending', id: 'T1' },
      { title: 'b', status: 'in_progress', id: 'T2' },
      { title: 'c', status: 'pending', id: 'T3' },
    ]);
  });

  it('keeps an explicit id and does not consume the counter for it', async () => {
    const { tool, getTodos, issued } = makeTool();

    await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: {
        todos: [
          { title: 'existing', status: 'done', id: 'T42' },
          { title: 'fresh', status: 'pending' },
        ],
      },
      signal,
    });

    expect(issued).toEqual(['T1']); // only the id-less item allocates
    expect(getTodos()).toEqual([
      { title: 'existing', status: 'done', id: 'T42' },
      { title: 'fresh', status: 'pending', id: 'T1' },
    ]);
  });

  it('treats a whitespace-only id as missing and allocates a fresh one', async () => {
    const { tool, getTodos, issued } = makeTool();

    await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { todos: [{ title: 'blank-id', status: 'pending', id: '   ' }] },
      signal,
    });

    expect(issued).toEqual(['T1']);
    expect(getTodos()).toEqual([{ title: 'blank-id', status: 'pending', id: 'T1' }]);
  });

  it('echoes the assigned id in the update output so the dispatch gate can accept it', async () => {
    const { tool, getTodos, issued } = makeTool();

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { todos: [{ title: 'dispatch target', status: 'pending' }] },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('T1 [pending] dispatch target');
    expect(issued).toEqual(['T1']);
    // The dispatch gate (Agent/AgentSwarm assertDispatchTodo) resolves todo_id
    // by exact id lookup (getTodo) — the echoed id must round-trip into it.
    expect(getTodos().find((t) => t.id === 'T1')).toEqual({
      title: 'dispatch target',
      status: 'pending',
      id: 'T1',
    });
  });

  it('query mode echoes the assigned ids back after a write', async () => {
    const { tool } = makeTool();

    await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_write',
      args: {
        todos: [
          { title: 'a', status: 'pending' },
          { title: 'b', status: 'in_progress' },
        ],
      },
      signal,
    });
    const query = await executeTool(tool, {
      turnId: 2,
      toolCallId: 'call_query',
      args: {},
      signal,
    });

    expect(query).toMatchObject({ isError: false });
    expect(query.output).toContain('T1 [pending] a');
    expect(query.output).toContain('T2 [in_progress] b');
  });

  it('echoes an explicit id back unchanged in the update output', async () => {
    const { tool, issued } = makeTool();

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { todos: [{ title: 'explicit', status: 'done', id: 't42' }] },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(issued).toEqual([]); // no counter allocation for an explicit id
    expect(result.output).toContain('t42 [done] explicit');
  });

  it('rejects a non-main (subagent) caller with a synthetic tool error before execution', async () => {
    const { tool, getTodos, issued } = makeTool(
      [{ title: 'existing', status: 'in_progress' }],
      'agent-7',
    );

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_sub',
      args: { todos: [{ title: 'hijack', status: 'pending' }] },
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('reserved for the main agent');
    // The list and the id counter must stay untouched — the write never ran.
    expect(getTodos()).toEqual([{ title: 'existing', status: 'in_progress' }]);
    expect(issued).toEqual([]);
  });

  it('rejects a non-main read with the same synthetic error and no mutation', async () => {
    const { tool, getTodos } = makeTool(
      [{ title: 'secret', status: 'pending' }],
      'agent-7',
    );

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_sub_read',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('reserved for the main agent');
    expect(getTodos()).toEqual([{ title: 'secret', status: 'pending' }]);
  });

  it('keeps the main agent fully functional (read + write)', async () => {
    const { tool, getTodos, issued } = makeTool(
      [{ title: 'main-item', status: 'in_progress' }],
      'main',
    );

    const read = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_main_read',
      args: {},
      signal,
    });
    expect(read).toMatchObject({ isError: false });
    expect(read.output).toContain('[in_progress] main-item');

    const write = await executeTool(tool, {
      turnId: 2,
      toolCallId: 'call_main_write',
      args: { todos: [{ title: 'replacement', status: 'done' }] },
      signal,
    });
    expect(write).toMatchObject({ isError: false });
    expect(issued).toEqual(['T1']);
    expect(getTodos()).toEqual([{ title: 'replacement', status: 'done', id: 'T1' }]);
  });
});
