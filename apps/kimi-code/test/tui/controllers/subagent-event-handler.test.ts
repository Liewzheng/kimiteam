/**
 * `subagent-event-handler` — background-agent completion rendering under the
 * `background.task.terminated` / `subagent.completed` event race.
 *
 * Regression: a `background.task.terminated` (agent kind) that arrives before
 * `subagent.completed` used to pre-claim the transcript dedup slot, so the
 * completion notice was swallowed. The agent kind must not occupy the slot —
 * `subagent.completed` renders and claims it, with a task-registry fallback
 * when the `subagent.spawned` metadata was never seen.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Event } from '@moonshot-ai/kimi-code-sdk';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHandler() {
  const appendTranscriptEntry = vi.fn();
  const applyBackgroundTaskTerminalStatus = vi.fn();
  const session = {} as never;
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        model: 'kimi-model',
        permissionMode: 'auto',
        workDir: '/tmp',
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      footer: { setBackgroundCounts: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      applyBackgroundTaskTerminalStatus,
      markSubagentBackgrounded: vi.fn(),
      getActiveToolCall: vi.fn(() => undefined),
      getTurnContext: () => ({ turnId: 1 }),
      setTurnId: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      beginCompaction: vi.fn(),
      endCompaction: vi.fn(),
      cancelCompaction: vi.fn(),
    },
    requireSession: vi.fn(() => session),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry,
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: { repaint: vi.fn() },
  };
  const handler = new SessionEventHandler(host as never);
  return { handler, appendTranscriptEntry, applyBackgroundTaskTerminalStatus };
}

function spawnedEvent(
  subagentId = 'agent-1',
  parentToolCallId = 'call-1',
): Event {
  return {
    type: 'subagent.spawned',
    sessionId: 's1',
    agentId: subagentId,
    subagentId,
    subagentName: 'coder',
    parentToolCallId,
    runInBackground: true,
    description: 'write code',
    swarmIndex: undefined,
  } as Event;
}

function completedEvent(subagentId = 'agent-1', resultSummary?: string): Event {
  return {
    type: 'subagent.completed',
    sessionId: 's1',
    agentId: subagentId,
    subagentId,
    resultSummary,
  } as Event;
}

function terminatedEvent(taskId: string, agentId: string): Event {
  return {
    type: 'background.task.terminated',
    sessionId: 's1',
    agentId: 'main',
    info: {
      kind: 'agent',
      taskId,
      agentId,
      subagentType: 'coder',
      description: 'write code',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
    },
  } as Event;
}

function completedEntries(entries: unknown[]): unknown[] {
  return entries.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { backgroundAgentStatus?: { phase?: string } }).backgroundAgentStatus?.phase ===
        'completed',
  );
}

describe('subagent completion under the terminated/completed race', () => {
  it('renders the completion when background.task.terminated arrives first (agent kind does not pre-claim)', () => {
    const { handler, appendTranscriptEntry } = makeHandler();

    handler.handleEvent(spawnedEvent(), vi.fn());
    // Race: the task terminal event beats the lifecycle completion.
    handler.handleEvent(terminatedEvent('task-1', 'agent-1'), vi.fn());

    // Agent kind never occupies the dedup slot here — the card status is
    // applied, but the transcript slot stays free for subagent.completed.
    expect(handler.backgroundTaskTranscriptedTerminal.has('task-1')).toBe(false);

    handler.handleEvent(completedEvent('agent-1', 'done'), vi.fn());

    expect(handler.backgroundTaskTranscriptedTerminal.has('task-1')).toBe(true);
    expect(completedEntries(appendTranscriptEntry.mock.calls.map((c) => c[0]))).toHaveLength(1);
  });

  it('renders the completion exactly once across both event orders', () => {
    const { handler, appendTranscriptEntry } = makeHandler();

    handler.handleEvent(spawnedEvent(), vi.fn());
    handler.handleEvent(completedEvent('agent-1', 'done'), vi.fn());
    // A duplicate completion (or a late terminated) must not render again.
    handler.handleEvent(completedEvent('agent-1', 'done'), vi.fn());
    handler.handleEvent(terminatedEvent('task-1', 'agent-1'), vi.fn());

    expect(completedEntries(appendTranscriptEntry.mock.calls.map((c) => c[0]))).toHaveLength(1);
  });

  it('renders the completion from the task registry when the spawn event was missed', () => {
    const { handler, appendTranscriptEntry } = makeHandler();
    // No `subagent.spawned` — metadata was never registered. The task is still
    // in the registry, so the completion must render from it (fallback).
    handler.backgroundTasks.set('task-9', {
      kind: 'agent',
      taskId: 'task-9',
      agentId: 'agent-9',
      subagentType: 'coder',
      description: 'write code',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
    });

    handler.handleEvent(completedEvent('agent-9', 'done'), vi.fn());

    expect(completedEntries(appendTranscriptEntry.mock.calls.map((c) => c[0]))).toHaveLength(1);
    expect(handler.backgroundTaskTranscriptedTerminal.has('task-9')).toBe(true);
  });
});
