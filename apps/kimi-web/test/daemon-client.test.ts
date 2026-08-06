// apps/kimi-web/test/daemon-client.test.ts
// DaemonKimiWebApi public REST adapter: session export binary/error contracts,
// getSessionGoal wire → app mapping, and raw stream-coordinate delivery.
// Wiring: real client/projector; fetch or WebSocket is stubbed at the network boundary.
// Run: pnpm --filter @moonshot-ai/kimi-web exec vitest run test/daemon-client.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { DaemonHttpClient } from '../src/api/daemon/http';
import { DaemonApiError, DaemonNetworkError } from '../src/api/errors';
import { clearTrace, traceToJsonl } from '../src/debug/trace';
import type { AppEvent, KimiEventConnection, KimiEventMeta } from '../src/api/types';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: CloseEvent) => void) | null = null;

  constructor(_url: string, _protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Flat (non-envelope) response body, like the daemon teams routes send. */
function flat(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

const WIRE_GOAL = {
  goalId: 'goal_1',
  objective: 'fix all lint warnings',
  status: 'active',
  turnsUsed: 1,
  tokensUsed: 0,
  wallClockMs: 0,
  budget: {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

function createApi(): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    serverHttpUrl: 'http://daemon.test',
    clientId: 'web_test',
    clientName: 'test',
    clientVersion: '0.0.0',
    clientUiMode: 'test',
  });
}

describe('DaemonKimiWebApi.exportSession', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '?debug=1' });
    vi.stubGlobal('fetch', vi.fn());
    clearTrace();
  });

  afterEach(() => {
    clearTrace();
    vi.unstubAllGlobals();
  });

  it('posts the Web log to the encoded session export endpoint and returns the ZIP', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="session-export.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess/1', '{"event":"safe"}');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/export',
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ web_log: '{"event":"safe"}' }),
    });
    expect(result.fileName).toBe('session-export.zip');
    expect(result.blob.size).toBe(4);
  });

  it('falls back to a session-id ZIP name for an unsafe response filename', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="../credentials.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess_1');

    expect(result.fileName).toBe('sess_1.zip');
  });

  it('parses a JSON error envelope returned by the export endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ code: 41301, msg: 'export too large', request_id: 'req_server' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const caught = await createApi()
      .exportSession('sess_1', 'log')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 41301, requestId: 'req_server' });
  });

  it('rejects a successful response whose media type is not a ZIP', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('not a zip', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const caught = await createApi().exportSession('sess_1').catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ phase: 'parse', contentType: 'text/plain' });
  });

  it('records only Web-log counts in the request trace', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
    );
    const secret = 'PROMPT_CONTENT_MUST_NOT_ENTER_TRACE';

    await createApi().exportSession('sess_1', `${secret}\nsecond line`);

    const trace = traceToJsonl();
    expect(trace).not.toContain(secret);
    expect(trace).toContain('web_log_bytes');
    expect(trace).toContain('web_log_entries');
  });
});

describe('DaemonKimiWebApi.getSessionGoal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a present goal snapshot', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(WIRE_GOAL));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal?.objective).toBe('fix all lint warnings');
    expect(goal?.status).toBe('active');
    expect(goal?.turnsUsed).toBe(1);
  });

  it('maps null to null (no active goal)', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal).toBeNull();
  });

  it('requests the session goal endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    await createApi().getSessionGoal('sess_42');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess_42/goal',
    );
  });
});

describe('DaemonKimiWebApi.connectEvents', () => {
  let connection: KimiEventConnection | undefined;

  afterEach(() => {
    connection?.close();
    connection = undefined;
    vi.unstubAllGlobals();
  });

  it('delivers raw assistant stream coordinates with the projected delta', () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: Array<{ event: AppEvent; meta: KimiEventMeta }> = [];
    connection = createApi().connectEvents({
      onEvent(event, meta) {
        received.push({ event, meta });
      },
      onResync() {},
      onError() {},
      onConnectionChange() {},
    });
    const socket = FakeWebSocket.instances[0]!;

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'turn.started',
      seq: 1,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { agentId: 'main', turnId: 7 },
    });
    socket.emit({
      type: 'turn.step.started',
      seq: 2,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { agentId: 'main', turnId: 7, step: 1 },
    });
    socket.emit({
      type: 'assistant.delta',
      seq: 2,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      volatile: true,
      offset: 0,
      payload: { agentId: 'main', turnId: 7, delta: 'hello' },
    });
    socket.emit({
      type: 'thinking.delta',
      seq: 2,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      volatile: true,
      offset: 0,
      payload: { agentId: 'main', turnId: 7, delta: 'thought' },
    });

    const delta = received.find(({ event }) => event.type === 'assistantDelta');
    expect(delta).toMatchObject({
      event: {
        type: 'assistantDelta',
        sessionId: 'session-1',
        delta: { text: 'hello' },
      },
      meta: {
        sessionId: 'session-1',
        seq: 2,
        stream: { turnId: 7, offset: 0, kind: 'text' },
      },
    });

    const thinking = received.find(
      ({ event }) => event.type === 'assistantDelta' && event.delta.thinking !== undefined,
    );
    expect(thinking).toMatchObject({
      event: {
        type: 'assistantDelta',
        sessionId: 'session-1',
        delta: { thinking: 'thought' },
      },
      meta: {
        sessionId: 'session-1',
        seq: 2,
        stream: { turnId: 7, offset: 0, kind: 'thinking' },
      },
    });
  });

  it('projects list-level work facts from the global session event', () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: AppEvent[] = [];
    connection = createApi().connectEvents({
      onEvent(event) {
        received.push(event);
      },
      onResync() {},
      onError() {},
      onConnectionChange() {},
    });
    const [socket] = FakeWebSocket.instances;
    if (socket === undefined) throw new Error('WebSocket was not created');

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'event.session.work_changed',
      seq: 1,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        busy: true,
        main_turn_active: false,
        pending_interaction: 'question',
      },
    });

    expect(received).toContainEqual({
      type: 'sessionWorkChanged',
      sessionId: 'session-1',
      busy: true,
      mainTurnActive: false,
      pendingInteraction: 'question',
      lastTurnReason: undefined,
    });
  });
});

describe('DaemonHttpClient.requestFlat', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed body directly on 2xx (no envelope unwrap)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      flat({ team_mode: true, global: [], project: [] }),
    );

    const body = await new DaemonHttpClient('http://daemon.test').requestFlat<{
      team_mode: boolean;
    }>('GET', '/teams/s1/members');

    expect(body).toEqual({ team_mode: true, global: [], project: [] });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/teams/s1/members',
    );
  });

  it('throws a DaemonApiError carrying the flat error message on non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValue(
      flat({ ok: false, error: 'session s1 not found' }, 404),
    );

    const caught = await new DaemonHttpClient('http://daemon.test')
      .requestFlat<unknown>('GET', '/teams/s1/members')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 404, message: 'session s1 not found' });
  });

  it('falls back to statusText when the flat error body has no error field', async () => {
    // In real browsers fetch() populates statusText from the reason phrase; in
    // Node's Response constructor it must be supplied explicitly.
    vi.mocked(fetch).mockResolvedValue(flat({ ok: false }, 502, 'Bad Gateway'));

    const caught = await new DaemonHttpClient('http://daemon.test')
      .requestFlat<unknown>('POST', '/teams/s1/members')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 502, message: 'Bad Gateway' });
  });
});

describe('DaemonKimiWebApi team endpoints (flat bodies)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const MEMBER = {
    name: 'alpha',
    role: 'builder',
    description: 'writes code',
    when_to_use: 'when building',
    model: 'kimi-k2',
    tools: ['read'],
    duty: true,
    status: 'working',
    score: { average: 4.5, count: 2 },
  };

  it('getTeamMembers maps the flat snake_case roster', async () => {
    vi.mocked(fetch).mockResolvedValue(
      flat({ team_mode: true, global: [MEMBER], project: [] }),
    );

    const team = await createApi().getTeamMembers('s1');

    expect(team.teamMode).toBe(true);
    expect(team.global[0]).toMatchObject({ name: 'alpha', duty: true, status: 'working' });
    expect(team.global[0]?.score).toEqual({ average: 4.5, count: 2 });
    expect(team.project).toEqual([]);
  });

  it('getTeamMembers surfaces the flat 404 error message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      flat({ ok: false, error: 'session s1 not found' }, 404),
    );

    const caught = await createApi()
      .getTeamMembers('s1')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 404, message: 'session s1 not found' });
  });

  it('getTeamUsage maps the camelCase usage body (byModel/byMember)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      flat({
        runs: 3,
        byModel: {
          'kimi-k2': { input: 100, output: 50, total: 150 },
          'kimi-lite': { input: 10, output: 5, total: 15 },
        },
        byMember: {
          alpha: { 'kimi-k2': { input: 60, output: 30, total: 90 } },
        },
        stale: false,
      }),
    );

    const usage = await createApi().getTeamUsage('s1');

    expect(usage.runs).toBe(3);
    expect(usage.byModel['kimi-k2']).toEqual({
      inputOther: 100,
      output: 50,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(usage.byMember.alpha?.['kimi-k2']?.inputOther).toBe(60);
    expect(usage.secondaryModelId).toBeNull();
  });

  it('hireTeamMember unwraps the { ok, member } flat response', async () => {
    vi.mocked(fetch).mockResolvedValue(flat({ ok: true, member: MEMBER }));

    const member = await createApi().hireTeamMember('s1', {
      name: 'alpha',
      role: 'builder',
      description: 'writes code',
      whenToUse: 'when building',
      prompt: 'be good',
    });

    expect(member).toMatchObject({ name: 'alpha', role: 'builder', model: 'kimi-k2' });
  });

  it('scoreTeamMember maps the flat { ok, warning } action result', async () => {
    vi.mocked(fetch).mockResolvedValue(flat({ ok: true, warning: 'score drift' }));

    const result = await createApi().scoreTeamMember('s1', 'alpha', {
      score: 95,
      note: 'great',
    });

    expect(result).toEqual({ ok: true, warning: 'score drift' });
  });

  it('fireTeamMember / messageTeamAgent / setTeamConcurrency accept flat { ok: true }', async () => {
    // Each call needs its own Response — a shared instance's body is consumed
    // after the first json() read.
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(flat({ ok: true })));

    await expect(createApi().fireTeamMember('s1', 'alpha')).resolves.toEqual({ ok: true });
    await expect(
      createApi().messageTeamAgent('s1', 'alpha', { message: 'hi' }),
    ).resolves.toEqual({ ok: true });
    await expect(createApi().setTeamConcurrency('s1', 3)).resolves.toEqual({ ok: true });
  });
});
