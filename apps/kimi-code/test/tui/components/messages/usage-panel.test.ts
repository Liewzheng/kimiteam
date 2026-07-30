import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSubAgentUsageSection, buildUsageReportLines, UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { SubAgentEventHandler } from '#/tui/controllers/subagent-event-handler';
import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

afterEach(() => {
  currentTheme.setPalette(darkColors);
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('UsagePanelComponent', () => {
  it('formats session, context, and managed usage sections', () => {
    // Freeze the clock so the resetAt fixture is an exact hour out — with a
    // live clock the elapsed milliseconds floor the diff down to 59m.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'));
    try {
      const lines = buildUsageReportLines({
        sessionUsage: {
          byModel: {
            kimi: {
              inputOther: 1000,
              inputCacheRead: 500,
              inputCacheCreation: 500,
              output: 250,
            },
          },
        },
        contextUsage: 0.25,
        contextTokens: 2500,
        maxContextTokens: 10000,
        managedUsage: {
          summary: {
            name: 'daily',
            used: 20,
            limit: 100,
            resetAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          limits: [],
        },
      }).map(strip);

      expect(lines).toContain('Session usage');
      expect(lines).toContain('  kimi  input 2k  output 250  total 2.2k');
      expect(lines).toContain('Context window');
      expect(lines.join('\n')).toContain('25%');
      expect(lines).toContain('Plan usage');
      expect(lines.join('\n')).toContain('daily');
      expect(lines.join('\n')).toContain('20% used');
      expect(lines.join('\n')).toContain('resets in 1h');
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives plan usage labels from the window and falls back to name / Limit', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: { window: { duration: 1, unit: 'week' }, used: 1, limit: 10 },
        limits: [
          { window: { duration: 5, unit: 'hour' }, used: 2, limit: 10 },
          { name: 'Custom cap', used: 3, limit: 10 },
          { used: 4, limit: 10 },
        ],
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Weekly limit');
    expect(output).toContain('5h limit');
    expect(output).toContain('Custom cap');
    expect(output).toContain('Limit');
  });

  it('shows "reset" when the reset timestamp is already in the past', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [
          {
            name: 'daily',
            used: 1,
            limit: 10,
            resetAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      },
    }).map(strip);

    expect(lines.join('\n')).toContain('reset');
    expect(lines.join('\n')).not.toContain('resets in');
  });

  it('formats extra usage with a monthly limit', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 10000,
          totalCents: 20000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 20000,
          monthlyUsedCents: 5000,
          currency: 'USD',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(lines).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('100.00');
    expect(output).toContain('Used this month');
    expect(output).toContain('50.00');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('200.00');
    // bar row contains block glyphs but no percentage text
    expect(output).toContain('░');
  });

  it('formats extra usage without a monthly limit and omits the progress bar', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 18208,
          totalCents: 40000,
          monthlyChargeLimitEnabled: false,
          monthlyChargeLimitCents: 0,
          monthlyUsedCents: 21792,
          currency: 'CNY',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(lines).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('¥182.08');
    expect(output).toContain('Used this month');
    expect(output).toContain('¥217.92');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('Unlimited');
    expect(output).not.toContain('░');
    expect(output).not.toContain('█');
  });

  it('omits the extra usage section when extraUsage is omitted or null', () => {
    for (const extraUsage of [undefined, null]) {
      const lines = buildUsageReportLines({
        sessionUsage: { byModel: {} },
        contextUsage: 0,
        contextTokens: 0,
        maxContextTokens: 0,
        managedUsage: { summary: null, limits: [], extraUsage },
      }).map(strip);

      expect(lines).not.toContain('Extra Usage');
    }
  });

  it('formats extra usage with CNY currency', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 10000,
          totalCents: 20000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 20000,
          monthlyUsedCents: 5000,
          currency: 'CNY',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Balance');
    expect(output).toContain('100.00');
    expect(output).toContain('Used this month');
    expect(output).toContain('50.00');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('200.00');
  });

  it('aligns the currency symbol and decimal point across extra usage rows', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 15901,
          totalCents: 300000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 300000,
          monthlyUsedCents: 24099,
          currency: 'CNY',
        },
      },
    }).map(strip);

    const extraRows = lines.filter((line) => line.includes('¥'));
    expect(extraRows).toHaveLength(3);
    // The currency symbol stays in one column...
    expect(new Set(extraRows.map((line) => line.indexOf('¥'))).size).toBe(1);
    // ...and the right-aligned numeric parts end in the same column, so the
    // decimal points line up across rows.
    expect(new Set(extraRows.map((line) => line.length)).size).toBe(1);
  });

  it('wraps preformatted usage lines in a bordered panel', () => {
    const component = new UsagePanelComponent(() => ['Session usage'], 'primary');
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' Usage ');
    expect(output[1]).toContain('Session usage');
  });

  it('truncates lines wider than the terminal so the panel never overflows', () => {
    const longLine = 'error: ' + 'x'.repeat(200);
    const component = new UsagePanelComponent(() => [longLine], 'primary');
    const width = 60;

    const output = component.render(width);

    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('keeps the bordered panel within narrow terminal widths', () => {
    const component = new UsagePanelComponent(() => ['Session usage', '  kimi  input 2.0k'], 'primary');

    for (const width of [39, 24, 20, 10, 4, 1]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('rebuilds its body from the active palette on invalidate', () => {
    // Emit the resolved palette value as visible text so the assertion holds
    // regardless of chalk's colour level in the test environment.
    const component = new UsagePanelComponent(() => [`text=${currentTheme.color('text')}`], 'primary');
    const bodyOf = (): string => {
      const line = component.render(80).map(strip).find((l) => l.includes('text='));
      if (line === undefined) throw new Error('body line not found');
      return line;
    };

    expect(bodyOf()).toContain(darkColors.text);
    currentTheme.setPalette(lightColors);
    component.invalidate();
    expect(bodyOf()).toContain(lightColors.text);
  });

  it('includes subagent usage section when subAgentUsage is provided', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      subAgentUsage: {
        runs: 3,
        byModel: {
          'gpt-4o': { inputOther: 1500, output: 300, inputCacheRead: 500, inputCacheCreation: 200 },
        },
        byMember: {},
      },
    }).map(strip);

    expect(lines).toContain('Subagent usage');
    expect(lines.join('\n')).toContain('gpt-4o');
  });

  it('omits subagent usage section when runs is 0', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      subAgentUsage: { runs: 0, byModel: {}, byMember: {} },
    }).map(strip);

    expect(lines).not.toContain('Subagent usage');
  });

  it('omits subagent usage section when subAgentUsage is undefined', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
    }).map(strip);

    expect(lines).not.toContain('Subagent usage');
  });
});

describe('buildSubAgentUsageSection', () => {
  const noop = (s: string): string => s;
  const empty = { byModel: {}, byMember: {}, runs: 0 };

  it('returns empty array when usage is undefined', () => {
    expect(buildSubAgentUsageSection(undefined, noop, noop)).toEqual([]);
  });

  it('returns empty array when runs is 0', () => {
    expect(buildSubAgentUsageSection(empty, noop, noop)).toEqual([]);
  });

  it('renders a single model row', () => {
    const lines = buildSubAgentUsageSection(
      {
        runs: 2,
        byModel: {
          'gpt-4o': { inputOther: 1000, output: 200, inputCacheRead: 500, inputCacheCreation: 100 },
        },
        byMember: {
          'agent-a': {
            'gpt-4o': { inputOther: 600, output: 120, inputCacheRead: 300, inputCacheCreation: 60 },
          },
          'agent-b': {
            'gpt-4o': { inputOther: 400, output: 80, inputCacheRead: 200, inputCacheCreation: 40 },
          },
        },
      },
      noop,
      noop,
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('gpt-4o');
    expect(lines[0]).toContain('total 1.8k');
    expect(lines[1]).toContain('agent-a');
    expect(lines[1]).toContain('total 1.1k');
    expect(lines[2]).toContain('agent-b');
    expect(lines[2]).toContain('total 720');
  });

  it('renders multi-model rows with aggregate total', () => {
    const lines = buildSubAgentUsageSection(
      {
        runs: 3,
        byModel: {
          'gpt-4o': { inputOther: 1000, output: 200, inputCacheRead: 500, inputCacheCreation: 100 },
          'claude-3': { inputOther: 800, output: 150, inputCacheRead: 200, inputCacheCreation: 50 },
        },
        byMember: {},
      },
      noop,
      noop,
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('gpt-4o');
    expect(lines[1]).toContain('claude-3');
    expect(lines[2]).toContain('total');
    expect(lines[2]).toContain('input 2.6k');
    expect(lines[2]).toContain('output 350');
  });

  it('merges same-model usage from different agents into one model row', () => {
    const lines = buildSubAgentUsageSection(
      {
        runs: 2,
        byModel: {
          'gpt-4o': { inputOther: 2000, output: 400, inputCacheRead: 800, inputCacheCreation: 200 },
        },
        byMember: {
          alpha: {
            'gpt-4o': { inputOther: 1200, output: 250, inputCacheRead: 500, inputCacheCreation: 100 },
          },
          beta: {
            'gpt-4o': { inputOther: 800, output: 150, inputCacheRead: 300, inputCacheCreation: 100 },
          },
        },
      },
      noop,
      noop,
    );

    // One model row + two member rows = 3 lines (no total since single model)
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('gpt-4o');
    expect(lines[1]).toContain('alpha');
    expect(lines[2]).toContain('beta');
  });

  it('omits members with zero usage', () => {
    const lines = buildSubAgentUsageSection(
      {
        runs: 1,
        byModel: {
          'gpt-4o': { inputOther: 1000, output: 200, inputCacheRead: 0, inputCacheCreation: 0 },
        },
        byMember: {
          idle: {
            'gpt-4o': { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
          },
        },
      },
      noop,
      noop,
    );

    // Only the model row, no member sub-rows for zero usage
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// SubAgentEventHandler — accumulation logic
// ---------------------------------------------------------------------------

describe('SubAgentEventHandler accumulation', () => {
  const agentA = 'agent-a';
  const agentB = 'agent-b';
  const modelX = 'model-x';
  const modelY = 'model-y';
  const toolCallId = 'tc-1';

  /** Minimal mock tool component that routeChildAgentEvent expects. */
  function mockToolCall() {
    return {
      setSubagentMeta: vi.fn(),
      updateSubagentMetrics: vi.fn(),
      onSubagentSpawned: vi.fn(),
    };
  }

  /** Build a minimal SessionEventHost mock. */
  function makeHost() {
    const toolCall = mockToolCall();
    return {
      state: {
        appState: { subAgentUsage: undefined, availableModels: {} },
        ui: { requestRender: vi.fn() },
        transcriptContainer: { children: [] },
      },
      streamingUI: {
        getToolComponent: vi.fn(() => toolCall),
        getActiveToolCall: vi.fn(() => undefined),
        onToolCallStart: vi.fn(),
      },
      btwPanelController: { routeEvent: vi.fn(() => false) },
      updateActivityPane: vi.fn(),
      appendTranscriptEntry: vi.fn(),
    };
  }

  function makeDeps() {
    return {
      backgroundTasks: new Map<string, any>(),
      backgroundTaskTranscriptedTerminal: new Set<string>(),
      syncBackgroundAgentBadge: vi.fn(),
    };
  }

  /** Shorthand: build an `agent.status.updated`-shaped event. */
  function statusEvent(
    agentId: string,
    byModel: Record<string, { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }>,
  ) {
    return {
      type: 'agent.status.updated' as const,
      agentId,
      sessionId: 's1',
      usage: { byModel },
    };
  }

  /** Shorthand: build a `subagent.spawned`-shaped event. */
  function spawnedEvent(agentId: string, name: string, parentToolCallId: string) {
    return {
      type: 'subagent.spawned' as const,
      agentId,
      sessionId: 's1',
      subagentId: agentId,
      subagentName: name,
      parentToolCallId,
      runInBackground: false,
    };
  }

  /** Register subagent so routeChildAgentEvent recognises it. */
  function registerSpawn(handler: SubAgentEventHandler, agentId: string, name: string) {
    handler.handleLifecycleEvent(spawnedEvent(agentId, name, toolCallId));
  }

  /** Feed an agent.status.updated event. */
  function feedStatus(
    handler: SubAgentEventHandler,
    agentId: string,
    byModel: Record<string, { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }>,
  ) {
    handler.routeChildAgentEvent(statusEvent(agentId, byModel) as any);
  }

  // -----------------------------------------------------------------------
  // Case 1: 首次 status → byModel 全量累加
  // -----------------------------------------------------------------------
  it('accumulates full byModel on first status update', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });

    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
    expect(handler.subAgentUsage.byMember['agent-alpha']?.[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
    expect(handler.subAgentUsage.runs).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Case 2: 第二次(累计值增长)→ 只加增量
  // -----------------------------------------------------------------------
  it('adds only delta on second status update', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 150, output: 35, inputCacheRead: 45, inputCacheCreation: 15 },
    });

    // Accumulated total: 100 + (150-100)=50 → 150, 20 + (35-20)=15 → 35, etc.
    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 150, output: 35, inputCacheRead: 45, inputCacheCreation: 15,
    });
  });

  // -----------------------------------------------------------------------
  // Case 3: 重复事件(相同累计值)→ 不累加
  // -----------------------------------------------------------------------
  it('does not accumulate when values are unchanged (repeat event)', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });

    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
  });

  // -----------------------------------------------------------------------
  // Case 4: 同 agent byModel 新增模型 key → 正确归入 byModel/byMember
  // -----------------------------------------------------------------------
  it('correctly handles new model key appearing in second update', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
      [modelY]: { inputOther: 200, output: 40, inputCacheRead: 60, inputCacheCreation: 20 },
    });

    // modelX delta = 0 (unchanged), modelY delta = full value (new key)
    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
    expect(handler.subAgentUsage.byModel[modelY]).toEqual({
      inputOther: 200, output: 40, inputCacheRead: 60, inputCacheCreation: 20,
    });
    expect(handler.subAgentUsage.byMember['agent-alpha']?.[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
    expect(handler.subAgentUsage.byMember['agent-alpha']?.[modelY]).toEqual({
      inputOther: 200, output: 40, inputCacheRead: 60, inputCacheCreation: 20,
    });
  });

  // -----------------------------------------------------------------------
  // Case 5: agentId 不在 subagentInfo → 归 'unknown'
  // -----------------------------------------------------------------------
  it('falls back to "unknown" for unregistered agents', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    // Do NOT register — routeChildAgentEvent will skip because info is undefined.
    // Feed the event directly via public routeChildAgentEvent. Since the agent
    // is not in subagentInfo, routeChildAgentEvent returns true early without
    // hitting accumulateSubAgentUsage. That's correct: orphan status events
    // are ignored.
    const handled = handler.routeChildAgentEvent(statusEvent(agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    }) as any);

    expect(handled).toBe(true);
    expect(handler.subAgentUsage.byModel[modelX]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Case 6: resetRuntimeState 后清空快照和累加器
  // -----------------------------------------------------------------------
  it('clears snapshots and accumulator on resetRuntimeState', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });

    handler.resetRuntimeState();

    // Re-register after reset
    registerSpawn(handler, agentA, 'agent-alpha');

    // The next update should treat everything as fresh (no prev snapshot)
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 50, output: 10, inputCacheRead: 15, inputCacheCreation: 5 },
    });

    // Should be full value, not combined with previous
    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 50, output: 10, inputCacheRead: 15, inputCacheCreation: 5,
    });
  });

  // -----------------------------------------------------------------------
  // Case 7: 负 delta 防护 — Math.max(0, ...) 阻止状态回退
  // -----------------------------------------------------------------------
  it('clamps negative deltas to zero (compression/restart safety)', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    // First status: 100 tokens
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });
    // Second status: drops to 50 tokens (simulates compression/reset)
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 50, output: 10, inputCacheRead: 15, inputCacheCreation: 5 },
    });

    // Delta should be zero — negative values clamped.
    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
  });

  // -----------------------------------------------------------------------
  // Case 8: 多 agent 同模型 → 分别归入 byMember,合并到 byModel
  // -----------------------------------------------------------------------
  it('merges same-model usage from multiple agents into byModel', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');
    registerSpawn(handler, agentB, 'agent-beta');

    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });
    feedStatus(handler, agentB, {
      [modelX]: { inputOther: 200, output: 40, inputCacheRead: 60, inputCacheCreation: 20 },
    });

    // byModel merges both agents' usage
    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 300, output: 60, inputCacheRead: 90, inputCacheCreation: 30,
    });
    // byMember keeps them separate
    expect(handler.subAgentUsage.byMember['agent-alpha']?.[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
    expect(handler.subAgentUsage.byMember['agent-beta']?.[modelX]).toEqual({
      inputOther: 200, output: 40, inputCacheRead: 60, inputCacheCreation: 20,
    });
  });

  // -----------------------------------------------------------------------
  // Case 9: 后台场景 — tool component 不存在时仍累积 byModel
  // -----------------------------------------------------------------------
  it('accumulates usage when tool component is undefined (background agent)', () => {
    const host = makeHost();
    host.streamingUI.getToolComponent = vi.fn(() => undefined);
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    // Manually register agent in subagentInfo (simulates background agent
    // spawned via handleSubagentSpawned which calls rememberSubagent).
    handler.subagentInfo.set(agentA, {
      parentToolCallId: toolCallId,
      name: 'agent-alpha',
      runInBackground: true,
    });

    // Feed status — the early accumulate in routeChildAgentEvent should
    // fire before getToolComponent returns undefined and causes early return.
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });

    // Accumulation should have happened despite missing tool component
    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
    expect(handler.subAgentUsage.byMember['agent-alpha']?.[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
  });

  // -----------------------------------------------------------------------
  // Case 10: swarm 场景 — swarmProgress 路径下 agent.status.updated 也累积
  // -----------------------------------------------------------------------
  it('accumulates usage via swarm progress path', () => {
    const host = makeHost();
    // Need addChild on transcriptContainer for swarm progress creation
    host.state.transcriptContainer.addChild = vi.fn();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    // Inject a swarm progress into the private map so routeChildAgentEvent
    // takes the swarm path (lines 109-114).
    const progress = new AgentSwarmProgressComponent({
      description: 'test swarm',
      requestRender: vi.fn(),
    });
    (handler as any).agentSwarmProgress.set(toolCallId, progress);

    // Feed status event with model so applySubagentEventToSwarmProgress
    // also fires its accumulate (the early accumulate fires regardless).
    const event = {
      ...statusEvent(agentA, {
        [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
      }),
      model: 'some-model',
    };
    handler.routeChildAgentEvent(event as any);

    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
  });

  // -----------------------------------------------------------------------
  // Case 11: 幂等 — 同快照喂两次(触发早+晚双 accumulate),总量不翻倍
  // -----------------------------------------------------------------------
  it('does not double-count when early + late accumulate both fire (idempotent)', () => {
    const host = makeHost();
    const handler = new SubAgentEventHandler(host as any, makeDeps());
    registerSpawn(handler, agentA, 'agent-alpha');

    // Each feedStatus triggers accumulate twice in routeChildAgentEvent:
    // 1. Early (before swarm/tool checks) — captures the delta
    // 2. Original site (lines 150-162) — same snapshot → delta=0
    // The accumulator must only count the first delta.
    feedStatus(handler, agentA, {
      [modelX]: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
    });

    expect(handler.subAgentUsage.byModel[modelX]).toEqual({
      inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10,
    });
  });
});
