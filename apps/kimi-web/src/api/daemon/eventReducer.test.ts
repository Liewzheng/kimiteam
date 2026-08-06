// apps/kimi-web/src/api/daemon/eventReducer.test.ts
// Pure reducer tests for the subagent workflow state: text/thinking streamed
// output accumulates into separate AppTask fields, tool-progress stays a line
// log, and a lifecycle re-projection never clobbers the accumulated deltas.
import { describe, expect, it } from 'vitest';
import { createInitialState, reduceAppEvent, type EventMeta } from './eventReducer';
import type { AppEvent, AppTask } from '../types';

const sid = 's1';
const taskId = 't1';
const meta: EventMeta = { sessionId: sid, seq: 1 };

const subagentTask = (over: Partial<AppTask> = {}): AppTask => ({
  id: taskId,
  sessionId: sid,
  kind: 'subagent',
  description: 'Summarizer',
  status: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  subagentPhase: 'working',
  ...over,
});

const stateWith = (task: AppTask) => {
  const s = createInitialState();
  s.tasksBySession = { [sid]: [task] };
  return s;
};

const progress = (
  kind: 'line' | 'text' | 'thinking',
  chunk: string,
): AppEvent =>
  ({
    type: 'taskProgress',
    sessionId: sid,
    taskId,
    outputChunk: chunk,
    stream: 'stdout',
    ...(kind === 'line' ? {} : { kind }),
  }) as AppEvent;

const taskCreated = (task: AppTask): AppEvent => ({ type: 'taskCreated', sessionId: sid, task });

describe('taskProgress → AppTask streamed output', () => {
  it('concatenates `text` chunks into AppTask.text', () => {
    let st = stateWith(subagentTask());
    st = reduceAppEvent(st, progress('text', 'Found '), meta);
    st = reduceAppEvent(st, progress('text', '2 issues\n'), meta);
    const t = st.tasksBySession[sid]![0]!;
    expect(t.text).toBe('Found 2 issues\n');
    expect(t.thinking).toBeUndefined();
  });

  it('concatenates `thinking` chunks into AppTask.thinking, leaving text untouched', () => {
    let st = stateWith(subagentTask());
    st = reduceAppEvent(st, progress('thinking', 'Let me scan'), meta);
    st = reduceAppEvent(st, progress('thinking', ' the repo.\n'), meta);
    const t = st.tasksBySession[sid]![0]!;
    expect(t.thinking).toBe('Let me scan the repo.\n');
    expect(t.text).toBeUndefined();
  });

  it('keeps text and thinking in separate surfaces when both stream', () => {
    let st = stateWith(subagentTask());
    st = reduceAppEvent(st, progress('thinking', 'step 1\n'), meta);
    st = reduceAppEvent(st, progress('text', 'Summary:\n'), meta);
    st = reduceAppEvent(st, progress('thinking', 'step 2\n'), meta);
    const t = st.tasksBySession[sid]![0]!;
    expect(t.thinking).toBe('step 1\nstep 2\n');
    expect(t.text).toBe('Summary:\n');
  });

  it('keeps tool-progress chunks (kind line) out of text/thinking', () => {
    let st = stateWith(subagentTask());
    st = reduceAppEvent(st, progress('line', 'Calling Read: a.ts'), meta);
    const t = st.tasksBySession[sid]![0]!;
    expect(t.text).toBeUndefined();
    expect(t.thinking).toBeUndefined();
    expect(t.outputLines).toEqual(['Calling Read: a.ts']);
  });
});

describe('taskCreated re-projection preserves accumulated stream', () => {
  it('keeps text/thinking when a lifecycle event re-projects the task without them', () => {
    let st = stateWith(subagentTask());
    st = reduceAppEvent(st, progress('thinking', 'scan\n'), meta);
    st = reduceAppEvent(st, progress('text', 'ok\n'), meta);
    // A post-refresh lifecycle event re-projects the task with skeleton
    // metadata — the reducer must not let its empty stream clobber the live one.
    st = reduceAppEvent(st, taskCreated(subagentTask({ status: 'completed', subagentPhase: 'completed' })), meta);
    const t = st.tasksBySession[sid]![0]!;
    expect(t.text).toBe('ok\n');
    expect(t.thinking).toBe('scan\n');
    expect(t.status).toBe('completed');
  });
});
