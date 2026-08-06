/**
 * `/teams` REST routes — subagent team management for the Web panel.
 *
 * Server-v2 exposes the agent-core-v2 team primitives (agent profile files,
 * performance scores, runtime status, the concurrency pool) as a flat,
 * snake_case wire contract consumed by the Web TeamPanel:
 *
 *   GET    /teams/{session_id}/members                          data: { team_mode, global[], project[] }
 *   GET    /teams/{session_id}/usage                            data: { byModel, byMember, runs, stale, main }
 *   POST   /teams/{session_id}/members                          body: hire(+scope)  data: { ok, member }
 *   DELETE /teams/{session_id}/members/{name}                   data: { ok }
 *   PUT    /teams/{session_id}/members/{name}                   body: patch     data: { ok, member }
 *   POST   /teams/{session_id}/members/{name}/score             body: score     data: { ok, warning? }
 *   POST   /teams/{session_id}/members/{name}:polish            body: (empty|{prompt?})  data: { ok, polished }
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
  addUsage,
  emptyUsage,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPerformanceService,
  IAgentProfileFileService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentUsageService,
  IBootstrapService,
  IConfigService,
  IHostFileSystem,
  IModelCatalog,
  IRuntimeStatusService,
  ISessionContext,
  ISessionIndex,
  ISubagentPoolService,
  MAIN_AGENT_ID,
  parseAgentFileText,
  SECONDARY_DERIVED_MODEL_ID,
  SECONDARY_MODEL_SECTION,
  type AgentProfileCreateInput,
  type Scope,
  type RuntimeStatusEntry,
  type RuntimeStatusRaw,
  type TokenUsage,
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
import { parseActionSuffix } from './action-suffix';

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

/** `{name}:polish` tail (Fastify cannot disambiguate the `:action` suffix). */
const memberPolishParamSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
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

const updateBodySchema = z
  .object({
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    role: z.string().optional(),
    description: z.string().optional(),
    when_to_use: z.string().optional(),
    /** Replaces the profile's prompt body (the Markdown after the frontmatter). */
    prompt: z.string().min(1).optional(),
  })
  .strict();

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

/** Polish body is optional — empty generates from the member file, `{prompt?}` overrides it. */
const polishBodySchema = z
  .object({
    prompt: z.string().min(1).optional(),
  })
  .optional();

// ---------------------------------------------------------------------------
// Flat response schemas (documented in OpenAPI, not envelope-wrapped)
// ---------------------------------------------------------------------------

const tokenUsageWireSchema = {
  type: 'object',
  properties: {
    input: { type: 'number' },
    output: { type: 'number' },
    total: { type: 'number' },
  },
} as const;

const memberWireSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    role: { type: 'string' },
    description: { type: 'string' },
    when_to_use: { type: 'string' },
    model: { type: 'string' },
    prompt: { type: 'string' },
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
    usage: tokenUsageWireSchema,
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

const mainUsageWireSchema = {
  type: 'object',
  properties: {
    byModel: { type: 'object', additionalProperties: tokenUsageWireSchema },
    total: tokenUsageWireSchema,
  },
} as const;

const usageResponseSchema = {
  type: 'object',
  properties: {
    byModel: { type: 'object', additionalProperties: tokenUsageWireSchema },
    byMember: {
      type: 'object',
      additionalProperties: { type: 'object', additionalProperties: tokenUsageWireSchema },
    },
    runs: { type: 'number' },
    stale: { type: 'boolean' },
    /** Main-agent (主管) usage, TUI Session-usage parity — separate from the
     *  subagent buckets. */
    main: mainUsageWireSchema,
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

const okPolishedResponseSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    polished: { type: 'string' },
  },
} as const;

const errorResponseSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean', const: false }, error: { type: 'string' } },
} as const;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface TokenUsageWire {
  input: number;
  output: number;
  total: number;
}

interface TeamMemberWire {
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
  usage: TokenUsageWire;
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
 *   - on-duty:  profile exists with no status entry
 *               (employed, no live instance — spawns on demand)
 *   - off-duty: profile exists but the resting window expired (the parked
 *               instance was reaped — a terminal record); or perf-only
 *               archives (fired members)
 *
 * An unparseable `restExpiresAt` counts as expired (→ off-duty), same as TUI.
 */
function memberStatus(entry: RuntimeStatusEntry | undefined, now: number = Date.now()): TeamMemberWire['status'] {
  if (entry?.state === 'working') return 'working';
  if (entry?.state === 'resting' && entry.restExpiresAt !== undefined) {
    const expiresAt = Date.parse(entry.restExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) return 'resting';
    return 'off-duty';
  }
  return 'on-duty';
}

/**
 * Per-member usage shape for the roster: the aggregated total (the `usage`
 * field) plus the per-model breakdown used to surface the member's actual
 * invoked model alias.
 */
interface MemberUsageWire {
  /** 该成员按模型合计（members 列表 usage 字段，输入/输出/总）。 */
  total: TokenUsageWire;
  /** 该成员按模型明细（modelAlias → wire），用于显示实际调用模型。 */
  byModel: Record<string, TokenUsageWire>;
}

async function buildMemberWire(
  hostFs: IHostFileSystem,
  perf: IAgentPerformanceService,
  statuses: RuntimeStatusRaw,
  roots: readonly string[],
  name: string,
  usage?: MemberUsageWire,
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
    // 实际调用模型三级回退：① 当前会话 usage 桶内用量最大的真实 modelAlias；
    // ② 历史派工记录（perf entries/shifts 聚合出的 byModel，count 最大的
    // model）；③ 配置偏好。usage 只聚合当前 live session 的 lifecycle agent，
    // 历史会话派的工落在 perf byModel 里——有派工历史的成员显示真实模型，
    // 从未派工（也无当前会话调用）的才回退 preference。
    model: dominantModel(usage?.byModel) ?? dominantModelByCount(summary.byModel) ?? def.modelPreference,
    prompt: def.prompt,
    tools: def.tools === undefined ? [] : [...def.tools],
    skills: def.skills === undefined ? undefined : [...def.skills],
    duty: def.duty,
    status,
    score: { average: summary.average ?? null, count: summary.count },
    usage: usage?.total ?? { input: 0, output: 0, total: 0 },
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
  usageByMember?: Record<string, MemberUsageWire>,
): Promise<TeamMemberWire[]> {
  const members: TeamMemberWire[] = [];
  for (const name of await listMemberNames(hostFs, roots)) {
    const member = await buildMemberWire(hostFs, perf, statuses, roots, name, usageByMember?.[name]);
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

/** Frontmatter key each patch field maps to (mirrors the engine's update); `prompt` is the body. */
type MemberPatch = {
  modelPreference?: string;
  tools?: string[];
  skills?: string[];
  role?: string;
  description?: string;
  whenToUse?: string;
  prompt?: string;
};

const PATCH_KEY_TO_FRONTMATTER: Record<Exclude<keyof MemberPatch, 'prompt'>, string> = {
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
  const { prompt, ...frontmatterPatch } = patch;
  for (
    const key of Object.keys(frontmatterPatch) as Array<
      Exclude<keyof MemberPatch, 'prompt'>
    >
  ) {
    const value = frontmatterPatch[key];
    const frontmatterKey = PATCH_KEY_TO_FRONTMATTER[key];
    if (value === undefined) {
      delete data[frontmatterKey];
    } else {
      data[frontmatterKey] = value;
    }
  }
  const body = prompt !== undefined ? prompt : parsed.body.replace(/^\n+/, '');
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

// ---------------------------------------------------------------------------
// Subagent token-usage aggregation (live session) — mirrors the TUI's
// SubAgentUsage accumulator: one bucket per model (`byModel`), one per profile
// name (`byMember`), and a `runs` count of subagents that consumed tokens.
// The main agent is excluded; unbound agents bucket under `unknown`.
// ---------------------------------------------------------------------------

interface SubagentUsageAggregate {
  byModel: Record<string, TokenUsage>;
  byMember: Record<string, Record<string, TokenUsage>>;
  runs: number;
}

function toTokenUsageWire(usage: TokenUsage): TokenUsageWire {
  const input = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  const output = usage.output;
  return { input, output, total: input + output };
}

function accumulateUsage(
  target: Record<string, TokenUsage>,
  key: string,
  usage: TokenUsage,
): void {
  const prev = target[key];
  target[key] = prev === undefined ? usage : addUsage(prev, usage);
}

function collectSubagentUsage(lifecycle: IAgentLifecycleService): SubagentUsageAggregate {
  const byModel: Record<string, TokenUsage> = {};
  const byMember: Record<string, Record<string, TokenUsage>> = {};
  let runs = 0;
  for (const agent of lifecycle.list()) {
    if (agent.id === MAIN_AGENT_ID) continue;
    const byModelForAgent = agent.accessor.get(IAgentUsageService).status().byModel;
    if (byModelForAgent === undefined || Object.keys(byModelForAgent).length === 0) continue;
    const memberName = agent.accessor.get(IAgentProfileService).data().profileName ?? 'unknown';
    let memberBucket = byMember[memberName];
    if (memberBucket === undefined) {
      memberBucket = {};
      byMember[memberName] = memberBucket;
    }
    for (const [model, usage] of Object.entries(byModelForAgent)) {
      accumulateUsage(byModel, model, usage);
      accumulateUsage(memberBucket, model, usage);
    }
    runs += 1;
  }
  return { byModel, byMember, runs };
}

/**
 * Main-agent (主管) token usage — the main agent's own `IAgentUsageService`
 * `byModel`, exposed separately so the Web panel can render a Session usage
 * section alongside the subagent breakdown (TUI `/usage` parity). A live
 * session whose main agent has not been materialized yet (no turn started)
 * yields an empty bucket — the read never materializes the agent (that is the
 * dispatcher's job on agent-targeted requests).
 */
function collectMainUsage(lifecycle: IAgentLifecycleService): Record<string, TokenUsage> {
  const main = lifecycle.get(MAIN_AGENT_ID);
  if (main === undefined) return {};
  return main.accessor.get(IAgentUsageService).status().byModel ?? {};
}

/** Sum wire usage rows (`input`/`output`/`total`) across a bucket. */
function sumTokenUsageWire(rows: Iterable<TokenUsageWire>): TokenUsageWire {
  let input = 0;
  let output = 0;
  for (const row of rows) {
    input += row.input;
    output += row.output;
  }
  return { input, output, total: input + output };
}

/** The real model id the derived `__secondary__` entry points at, when set. */
function resolveSecondaryModelId(core: Scope): string | undefined {
  return core.accessor.get(IConfigService).get<{ model?: string }>(SECONDARY_MODEL_SECTION)?.model;
}

/** Rename `__secondary__` → the real secondary model id, merging on collision. */
function normalizeDerivedSecondary(
  aggregate: SubagentUsageAggregate,
  secondaryId: string | undefined,
): SubagentUsageAggregate {
  if (secondaryId === undefined || secondaryId === SECONDARY_DERIVED_MODEL_ID) return aggregate;
  const rename = (source: Record<string, TokenUsage>): Record<string, TokenUsage> => {
    const out: Record<string, TokenUsage> = {};
    for (const [key, usage] of Object.entries(source)) {
      accumulateUsage(out, key === SECONDARY_DERIVED_MODEL_ID ? secondaryId : key, usage);
    }
    return out;
  };
  const byMember: Record<string, Record<string, TokenUsage>> = {};
  for (const [memberName, bucket] of Object.entries(aggregate.byMember)) {
    byMember[memberName] = rename(bucket);
  }
  return { byModel: rename(aggregate.byModel), byMember, runs: aggregate.runs };
}

/** The model alias with the largest usage total in a bucket, if any. */
function dominantModel(byModel: Record<string, TokenUsageWire> | undefined): string | undefined {
  if (byModel === undefined) return undefined;
  let best: string | undefined;
  let bestTotal = -1;
  for (const [model, row] of Object.entries(byModel)) {
    if (row.total > bestTotal) {
      best = model;
      bestTotal = row.total;
    }
  }
  return best;
}

/**
 * The model with the most recorded work in a perf `byModel` bucket (score
 * entries + shifts per model — the aggregate `IAgentPerformanceService` exposes
 * via `summary()`/`list()`). Serves as the historical-dispatch fallback for the
 * members roster: a member whose shifts/scores were recorded in a *previous*
 * session has no live usage bucket, but its actual invoked model is preserved
 * here. Ties resolve to the first-seen model (insertion order), matching how
 * `dominantModel` resolves usage-total ties.
 */
function dominantModelByCount(
  byModel: Record<string, { count: number; average?: number }> | undefined,
): string | undefined {
  if (byModel === undefined) return undefined;
  let best: string | undefined;
  let bestCount = -1;
  for (const [model, data] of Object.entries(byModel)) {
    if (data.count > bestCount) {
      best = model;
      bestCount = data.count;
    }
  }
  return best;
}

/**
 * Per-profile usage for the members list: the aggregated total (the `usage`
 * field) plus the per-model breakdown, so the roster can surface the actual
 * invoked model alias alongside the configured preference.
 */
function memberUsageWire(aggregate: SubagentUsageAggregate): Record<string, MemberUsageWire> {
  const out: Record<string, MemberUsageWire> = {};
  for (const [memberName, bucket] of Object.entries(aggregate.byMember)) {
    const byModel: Record<string, TokenUsageWire> = {};
    for (const [model, usage] of Object.entries(bucket)) {
      byModel[model] = toTokenUsageWire(usage);
    }
    const total = Object.values(bucket).reduce((acc, usage) => addUsage(acc, usage), emptyUsage());
    out[memberName] = { total: toTokenUsageWire(total), byModel };
  }
  return out;
}

/**
 * Model to use for a member prompt-polish generation: the member's actual
 * invoked model (largest-usage alias in the live usage bucket) when it has
 * called a model, else its `model_preference` resolved to a concrete id
 * (`secondary` recipe → the configured `[secondary_model].model`; `primary` →
 * the main agent's model). `undefined` when neither can be resolved — the
 * caller rejects the request.
 */
function resolvePolishModel(
  core: Scope,
  lifecycle: IAgentLifecycleService,
  preference: string | undefined,
  usageByModel: Record<string, TokenUsageWire> | undefined,
): string | undefined {
  const actual = dominantModel(usageByModel);
  if (actual !== undefined) return actual;
  if (preference === 'secondary') return resolveSecondaryModelId(core);
  if (preference === 'primary') {
    return lifecycle.get(MAIN_AGENT_ID)?.accessor.get(IAgentProfileService).data().modelAlias;
  }
  return preference;
}

/**
 * One-shot LLM generation of a polished member prompt. Calls the model catalog
 * requester directly with an empty tool set and a single user message — the
 * same channel `subagentWarmService.warm` (agent-core-v2
 * `src/session/subagent/subagentWarmService.ts:192`) and the catalog `ping`
 * (`src/kosong/model/catalogService.ts:200`) use for detached generation.
 * Because the request never enters an agent loop, nothing is recorded: no
 * `IAgentUsageService.record`, no wire/transcript ops, no context mutation.
 */
async function polishMemberPrompt(modelCatalog: IModelCatalog, model: string, prompt: string): Promise<string> {
  const systemPrompt =
    'You are a prompt-engineering assistant. Rewrite the given subagent system prompt to be clearer, ' +
    'more specific, and better structured while preserving its intent, tools, and constraints. ' +
    'Return only the rewritten prompt text, with no commentary or markdown fences.';
  let text = '';
  for await (const event of modelCatalog.getRequester(model).request(
    {
      systemPrompt,
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], toolCalls: [] }],
    },
    undefined,
    { maxCompletionTokens: 2048, thinkingEffort: 'off' },
  )) {
    if (event.type === 'part' && event.part.type === 'text') {
      text += event.part.text;
    } else if (event.type === 'finish') {
      break;
    }
  }
  const polished = text.trim();
  if (polished.length === 0) throw new Error('model returned an empty polish');
  return polished;
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
      // Normalize the derived `__secondary__` alias so the surfaced actual
      // model ids are real aliases (same projection the usage route uses).
      const aggregate = normalizeDerivedSecondary(
        collectSubagentUsage(session.accessor.get(IAgentLifecycleService)),
        resolveSecondaryModelId(core),
      );
      const usageByMember = memberUsageWire(aggregate);
      const globalRoots = memberRoots(core, sessionCwd, 'global');
      const projectRoots = memberRoots(core, sessionCwd, 'project');
      const global = await listMembersInScope(hostFs, perf, statuses, globalRoots, usageByMember);
      const project = await listMembersInScope(hostFs, perf, statuses, projectRoots, usageByMember);
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
          usage: usageByMember[entry.profileName]?.total ?? { input: 0, output: 0, total: 0 },
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
      if (body.prompt !== undefined) patch.prompt = body.prompt;
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

  // GET /teams/{session_id}/usage --------------------------------
  const usageRoute = defineRoute(
    {
      method: 'GET',
      path: '/teams/{session_id}/usage',
      params: sessionIdParamSchema,
      rawResponse: { 200: usageResponseSchema, 404: errorResponseSchema },
      description: 'Subagent token usage aggregated by model and member plus main-agent usage; stale:true when the session is not live',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id } = req.params as { session_id: string };
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        // A persisted-but-cold session reports stale (empty) instead of erroring.
        const exists = (await core.accessor.get(ISessionIndex).get(session_id)) !== undefined;
        if (!exists) {
          sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
          return;
        }
        reply.send({
          byModel: {},
          byMember: {},
          runs: 0,
          stale: true,
          main: { byModel: {}, total: { input: 0, output: 0, total: 0 } },
        });
        return;
      }
      const aggregate = normalizeDerivedSecondary(
        collectSubagentUsage(session.accessor.get(IAgentLifecycleService)),
        resolveSecondaryModelId(core),
      );
      const byModel: Record<string, TokenUsageWire> = {};
      for (const [model, usage] of Object.entries(aggregate.byModel)) {
        byModel[model] = toTokenUsageWire(usage);
      }
      const byMember: Record<string, Record<string, TokenUsageWire>> = {};
      for (const [memberName, bucket] of Object.entries(aggregate.byMember)) {
        const memberModels: Record<string, TokenUsageWire> = {};
        for (const [model, usage] of Object.entries(bucket)) {
          memberModels[model] = toTokenUsageWire(usage);
        }
        byMember[memberName] = memberModels;
      }
      const mainByModel: Record<string, TokenUsageWire> = {};
      for (const [model, usage] of Object.entries(
        collectMainUsage(session.accessor.get(IAgentLifecycleService)),
      )) {
        mainByModel[model] = toTokenUsageWire(usage);
      }
      reply.send({
        byModel,
        byMember,
        runs: aggregate.runs,
        stale: false,
        main: { byModel: mainByModel, total: sumTokenUsageWire(Object.values(mainByModel)) },
      });
    },
  );
  app.get(usageRoute.path, usageRoute.options, usageRoute.handler as never);

  // POST /teams/{session_id}/members/{name}:polish ------------------
  // One-shot LLM generation of a polished member prompt. Registers on the
  // `{tail}` catch-all (Fastify cannot disambiguate `:name` from
  // `:name:polish`); the OpenAPI transform projects it to the documented
  // `/teams/{session_id}/members/{name}:polish`. Never writes the member
  // file — the Web panel confirms before the existing PUT persists.
  const polishRoute = defineRoute(
    {
      method: 'POST',
      path: '/teams/{session_id}/members/{tail}',
      params: memberPolishParamSchema,
      body: polishBodySchema,
      rawResponse: { 200: okPolishedResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      description: 'Generate a polished rewrite of a member prompt without writing it back',
      tags: ['teams'],
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as { session_id: string; tail: string };
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['polish'] as const,
        resourceLabel: 'member',
      });
      if (parsed.kind !== 'action') {
        const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
        sendError(reply as unknown as FlatReply, 400, message);
        return;
      }
      const name = parsed.id;
      const session = getLiveSessionById(core.accessor, session_id);
      if (session === undefined) {
        sendError(reply as unknown as FlatReply, 404, `session ${session_id} not found`);
        return;
      }
      const sessionCwd = session.accessor.get(ISessionContext).cwd;
      const hostFs = core.accessor.get(IHostFileSystem);
      // Same read path as the members roster: project root first, then global.
      const roots = [
        ...memberRoots(core, sessionCwd, 'project'),
        ...memberRoots(core, sessionCwd, 'global'),
      ];
      const def = await readMemberDef(hostFs, roots, name);
      if (def === undefined) {
        sendError(reply as unknown as FlatReply, 404, `member ${name} not found`);
        return;
      }
      const body = req.body as { prompt?: string } | undefined;
      const sourcePrompt = body?.prompt ?? def.prompt;
      if (sourcePrompt.trim().length === 0) {
        sendError(reply as unknown as FlatReply, 400, `member ${name} has an empty prompt`);
        return;
      }
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const aggregate = normalizeDerivedSecondary(
        collectSubagentUsage(lifecycle),
        resolveSecondaryModelId(core),
      );
      const usageByModel = memberUsageWire(aggregate)[name]?.byModel;
      const model = resolvePolishModel(core, lifecycle, def.modelPreference, usageByModel);
      if (model === undefined) {
        sendError(
          reply as unknown as FlatReply,
          400,
          `no model to polish member ${name} — set a model_preference or use the member first`,
        );
        return;
      }
      try {
        const polished = await polishMemberPrompt(core.accessor.get(IModelCatalog), model, sourcePrompt);
        reply.send({ ok: true, polished });
      } catch (err) {
        sendError(reply as unknown as FlatReply, 500, err instanceof Error ? err.message : String(err));
      }
    },
  );
  app.post(polishRoute.path, polishRoute.options, polishRoute.handler as never);
}
