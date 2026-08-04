/**
 * `/teams` REST routes — subagent team management for the Web panel.
 *
 * Server-v2 exposes the agent-core-v2 team primitives (agent profile files,
 * performance scores, runtime status, the concurrency pool) as a flat,
 * snake_case wire contract consumed by the Web TeamPanel:
 *
 *   GET    /teams/{session_id}/members                          data: { team_mode, global[], project[] }
 *   POST   /teams/{session_id}/members                          body: hire(+scope)  data: { ok, member }
 *   DELETE /teams/{session_id}/members/{name}                   data: { ok }
 *   PUT    /teams/{session_id}/members/{name}                   body: patch     data: { ok, member }
 *   POST   /teams/{session_id}/members/{name}/score             body: score     data: { ok, warning? }
 *   POST   /teams/{session_id}/agents/{agent_id}/message        body: message   data: { ok }
 *   POST   /teams/{session_id}/concurrency                      body: limit?    data: { ok }
 *
 * Members are split by team scope: `global` = the user-level team
 * (`~/.kimi-code/agents`), `project` = the session's project team
 * (`<session cwd>/.kimi-code/agents`; missing project root → empty list).
 * Profile files are read + parsed per file; `hire` takes an optional `scope`
 * (`global` default, `project` writes to the session project root); fire /
 * update match by name across scopes (project root first, then global —
 * first-come-first-served on cross-scope name collisions). Score comes from
 * `IAgentPerformanceService` and status from `IRuntimeStatusService`; team mode
 * is read from the `[subagent]` config section.
 *
 * **Responses** are intentionally flat (`{ ok, ... }`, 4xx with
 * `{ ok: false, error }`) rather than the envelope — the Web panel contract.
 * `AgentProfileFileError` codes map to HTTP statuses:
 *   invalid_name → 400 · already_exists → 409 · not_found → 404 · io → 500
 * A live session is required for every route (404 when missing).
 */

import {
  AgentProfileFileError,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPerformanceService,
  IAgentPromptService,
  IAgentProfileFileService,
  IBootstrapService,
  IConfigService,
  IHostFileSystem,
  IRuntimeStatusService,
  ISessionContext,
  ISubagentPoolService,
  parseAgentFileText,
  type AgentProfileCreateInput,
  type Scope,
  type RuntimeStatusEntry,
  type RuntimeStatusRaw,
} from '@moonshot-ai/agent-core-v2';
import {
  AGENT_NAME_PATTERN,
  renderFrontmatter,
} from '@moonshot-ai/agent-core-v2/workspace/agentProfileFile/agentProfileFileService';
import { parseFrontmatter } from '@moonshot-ai/agent-core-v2/_base/text/frontmatter';
import { detectScoreInflation } from '@moonshot-ai/agent-core-v2/agent/tools/team-score/teamScoreTool';
import { dump as dumpYaml } from 'js-yaml';
import { join } from 'node:path';
import { z } from 'zod';

import { defineRoute } from '../middleware/defineRoute';

// ---------------------------------------------------------------------------
// Params / body schemas
// ---------------------------------------------------------------------------

const sessionIdParamSchema = z.object({ session_id: z.string().min(1) });
const memberNameParamSchema = z.object({
  session_id: z.string().min(1),
  name: z.string().min(1),
});
const agentIdParamSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
});

const hireBodySchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  description: z.string().min(1),
  when_to_use: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  duty: z.boolean().optional(),
  prompt: z.string().min(1),
  /** Team scope: 'global' (user-level ~/.kimi-code/agents, default) or 'project' (session project root). */
  scope: z.enum(['global', 'project']).optional(),
});

const updateBodySchema = z.object({
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  role: z.string().optional(),
  description: z.string().optional(),
  when_to_use: z.string().optional(),
});

const scoreBodySchema = z.object({
  score: z.number().int().min(0).max(100),
  note: z.string().min(1),
  model: z.string().optional(),
});

const messageBodySchema = z.object({
  message: z.string().min(1),
  interrupt: z.boolean().optional(),
});

const concurrencyBodySchema = z.object({
  limit: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Flat response schemas (documented in OpenAPI, not envelope-wrapped)
// ---------------------------------------------------------------------------

const memberWireSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    role: { type: 'string' },
    description: { type: 'string' },
    when_to_use: { type: 'string' },
    model: { type: 'string' },
    tools: { type: 'array', items: { type: 'string' } },
    skills: { type: 'array', items: { type: 'string' } },
    duty: { type: 'boolean' },
    status: { type: 'string', enum: ['working', 'resting', 'on-duty', 'off-duty'] },
    score: {
      type: 'object',
      properties: {
        average: { type: ['number', 'null'] },
        count: { type: 'number' },
      },
    },
  },
} as const;

const membersResponseSchema = {
  type: 'object',
  properties: {
    team_mode: { type: 'boolean' },
    global: { type: 'array', items: memberWireSchema },
    project: { type: 'array', items: memberWireSchema },
  },
} as const;

const okResponseSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean', const: true } },
} as const;

const okMemberResponseSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean', const: true }, member: memberWireSchema },
} as const;

const okWarningResponseSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    warning: { type: 'string' },
  },
} as const;

const errorResponseSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean', const: false }, error: { type: 'string' } },
} as const;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface TeamMemberWire {
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

type FlatReply = { code(status: number): FlatReply; send(payload: unknown): unknown };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendError(reply: FlatReply, status: number, error: string): void {
  reply.code(status).send({ ok: false, error });
}

function sendProfileError(reply: FlatReply, err: unknown): void {
  if (err instanceof AgentProfileFileError) {
    const status =
      err.code === 'invalid_name' ? 400 : err.code === 'already_exists' ? 409 : err.code === 'not_found' ? 404 : 500;
    sendError(reply, status, err.message);
    return;
  }
  sendError(reply, 500, err instanceof Error ? err.message : String(err));
}

/**
 * Scope roots. `global` = the user-level team (`~/.kimi-code/agents` via the
 * server home + legacy os-home fallback); `project` = the session's project
 * root (`<session cwd>/.kimi-code/agents`, using the live session's cwd — not
 * the server process cwd). A missing project root simply yields an empty list.
 */
type MemberScope = 'global' | 'project';

function memberRoots(core: Scope, sessionCwd: string, scope: MemberScope): string[] {
  const bootstrap = core.accessor.get(IBootstrapService);
  return scope === 'global'
    ? [join(bootstrap.homeDir, 'agents'), join(bootstrap.osHomeDir, '.kimi-code', 'agents')]
    : [join(sessionCwd, '.kimi-code', 'agents')];
}

/** Read + parse the first existing `<name>.md` under `roots`. */
async function readMemberDef(
  hostFs: IHostFileSystem,
  roots: readonly string[],
  name: string,
): Promise<ReturnType<typeof parseAgentFileText> | undefined> {
  for (const root of roots) {
    const path = join(root, `${name}.md`);
    try {
      return parseAgentFileText({ path, source: 'user', text: await hostFs.readText(path) });
    } catch {
      // not present here or malformed — try the next root
    }
  }
  return undefined;
}

/**
 * TUI-compatible member lifecycle status — mirrors
 * `apps/kimi-code/src/tui/commands/team.ts` `deriveMemberStatus`:
 *   - working:  a live engine entry reports `working`
 *   - resting:  entry reports `resting` AND its rest window has not expired
 *   - on-duty:  profile exists with no live entry, or the rest window expired
 *               (employed, no live instance — spawns on demand)
 *   - off-duty: produced by the caller for perf-only archives (fired members)
 *
 * Unparseable `restExpiresAt` counts as expired (→ on-duty), same as the TUI.
 */
function memberStatus(entry: RuntimeStatusEntry | undefined, now: number = Date.now()): TeamMemberWire['status'] {
  if (entry?.state === 'working') return 'working';
  if (entry?.state === 'resting' && entry.restExpiresAt !== undefined) {
    const expiresAt = Date.parse(entry.restExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) return 'resting';
  }
  return 'on-duty';
}

async function buildMemberWire(
  hostFs: IHostFileSystem,
  perf: IAgentPerformanceService,
  statuses: RuntimeStatusRaw,
  roots: readonly string[],
  name: string,
): Promise<TeamMemberWire | undefined> {
  const def = await readMemberDef(hostFs, roots, name);
  if (def === undefined) return undefined;
  const summary = await perf.summary(def.name);
  const entry = statuses[def.name];
  const status = memberStatus(entry);
  return {
    name: def.name,
    role: def.role,
    description: def.description,
    when_to_use: def.whenToUse,
    model: def.modelPreference,
    tools: def.tools === undefined ? [] : [...def.tools],
    skills: def.skills === undefined ? undefined : [...def.skills],
    duty: def.duty,
    status,
    score: { average: summary.average ?? null, count: summary.count },
  };
}

/** Member names (basename without `.md`) present under `roots` (missing dir → []). */
async function listMemberNames(hostFs: IHostFileSystem, roots: readonly string[]): Promise<Set<string>> {
  const names = new Set<string>();
  for (const root of roots) {
    try {
      for (const entry of await hostFs.readdir(root)) {
        if (entry.isFile && /\.md$/.test(entry.name)) names.add(entry.name.slice(0, -3));
      }
    } catch {
      // directory inaccessible — skip
    }
  }
  return names;
}

async function listMembersInScope(
  hostFs: IHostFileSystem,
  perf: IAgentPerformanceService,
  statuses: RuntimeStatusRaw,
  roots: readonly string[],
): Promise<TeamMemberWire[]> {
  const members: TeamMemberWire[] = [];
  for (const name of await listMemberNames(hostFs, roots)) {
    const member = await buildMemberWire(hostFs, perf, statuses, roots, name);
    if (member !== undefined) members.push(member);
  }
  return members;
}

/** First existing `<name>.md` path across `roots`, in order. */
async function findMemberFile(
  hostFs: IHostFileSystem,
  roots: readonly string[],
  name: string,
): Promise<string | undefined> {
  for (const root of roots) {
    const path = join(root, `${name}.md`);
    try {
      await hostFs.stat(path);
      return path;
    } catch {
      // missing — try next
    }
  }
  return undefined;
}

function hireCreateInput(body: z.infer<typeof hireBodySchema>): AgentProfileCreateInput {
  return {
    name: body.name,
    role: body.role,
    description: body.description,
    whenToUse: body.when_to_use,
    modelPreference: body.model,
    tools: body.tools,
    skills: body.skills,
    duty: body.duty,
    prompt: body.prompt,
    scope: 'user',
  };
}

/**
 * Route-side project hire: `IAgentProfileFileService` resolves the project
 * root from the server bootstrap cwd, but the API's project scope is the live
 * session's cwd — so the Web write path renders the frontmatter itself (same
 * serializer the engine uses) and writes atomically via `IHostFileSystem`.
 */
async function hireProjectMember(
  hostFs: IHostFileSystem,
  sessionCwd: string,
  body: z.infer<typeof hireBodySchema>,
): Promise<string> {
  const name = body.name;
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new AgentProfileFileError(
      'invalid_name',
      `Invalid agent name "${name}": must be kebab-case (e.g. "code-reviewer") — lowercase letters, digits and hyphens only; no underscores or capitals`,
    );
  }
  const root = join(sessionCwd, '.kimi-code', 'agents');
  const path = join(root, `${name}.md`);
  try {
    await hostFs.mkdir(root, { recursive: true });
  } catch (error) {
    throw new AgentProfileFileError('io', `Failed to create directory ${root}: ${errorMessage(error)}`, root);
  }
  const content = renderFrontmatter(hireCreateInput(body)) + '\n\n' + body.prompt;
  let created: boolean;
  try {
    created = await hostFs.createExclusive(path, new TextEncoder().encode(content));
  } catch (error) {
    throw new AgentProfileFileError('io', `Failed to write ${path}: ${errorMessage(error)}`, path);
  }
  if (!created) {
    throw new AgentProfileFileError(
      'already_exists',
      `Agent "${name}" already exists at ${path} — cannot overwrite. Fire it first with TeamFire before re-hiring.`,
      path,
    );
  }
  return path;
}

/** Frontmatter key each patch field maps to (mirrors the engine's update). */
type MemberPatch = {
  modelPreference?: string;
  tools?: string[];
  skills?: string[];
  role?: string;
  description?: string;
  whenToUse?: string;
};

const PATCH_KEY_TO_FRONTMATTER: Record<keyof MemberPatch, string> = {
  modelPreference: 'model_preference',
  tools: 'tools',
  skills: 'skills',
  role: 'role',
  description: 'description',
  whenToUse: 'whenToUse',
};

/**
 * Route-side project-member update: read → patch frontmatter → re-serialize
 * (js-yaml dump) → write back, preserving the body and unknown fields. Only
 * used when the member file lives under the session project root — global
 * members update through `IAgentProfileFileService`.
 */
async function updateMemberFile(
  hostFs: IHostFileSystem,
  path: string,
  name: string,
  patch: MemberPatch,
): Promise<void> {
  let text: string;
  try {
    text = await hostFs.readText(path);
  } catch {
    throw new AgentProfileFileError('not_found', `Agent profile "${name}" not found at ${path}`, path);
  }
  const parsed = parseFrontmatter(text);
  if (parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new AgentProfileFileError('io', `Agent profile "${name}" has no frontmatter to update at ${path}`, path);
  }
  const data = parsed.data as Record<string, unknown>;
  for (const key of Object.keys(patch) as Array<keyof MemberPatch>) {
    const value = patch[key];
    const frontmatterKey = PATCH_KEY_TO_FRONTMATTER[key];
    if (value === undefined) {
      delete data[frontmatterKey];
    } else {
      data[frontmatterKey] = value;
    }
  }
  const body = parsed.body.replace(/^\n+/, '');
  const content = `---\n${dumpYaml(data)}\n---\n\n${body}`;
  try {
    await hostFs.writeText(path, content);
  } catch (error) {
    throw new AgentProfileFileError('io', `Failed to write ${path}: ${errorMessage(error)}`, path);
  }
}

function teamMode(core: Scope): boolean {
  return core.accessor.get(IConfigService).get<{ teamMode?: boolean }>('subagent')?.teamMode ?? false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Route host
// ---------------------------------------------------------------------------

interface TeamsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: unknown, reply: FlatReply) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: unknown, reply: FlatReply) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: unknown, reply: FlatReply) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: unknown, reply: FlatReply) => Promise<void> | void,
  ): unknown;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamsRoutes(app: TeamsRouteHost, core: Scope): void {
  // GET /teams/{session_id}/members -------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/teams/{session_id}/members',
      params: sessionIdParamSchema,
      rawResponse: { 200: membersResponseSchema, 404: errorResponseSchema },
      description: 'List subagent team members with score and status',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id } = req.params as { session_id: string };
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      const sessionCwd = session.accessor.get(ISessionContext).cwd;
      const hostFs = core.accessor.get(IHostFileSystem);
      const perf = core.accessor.get(IAgentPerformanceService);
      const statuses = await core.accessor.get(IRuntimeStatusService).list();
      const globalRoots = memberRoots(core, sessionCwd, 'global');
      const projectRoots = memberRoots(core, sessionCwd, 'project');
      const global = await listMembersInScope(hostFs, perf, statuses, globalRoots);
      const project = await listMembersInScope(hostFs, perf, statuses, projectRoots);
      // Archived (fired) members: performance history but no profile file →
      // listed as `off-duty` in the global team, same as the TUI's dimmed
      // archive rows. Perf history is per-profile and scope-independent.
      const globalNames = await listMemberNames(hostFs, globalRoots);
      const projectNames = await listMemberNames(hostFs, projectRoots);
      const listed = new Set([...globalNames, ...projectNames]);
      for (const entry of await perf.list()) {
        if (listed.has(entry.profileName)) continue;
        // A profile with neither score entries nor shifts carries no history —
        // not a member (TUI parity).
        if (entry.summary.count === 0 && entry.summary.avgDurationMs === undefined) continue;
        global.push({
          name: entry.profileName,
          description: '',
          tools: [],
          status: 'off-duty',
          score: { average: entry.summary.average ?? null, count: entry.summary.count },
        });
      }
      reply.send({ team_mode: teamMode(core), global, project });
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as never);

  // POST /teams/{session_id}/members -------------------------------
  const hireRoute = defineRoute(
    {
      method: 'POST',
      path: '/teams/{session_id}/members',
      params: sessionIdParamSchema,
      body: hireBodySchema,
      rawResponse: { 200: okMemberResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema, 500: errorResponseSchema },
      description: 'Hire a new team member profile',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id } = req.params as { session_id: string };
      const body = req.body as z.infer<typeof hireBodySchema>;
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      const scope = body.scope ?? 'global';
      const hostFs = core.accessor.get(IHostFileSystem);
      const sessionCwd = session.accessor.get(ISessionContext).cwd;
      try {
        if (scope === 'project') {
          await hireProjectMember(hostFs, sessionCwd, body);
        } else {
          await session.accessor.get(IAgentProfileFileService).create(hireCreateInput(body));
        }
        const roots = memberRoots(core, sessionCwd, scope);
        const member = await buildMemberWire(
          hostFs,
          core.accessor.get(IAgentPerformanceService),
          await core.accessor.get(IRuntimeStatusService).list(),
          roots,
          body.name,
        );
        reply.send({ ok: true, member });
      } catch (err) {
        sendProfileError(reply as unknown as FlatReply, err);
      }
    },
  );
  app.post(hireRoute.path, hireRoute.options, hireRoute.handler as never);

  // DELETE /teams/{session_id}/members/{name} ----------------------
  const fireRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/teams/{session_id}/members/{name}',
      params: memberNameParamSchema,
      rawResponse: { 200: okResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      description: 'Fire a team member profile',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id, name } = req.params as { session_id: string; name: string };
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      const sessionCwd = session.accessor.get(ISessionContext).cwd;
      const hostFs = core.accessor.get(IHostFileSystem);
      try {
        // Match by name across scopes (project root first, then global —
        // first-come-first-served on cross-scope name collisions).
        const roots = [...memberRoots(core, sessionCwd, 'project'), ...memberRoots(core, sessionCwd, 'global')];
        const path = await findMemberFile(hostFs, roots, name);
        if (path !== undefined) {
          await hostFs.remove(path);
        }
        reply.send({ ok: true });
      } catch (err) {
        sendProfileError(reply as unknown as FlatReply, err);
      }
    },
  );
  app.delete(fireRoute.path, fireRoute.options, fireRoute.handler as never);

  // PUT /teams/{session_id}/members/{name} --------------------------
  const updateRoute = defineRoute(
    {
      method: 'PUT',
      path: '/teams/{session_id}/members/{name}',
      params: memberNameParamSchema,
      body: updateBodySchema,
      rawResponse: { 200: okMemberResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      description: 'Update a team member profile fields',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id, name } = req.params as { session_id: string; name: string };
      const body = req.body as z.infer<typeof updateBodySchema>;
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      // Only the fields actually present in the body are patched — omitted
      // fields stay untouched.
      const patch: MemberPatch = {};
      if (body.model !== undefined) patch.modelPreference = body.model;
      if (body.tools !== undefined) patch.tools = body.tools;
      if (body.skills !== undefined) patch.skills = body.skills;
      if (body.role !== undefined) patch.role = body.role;
      if (body.description !== undefined) patch.description = body.description;
      if (body.when_to_use !== undefined) patch.whenToUse = body.when_to_use;
      const sessionCwd = session.accessor.get(ISessionContext).cwd;
      const hostFs = core.accessor.get(IHostFileSystem);
      try {
        // Match by name across scopes (project root first, then global).
        const projectRoots = memberRoots(core, sessionCwd, 'project');
        const globalRoots = memberRoots(core, sessionCwd, 'global');
        const path = await findMemberFile(hostFs, [...projectRoots, ...globalRoots], name);
        if (path === undefined) {
          throw new AgentProfileFileError('not_found', `Agent profile "${name}" not found`);
        }
        if (projectRoots.some((root) => path.startsWith(root))) {
          await updateMemberFile(hostFs, path, name, patch);
        } else {
          await session.accessor.get(IAgentProfileFileService).update(name, 'user', patch);
        }
        const member = await buildMemberWire(
          hostFs,
          core.accessor.get(IAgentPerformanceService),
          await core.accessor.get(IRuntimeStatusService).list(),
          [...globalRoots, ...projectRoots],
          name,
        );
        reply.send({ ok: true, member });
      } catch (err) {
        sendProfileError(reply as unknown as FlatReply, err);
      }
    },
  );
  app.put(updateRoute.path, updateRoute.options, updateRoute.handler as never);

  // POST /teams/{session_id}/members/{name}/score -------------------
  const scoreRoute = defineRoute(
    {
      method: 'POST',
      path: '/teams/{session_id}/members/{name}/score',
      params: memberNameParamSchema,
      body: scoreBodySchema,
      rawResponse: { 200: okWarningResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      description: 'Record a TeamScore for a member, with an optional inflation warning',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id, name } = req.params as { session_id: string; name: string };
      const body = req.body as z.infer<typeof scoreBodySchema>;
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      const perf = core.accessor.get(IAgentPerformanceService);
      try {
        await perf.record({
          profileName: name,
          ts: new Date().toISOString(),
          score: body.score,
          note: body.note,
          model: body.model,
        });
        const recent = await perf.recentScores(name, 10);
        const warning = detectScoreInflation(name, recent);
        reply.send({ ok: true, ...(warning === undefined ? {} : { warning }) });
      } catch (err) {
        sendProfileError(reply as unknown as FlatReply, err);
      }
    },
  );
  app.post(scoreRoute.path, scoreRoute.options, scoreRoute.handler as never);

  // POST /teams/{session_id}/agents/{agent_id}/message --------------
  const messageRoute = defineRoute(
    {
      method: 'POST',
      path: '/teams/{session_id}/agents/{agent_id}/message',
      params: agentIdParamSchema,
      body: messageBodySchema,
      rawResponse: { 200: okResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      description: 'Inject a message into a member agent (optionally interrupting its turn)',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id, agent_id } = req.params as { session_id: string; agent_id: string };
      const body = req.body as z.infer<typeof messageBodySchema>;
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      const agent = session.accessor.get(IAgentLifecycleService).get(agent_id);
      if (agent === undefined) {
        sendError(reply as unknown as FlatReply, 404, `agent ${agent_id} not found in session ${session_id}`);
        return;
      }
      try {
        if (body.interrupt === true) {
          const loop = agent.accessor.get(IAgentLoopService);
          const activeTurnId = loop.status().activeTurnId;
          if (activeTurnId !== undefined) loop.cancel(activeTurnId);
        } else {
          await agent.accessor.get(IAgentPromptService).inject({
            role: 'user',
            content: [{ type: 'text', text: body.message }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'team_message' },
          });
        }
        reply.send({ ok: true });
      } catch (err) {
        sendError(reply as unknown as FlatReply, 500, err instanceof Error ? err.message : String(err));
      }
    },
  );
  app.post(messageRoute.path, messageRoute.options, messageRoute.handler as never);

  // POST /teams/{session_id}/concurrency ----------------------------
  const concurrencyRoute = defineRoute(
    {
      method: 'POST',
      path: '/teams/{session_id}/concurrency',
      params: sessionIdParamSchema,
      body: concurrencyBodySchema,
      rawResponse: { 200: okResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      description: 'Set the session-wide subagent concurrency limit',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id } = req.params as { session_id: string };
      const body = req.body as z.infer<typeof concurrencyBodySchema>;
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      session.accessor.get(ISubagentPoolService).setRuntimeLimit(body.limit);
      reply.send({ ok: true });
    },
  );
  app.post(concurrencyRoute.path, concurrencyRoute.options, concurrencyRoute.handler as never);
}
