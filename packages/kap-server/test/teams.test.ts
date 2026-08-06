/**
 * `/api/v1/teams/{session_id}/*` — Web team-management route tests.
 *
 * Boots a real kap-server against an isolated temp home (including a temp
 * `osHomeDir`, so the file roster never leaks the developer's real
 * `~/.kimi-code/agents`), creates a live session, and exercises the flat team
 * wire contract: members list, hire, anti-overwrite, fire, update, score
 * (with and without the inflation warning), message (404 for a missing
 * member agent), and concurrency.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeSessionById,
  ConfigTarget,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentPerformanceService,
  IAgentProfileService,
  IAgentUsageService,
  IBootstrapOptions,
  IConfigService,
  IModelCatalog,
  IRuntimeStatusService,
  resolveBootstrapOptions,
  type ModelRequester,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface MemberWire {
  name: string;
  role?: string;
  description: string;
  when_to_use?: string;
  model?: string;
  prompt?: string;
  tools: string[];
  skills?: string[];
  duty?: boolean;
  status: 'working' | 'resting' | 'on-duty' | 'off-duty';
  score: { average: number | null; count: number };
  usage: { input: number; output: number; total: number };
}

interface MembersBody {
  team_mode: boolean;
  global: MemberWire[];
  project: MemberWire[];
}

interface OkBody<T = unknown> {
  ok: boolean;
  error?: string;
  member?: MemberWire;
  warning?: string;
  [key: string]: unknown;
}

describe('server-v2 /api/v1/teams/{session_id}', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-teams-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [
        // Isolate the file roster: the harness defaults osHomeDir to the real
        // home, which would leak the developer's ~/.kimi-code/agents into the
        // team member listing. Point both homeDir and osHomeDir at the temp dir.
        [
          IBootstrapOptions,
          resolveBootstrapOptions({
            clientIdentity: TEST_HOST_IDENTITY,
            homeDir: home,
            osHomeDir: home,
          }),
        ],
      ],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      // macOS can ENOTEMPTY an rmdir while a query-store append is still in
      // flight after session/agent creation — retry briefly before giving up.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(home, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    // The session cwd is the project root: use a dedicated `<home>/project` so
    // the project team root (`<home>/project/.kimi-code/agents`) stays distinct
    // from the global roots (`<home>/agents`, `<home>/.kimi-code/agents`).
    await mkdir(join(home as string, 'project'), { recursive: true });
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: join(home as string, 'project') } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  /** All members across both scopes, for status/archive lookups. */
  function allMembers(body: unknown): MemberWire[] {
    const m = body as MembersBody;
    return [...m.global, ...m.project];
  }

  async function teamFetch(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: OkBody }> {
    const headers: Record<string, string> = authHeaders(server as RunningServer);
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    } as never);
    return { status: res.status, body: (await res.json()) as OkBody };
  }

  it('returns an empty roster with team_mode when nothing is hired', async () => {
    const id = await createSession();
    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members`);
    expect(status).toBe(200);
    expect(body['team_mode']).toBe(false);
    expect((body as unknown as MembersBody).global).toEqual([]);
    expect((body as unknown as MembersBody).project).toEqual([]);
  });

  it('hires a member and lists it in the global team with parsed frontmatter', async () => {
    const id = await createSession();
    const hire = await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: {
        name: 'code-reviewer',
        role: 'reviewer',
        description: 'Reviews code',
        when_to_use: 'code review',
        model: 'secondary',
        tools: ['Read', 'Grep'],
        skills: ['commit'],
        duty: true,
        prompt: 'You review code.',
      },
    });
    expect(hire.status).toBe(200);
    expect(hire.body.ok).toBe(true);
    expect(hire.body.member).toMatchObject({
      name: 'code-reviewer',
      role: 'reviewer',
      description: 'Reviews code',
      when_to_use: 'code review',
      model: 'secondary',
      tools: ['Read', 'Grep'],
      skills: ['commit'],
      duty: true,
      status: 'on-duty',
      score: { average: null, count: 0 },
    });

    const list = await teamFetch(`/api/v1/teams/${id}/members`);
    const members = list.body as unknown as MembersBody;
    expect(members.global).toHaveLength(1);
    expect(members.global[0]!.name).toBe('code-reviewer');
    expect(members.project).toEqual([]);
  });

  it('hires a member into the project team when scope=project', async () => {
    const id = await createSession();
    const hire = await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'proj-dev', description: 'Project dev', prompt: 'Do project work.', scope: 'project' },
    });
    expect(hire.status).toBe(200);
    expect(hire.body.ok).toBe(true);

    const list = await teamFetch(`/api/v1/teams/${id}/members`);
    const members = list.body as unknown as MembersBody;
    expect(members.project).toHaveLength(1);
    expect(members.project[0]!.name).toBe('proj-dev');
    // The global team stays empty — scope is respected.
    expect(members.global).toEqual([]);
  });

  it('rejects a duplicate hire without overwriting (409)', async () => {
    const id = await createSession();
    const hireBody = { name: 'dup', description: 'd', prompt: 'p' };
    expect((await teamFetch(`/api/v1/teams/${id}/members`, { method: 'POST', body: hireBody })).status).toBe(200);
    const dup = await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { ...hireBody, description: 'other' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.ok).toBe(false);
    expect(dup.body.error).toContain('cannot overwrite');
  });

  it('rejects a non-kebab-case hire name (400)', async () => {
    const id = await createSession();
    const bad = await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'Bad_Name', description: 'd', prompt: 'p' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toContain('kebab-case');
  });

  it('fires a member and removes it from the roster', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'old-hand', description: 'd', prompt: 'p' },
    });
    const fire = await teamFetch(`/api/v1/teams/${id}/members/old-hand`, { method: 'DELETE' });
    expect(fire.status).toBe(200);
    expect(fire.body.ok).toBe(true);

    const list = await teamFetch(`/api/v1/teams/${id}/members`);
    const members = list.body as unknown as MembersBody;
    expect(members.global).toEqual([]);
    expect(members.project).toEqual([]);
  });

  it('maps member status to the TUI four-state semantics (working/resting/on-duty/off-duty)', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'duty-cycle', description: 'd', prompt: 'p' },
    });
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const status = live!.accessor.get(IRuntimeStatusService);

    // Default (no live engine entry) → on-duty.
    let members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'duty-cycle')?.status).toBe('on-duty');

    // Working.
    await status.markWorking('duty-cycle', 'agent-1');
    members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'duty-cycle')?.status).toBe('working');

    // Resting with a live rest window → resting.
    await status.markResting('duty-cycle', 'agent-1', new Date(Date.now() + 60_000).toISOString());
    members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'duty-cycle')?.status).toBe('resting');

    // Resting with an expired rest window → off-duty (a reaped/parked member,
    // same as the TUI deriveMemberStatus).
    await status.markResting('duty-cycle', 'agent-1', new Date(Date.now() - 1_000).toISOString());
    members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'duty-cycle')?.status).toBe('off-duty');
  });

  it('lists a fired member with performance history as off-duty', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'archive-me', description: 'd', prompt: 'p' },
    });
    await teamFetch(`/api/v1/teams/${id}/members/archive-me/score`, {
      method: 'POST',
      body: { score: 88, note: 'worked' },
    });
    const fire = await teamFetch(`/api/v1/teams/${id}/members/archive-me`, { method: 'DELETE' });
    expect(fire.status).toBe(200);

    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    const archived = members.find((m) => m.name === 'archive-me');
    expect(archived).toBeDefined();
    expect(archived!.status).toBe('off-duty');
    expect(archived!.score).toEqual({ average: 88, count: 1 });
  });

  it('updates member fields while preserving the body', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'coder', description: 'Coder', prompt: 'Write code.', model: 'primary', tools: ['Read'] },
    });
    const updated = await teamFetch(`/api/v1/teams/${id}/members/coder`, {
      method: 'PUT',
      body: { model: 'secondary', tools: ['Read', 'Bash'], role: 'senior-coder' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.ok).toBe(true);
    expect(updated.body.member).toMatchObject({
      model: 'secondary',
      tools: ['Read', 'Bash'],
      role: 'senior-coder',
      description: 'Coder', // untouched
    });
  });

  it('patches prompt/title(role)/model and returns them on the next roster read', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'coder', description: 'Coder', prompt: 'Write code.', model: 'primary' },
    });

    // All three editable fields in one patch: prompt (body), role (Title), model.
    const updated = await teamFetch(`/api/v1/teams/${id}/members/coder`, {
      method: 'PUT',
      body: { prompt: 'Write tests and docs.', role: 'lead-coder', model: 'secondary' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.ok).toBe(true);
    expect(updated.body.member).toMatchObject({
      prompt: 'Write tests and docs.',
      role: 'lead-coder',
      model: 'secondary',
      description: 'Coder', // untouched
    });

    // The next GET reflects the patch immediately (roster reads the file).
    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    const coder = members.find((m) => m.name === 'coder');
    expect(coder?.prompt).toBe('Write tests and docs.');
    expect(coder?.role).toBe('lead-coder');
    expect(coder?.model).toBe('secondary');
    expect(coder?.description).toBe('Coder');
  });

  it('patches prompt/title/model for a project-scope member (route-side write path)', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'proj-dev', description: 'Project dev', prompt: 'Do project work.', scope: 'project' },
    });
    const updated = await teamFetch(`/api/v1/teams/${id}/members/proj-dev`, {
      method: 'PUT',
      body: { prompt: 'New project prompt.', role: 'lead', model: 'secondary' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.ok).toBe(true);
    expect(updated.body.member).toMatchObject({
      prompt: 'New project prompt.',
      role: 'lead',
      model: 'secondary',
    });

    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    const proj = members.find((m) => m.name === 'proj-dev');
    expect(proj?.prompt).toBe('New project prompt.');
    expect(proj?.role).toBe('lead');
    expect(proj?.model).toBe('secondary');
  });

  it('rejects an unknown patch field (40001) without writing it', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'coder', description: 'Coder', prompt: 'Write code.' },
    });
    // `name` is not a patchable field — the strict body schema rejects it.
    const bad = await teamFetch(`/api/v1/teams/${id}/members/coder`, {
      method: 'PUT',
      body: { name: 'renamed' },
    });
    expect(bad.status).toBe(200); // ALWAYS-200 envelope carries the business code
    expect((bad.body as { code?: number }).code).toBe(40001);
    expect(bad.body.ok).not.toBe(true);

    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'coder')).toBeDefined();
    expect(members.find((m) => m.name === 'renamed')).toBeUndefined();
  });

  it('rejects an empty prompt patch (40001)', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'coder', description: 'Coder', prompt: 'Write code.' },
    });
    const bad = await teamFetch(`/api/v1/teams/${id}/members/coder`, {
      method: 'PUT',
      body: { prompt: '' },
    });
    expect((bad.body as { code?: number }).code).toBe(40001);
    expect(bad.body.ok).not.toBe(true);

    // The original prompt survives.
    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'coder')?.prompt).toBe('Write code.');
  });

  it('records a score without a warning below the inflation sample', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'solo', description: 'd', prompt: 'p' },
    });
    const scored = await teamFetch(`/api/v1/teams/${id}/members/solo/score`, {
      method: 'POST',
      body: { score: 92, note: 'solid' },
    });
    expect(scored.status).toBe(200);
    expect(scored.body.ok).toBe(true);
    expect(scored.body.warning).toBeUndefined(); // n < 5 — ramp-up, no inflation
  });

  it('returns an inflation warning once five recent scores are all >= 90', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'inflated', description: 'd', prompt: 'p' },
    });
    for (let i = 0; i < 5; i++) {
      const scored = await teamFetch(`/api/v1/teams/${id}/members/inflated/score`, {
        method: 'POST',
        body: { score: 94 + (i % 2), note: `pass ${i}` },
      });
      expect(scored.status).toBe(200);
      expect(scored.body.ok).toBe(true);
      if (i < 4) {
        expect(scored.body.warning).toBeUndefined();
      } else {
        expect(scored.body.warning).toContain('Score inflation detected');
      }
    }
  });

  it('404s a message to a member agent that is not materialized', async () => {
    const id = await createSession();
    const missing = await teamFetch(`/api/v1/teams/${id}/agents/no-such-member/message`, {
      method: 'POST',
      body: { message: 'hello' },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error).toContain('not found');
  });

  it('injects a message into a materialized member agent', async () => {
    const id = await createSession();
    // Materialize the member agent so the route can resolve its handle.
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'active-member' });

    const sent = await teamFetch(`/api/v1/teams/${id}/agents/active-member/message`, {
      method: 'POST',
      body: { message: 'please continue' },
    });
    expect(sent.status).toBe(200);
    expect(sent.body.ok).toBe(true);
  });

  it('sets the session concurrency limit', async () => {
    const id = await createSession();
    const set = await teamFetch(`/api/v1/teams/${id}/concurrency`, {
      method: 'POST',
      body: { limit: 3 },
    });
    expect(set.status).toBe(200);
    expect(set.body.ok).toBe(true);

    const clear = await teamFetch(`/api/v1/teams/${id}/concurrency`, {
      method: 'POST',
      body: {},
    });
    expect(clear.status).toBe(200);
    expect(clear.body.ok).toBe(true);
  });

  it('returns aggregated subagent usage for a live session (byModel/byMember/runs)', async () => {
    const id = await createSession();
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const sub = await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-usage-1' });
    const usage = sub.accessor.get(IAgentUsageService);
    usage.record('provider/x', { inputOther: 100, output: 50, inputCacheRead: 20, inputCacheCreation: 10 });
    usage.record('__secondary__', { inputOther: 200, output: 40, inputCacheRead: 0, inputCacheCreation: 0 });

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/usage`);
    expect(status).toBe(200);
    expect(body['stale']).toBe(false);
    expect(body['runs']).toBe(1);
    // input = inputOther + inputCacheRead + inputCacheCreation; total = input + output.
    expect(body['byModel']).toEqual({
      'provider/x': { input: 130, output: 50, total: 180 },
      '__secondary__': { input: 200, output: 40, total: 240 },
    });
    // The unbound subagent buckets under `unknown`; the main agent is excluded.
    expect(body['byMember']).toEqual({
      unknown: {
        'provider/x': { input: 130, output: 50, total: 180 },
        '__secondary__': { input: 200, output: 40, total: 240 },
      },
    });
    // No main agent was materialized — the main bucket is present and empty.
    expect(body['main']).toEqual({
      byModel: {},
      total: { input: 0, output: 0, total: 0 },
    });
  });

  it('reports main-agent usage in a separate main bucket alongside unchanged subagent usage', async () => {
    const id = await createSession();
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const lifecycle = live!.accessor.get(IAgentLifecycleService);

    // Materialize the main agent and record usage on it.
    const main = await lifecycle.create({ agentId: 'main' });
    main.accessor.get(IAgentUsageService).record('provider/main-model', {
      inputOther: 1000,
      output: 200,
      inputCacheRead: 100,
      inputCacheCreation: 0,
    });

    // A subagent too, so the main/subagent split is observable.
    const sub = await lifecycle.create({ agentId: 'sub-main-split' });
    sub.accessor.get(IAgentUsageService).record('provider/sub-model', {
      inputOther: 10,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/usage`);
    expect(status).toBe(200);
    // Main bucket: the main agent's byModel plus the summed total.
    expect(body['main']).toEqual({
      byModel: { 'provider/main-model': { input: 1100, output: 200, total: 1300 } },
      total: { input: 1100, output: 200, total: 1300 },
    });
    // Subagent part stays unchanged and excludes the main agent's usage.
    expect(body['runs']).toBe(1);
    expect(body['byModel']).toEqual({
      'provider/sub-model': { input: 10, output: 5, total: 15 },
    });
    expect(body['byMember']).toEqual({
      unknown: { 'provider/sub-model': { input: 10, output: 5, total: 15 } },
    });
  });

  it('normalizes __secondary__ keys to the configured secondary model id', async () => {
    const id = await createSession();
    await server!.core.accessor
      .get(IConfigService)
      .set('secondaryModel', { model: 'provider/secondary' }, ConfigTarget.Memory);
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const sub = await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-usage-2' });
    sub.accessor.get(IAgentUsageService).record('__secondary__', {
      inputOther: 10,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    sub.accessor.get(IAgentUsageService).record('provider/x', {
      inputOther: 3,
      output: 2,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/usage`);
    expect(status).toBe(200);
    // The derived alias is renamed to the real secondary model id, both in
    // byModel and inside each byMember bucket; the plain model key stays.
    expect(body['byModel']).toEqual({
      'provider/secondary': { input: 10, output: 5, total: 15 },
      'provider/x': { input: 3, output: 2, total: 5 },
    });
    expect(body['byMember']).toEqual({
      unknown: {
        'provider/secondary': { input: 10, output: 5, total: 15 },
        'provider/x': { input: 3, output: 2, total: 5 },
      },
    });
  });

  it('returns stale:true with empty usage for a cold session instead of erroring', async () => {
    const id = await createSession();
    await closeSessionById(server!.core.accessor, id);

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/usage`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ byModel: {}, byMember: {}, runs: 0, stale: true });
    // The main bucket keeps a stable empty shape even on the cold path.
    expect(body['main']).toEqual({
      byModel: {},
      total: { input: 0, output: 0, total: 0 },
    });
  });

  it('404s usage for a session that never existed', async () => {
    const { status, body } = await teamFetch('/api/v1/teams/never-created/usage');
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it('carries per-member token usage on the members list', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'code-reviewer', description: 'd', prompt: 'p' },
    });
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const sub = await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-member-1' });
    sub.accessor.get(IAgentProfileService).update({ profileName: 'code-reviewer' });
    sub.accessor.get(IAgentUsageService).record('provider/x', {
      inputOther: 30,
      output: 20,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members`);
    expect(status).toBe(200);
    const members = body as unknown as MembersBody;
    const reviewer = members.global.find((m) => m.name === 'code-reviewer');
    expect(reviewer?.usage).toEqual({ input: 30, output: 20, total: 50 });
    // Members without live usage still expose the field (zeroed).
    expect(reviewer?.usage).toBeDefined();
  });

  it('surfaces the actual invoked model for a member with live usage, else the model_preference', async () => {
    const id = await createSession();
    // One member with a preference, one without.
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'with-pref', description: 'd', prompt: 'p', model: 'secondary' },
    });
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'no-pref', description: 'd', prompt: 'p' },
    });

    // `with-pref` actually ran on a concrete model — the roster must show the
    // real alias, not the `secondary` preference.
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const sub = await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-model-actual' });
    sub.accessor.get(IAgentProfileService).update({ profileName: 'with-pref' });
    sub.accessor.get(IAgentUsageService).record('provider/real-model', {
      inputOther: 50,
      output: 25,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    const withPref = members.find((m) => m.name === 'with-pref');
    const noPref = members.find((m) => m.name === 'no-pref');
    // Actual invoked model wins over the configured preference.
    expect(withPref?.model).toBe('provider/real-model');
    expect(withPref?.usage).toEqual({ input: 50, output: 25, total: 75 });
    // No usage and no preference → no model surfaced.
    expect(noPref?.model).toBeUndefined();
  });

  it('shows the historically invoked model when a member has dispatch history but no live usage', async () => {
    const id = await createSession();
    // Preference is `secondary`, but the member actually ran on a real model in
    // a *previous* session — the shift is recorded in perf, not in this
    // session's live usage bucket.
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'veteran', description: 'd', prompt: 'p', model: 'secondary' },
    });
    await server!.core.accessor.get(IAgentPerformanceService).recordShift('veteran', {
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T01:00:00.000Z',
      durationMs: 3_600_000,
      workSummary: 'reviewed a PR',
      model: 'provider/historic',
    });

    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    const veteran = members.find((m) => m.name === 'veteran');
    // Historical dispatch wins over the `secondary` preference placeholder.
    expect(veteran?.model).toBe('provider/historic');
  });

  it('prefers the live-session usage model over the historical model', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'cross-session', description: 'd', prompt: 'p', model: 'secondary' },
    });
    // Historical dispatch on one model...
    await server!.core.accessor.get(IAgentPerformanceService).recordShift('cross-session', {
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T01:00:00.000Z',
      durationMs: 3_600_000,
      workSummary: 'worked',
      model: 'provider/historic',
    });
    // ...and a current-session dispatch on another — live usage must dominate.
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const sub = await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-cross-session' });
    sub.accessor.get(IAgentProfileService).update({ profileName: 'cross-session' });
    sub.accessor.get(IAgentUsageService).record('provider/live', {
      inputOther: 10,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'cross-session')?.model).toBe('provider/live');
  });

  it('falls back to model_preference when a member has neither usage nor dispatch history', async () => {
    const id = await createSession();
    await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name: 'fresh-hire', description: 'd', prompt: 'p', model: 'secondary' },
    });

    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    // No usage bucket and no perf byModel → preference placeholder stays.
    expect(members.find((m) => m.name === 'fresh-hire')?.model).toBe('secondary');
  });
});

describe('server-v2 /api/v1/teams/{session_id}/members/{name}:polish', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  /** Model output the stub catalog yields; undefined → yield only `finish`. */
  let stubText: string | undefined;
  /** Error the stub catalog throws mid-request, when set. */
  let stubError: Error | undefined;
  /** Model ids the stub requester was asked to generate with. */
  const requestedModels: string[] = [];

  /** Stub `IModelCatalog` — the polish route only touches `getRequester`. */
  function makeStubCatalog(): IModelCatalog {
    return {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('catalog.get not exercised in polish tests');
      },
      getRequester: (id: string): ModelRequester => {
        requestedModels.push(id);
        const text = stubText;
        const error = stubError;
        return {
          model: undefined as never,
          request: async function* () {
            if (error !== undefined) throw error;
            if (text !== undefined) {
              yield { type: 'part', part: { type: 'text', text } };
            }
            yield { type: 'finish', message: { role: 'assistant', content: [], toolCalls: [] } };
          },
          uploadVideo: undefined,
        } as unknown as ModelRequester;
      },
      inspect: () => {
        throw new Error('catalog.inspect not exercised in polish tests');
      },
      ping: async () => {
        throw new Error('catalog.ping not exercised in polish tests');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('catalog.getProvider not exercised in polish tests');
      },
      setDefaultModel: async () => {
        throw new Error('catalog.setDefaultModel not exercised in polish tests');
      },
    };
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-teams-polish-'));
    stubText = undefined;
    stubError = undefined;
    requestedModels.length = 0;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [
        // Isolate the file roster from the developer's real ~/.kimi-code/agents.
        [
          IBootstrapOptions,
          resolveBootstrapOptions({
            clientIdentity: TEST_HOST_IDENTITY,
            homeDir: home,
            osHomeDir: home,
          }),
        ],
        [IModelCatalog, makeStubCatalog()],
      ],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(home, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    await mkdir(join(home as string, 'project'), { recursive: true });
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: join(home as string, 'project') } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function hireMember(id: string, name: string, extra: Record<string, unknown> = {}): Promise<void> {
    const res = await teamFetch(`/api/v1/teams/${id}/members`, {
      method: 'POST',
      body: { name, description: 'd', prompt: 'You review code.', ...extra },
    });
    expect(res.status).toBe(200);
  }

  async function teamFetch(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: OkBody }> {
    const headers: Record<string, string> = authHeaders(server as RunningServer);
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    } as never);
    return { status: res.status, body: (await res.json()) as OkBody };
  }

  /** All members across both scopes, for status/archive lookups. */
  function allMembers(body: unknown): MemberWire[] {
    const m = body as MembersBody;
    return [...m.global, ...m.project];
  }

  it('polishes a member prompt via the secondary model and returns { ok, polished } without writing the file', async () => {
    stubText = 'polished: You review code carefully, focusing on correctness.';
    const id = await createSession();
    await hireMember(id, 'polisher', { model: 'secondary' });
    await server!.core.accessor
      .get(IConfigService)
      .set('secondaryModel', { model: 'provider/secondary' }, ConfigTarget.Memory);

    // Empty body — generate from the member file prompt.
    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members/polisher:polish`, {
      method: 'POST',
      body: {},
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body['polished']).toBe('polished: You review code carefully, focusing on correctness.');
    // The `secondary` preference resolved to the configured real model.
    expect(requestedModels).toEqual(['provider/secondary']);

    // Generate-only: the member file is untouched.
    const members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'polisher')?.prompt).toBe('You review code.');
  });

  it('polishes an explicit { prompt } body override', async () => {
    stubText = 'polished override';
    const id = await createSession();
    await hireMember(id, 'overrider', { model: 'secondary' });
    await server!.core.accessor
      .get(IConfigService)
      .set('secondaryModel', { model: 'provider/secondary' }, ConfigTarget.Memory);

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members/overrider:polish`, {
      method: 'POST',
      body: { prompt: 'Draft prompt.' },
    });
    expect(status).toBe(200);
    expect(body['polished']).toBe('polished override');
    expect(requestedModels).toEqual(['provider/secondary']);
  });

  it('polishes with the actual invoked model when the member has live usage', async () => {
    stubText = 'polished with actual model';
    const id = await createSession();
    await hireMember(id, 'actual-runner', { model: 'secondary' });
    // The member actually ran on a concrete model — usage takes precedence over
    // the `secondary` preference when choosing the polish model.
    const live = getLiveSessionById(server!.core.accessor, id);
    expect(live).toBeDefined();
    const sub = await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'sub-polish-actual' });
    sub.accessor.get(IAgentProfileService).update({ profileName: 'actual-runner' });
    sub.accessor.get(IAgentUsageService).record('provider/real-model', {
      inputOther: 40,
      output: 10,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members/actual-runner:polish`, {
      method: 'POST',
    });
    expect(status).toBe(200);
    expect(body['polished']).toBe('polished with actual model');
    expect(requestedModels).toEqual(['provider/real-model']);
  });

  it('404s a polish for a missing member', async () => {
    const id = await createSession();
    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members/nope:polish`, {
      method: 'POST',
      body: {},
    });
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body['error']).toContain('not found');
  });

  it('400s an unsupported action suffix', async () => {
    const id = await createSession();
    await hireMember(id, 'polisher', { model: 'secondary' });
    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members/polisher:foobar`, {
      method: 'POST',
      body: {},
    });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('400s when no model can be resolved for a member without usage or preference', async () => {
    const id = await createSession();
    await hireMember(id, 'no-model');
    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members/no-model:polish`, {
      method: 'POST',
      body: {},
    });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('returns 500 when the model request fails', async () => {
    stubError = new Error('provider down');
    const id = await createSession();
    await hireMember(id, 'polisher', { model: 'secondary' });
    await server!.core.accessor
      .get(IConfigService)
      .set('secondaryModel', { model: 'provider/secondary' }, ConfigTarget.Memory);

    const { status, body } = await teamFetch(`/api/v1/teams/${id}/members/polisher:polish`, {
      method: 'POST',
      body: {},
    });
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body['error']).toContain('provider down');
  });
});
