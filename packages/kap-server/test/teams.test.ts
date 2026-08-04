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
  getLiveSessionById,
  IAgentLifecycleService,
  IBootstrapOptions,
  IRuntimeStatusService,
  resolveBootstrapOptions,
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
  tools: string[];
  skills?: string[];
  duty?: boolean;
  status: 'working' | 'resting' | 'on-duty' | 'off-duty';
  score: { average: number | null; count: number };
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

  it('maps member status to the TUI four-state semantics (working/resting/on-duty)', async () => {
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

    // Resting with an expired rest window → on-duty (TUI treats expired as on-duty).
    await status.markResting('duty-cycle', 'agent-1', new Date(Date.now() - 1_000).toISOString());
    members = allMembers((await teamFetch(`/api/v1/teams/${id}/members`)).body);
    expect(members.find((m) => m.name === 'duty-cycle')?.status).toBe('on-duty');
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
});
