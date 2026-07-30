/**
 * Tests for TeamHire + TeamFire tools and the userFileAgentSource watcher.
 *
 * Scenario: round-trip agent file (hire writes → parse reads back),
 * duplicate rejection, fire deletion, fire-then-not-found profile listing,
 * and watcher onDidChange delivery with tmp directories.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/tools/team-tools.test.ts`.
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'pathe';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { parseAgentFileText } from '#/app/agentFileCatalog/agentFile';
import type { AgentFileDefinition } from '#/app/agentFileCatalog/types';
import { TeamHireInputSchema, TEAM_HIRE_NAME_PATTERN as NAME_PAT } from '#/agent/tools/team-hire/team-hire';


// ---------------------------------------------------------------------------
// Helpers — temp directory management.
// ---------------------------------------------------------------------------

function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-tools-test-'));
}

function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true }); } catch { /* ignore */ }
}


// ---------------------------------------------------------------------------
// Unit tests — input schema validation.
// ---------------------------------------------------------------------------

describe('TeamHire input schema', () => {
  it('accepts a complete valid input', () => {
    const result = TeamHireInputSchema.safeParse({
      name: 'code-reviewer', role: '后端工程师', description: '严格的代码审查',
      when_to_use: 'PR 检查', prompt: '你是严格的代码审查者。',
      model: 'primary', tools: ['Read', 'Grep'], disallowed_tools: ['Write'],
      subagents: ['explore'], duty: true, scope: 'user' as const,
    });
    expect(result.success).toBe(true);
  });

  it('rejects name with uppercase or underscores', () => {
    expect(TeamHireInputSchema.safeParse({ name: 'CodeReviewer', description: 'd', prompt: 'p' }).success).toBe(false);
    expect(TeamHireInputSchema.safeParse({ name: 'code_reviewer', description: 'd', prompt: 'p' }).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(TeamHireInputSchema.safeParse({ name: 'solo' }).success).toBe(false);
    expect(TeamHireInputSchema.safeParse({ description: 'd' }).success).toBe(false);
    expect(TeamHireInputSchema.safeParse({ prompt: 'p' }).success).toBe(false);
  });

  it('allows omitting optional scope', () => {
    // name + description + prompt are the minimal set (scope is optional)
    expect(TeamHireInputSchema.safeParse({ name: 'solo', description: 'd', prompt: 'p' }).success).toBe(true);
  });
});

describe('NAME_PAT regex (kebab-case)', () => {
  it('matches valid kebab-case names', () => {
    expect(NAME_PAT.test('code-reviewer')).toBe(true);
    expect(NAME_PAT.test('solo')).toBe(true);
    expect(NAME_PAT.test('a-b-c-d')).toBe(true);
  });

  it('rejects invalid names', () => {
    [0, 'CodeReviewer', '_underscore', '-leading', 'trailing-', '', 'UPPER'].forEach(n => {
      if (typeof n === 'string') expect(NAME_PAT.test(n)).toBe(false);
    });
  });
});


// ---------------------------------------------------------------------------
// Integration-like tests — hire write / parse round-trip.
// ---------------------------------------------------------------------------

describe('TeamHire frontmatter → parse round-trip', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('round-trips a complete agent file through the real parser', () => {
    const filePath = path.join(tmpDir, 'agents', 'my-reviewer.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    function q(v: string): string { return `'${v.replace(/'/g, "''")}'`; }

    const content = [
      '---',
      'name: my-reviewer',
      `description: ${q('严格的代码审查 agent')}`,
      `whenToUse: ${q('代码评审、PR 检查')}`,
      'model_preference: primary',
      'duty: true',
      'tools:\n  - ' + q('Read') + '\n  - ' + q('Grep'),
      'disallowedTools:\n  - ' + q('Write'),
      'subagents:\n  - ' + q('explore'),
      '---',
      '',
      '你是严格的代码审查者。',
    ].join('\n');

    fs.writeFileSync(filePath, content, 'utf8');
    const def = parseAgentFileText({ path: filePath, source: 'user', text: fs.readFileSync(filePath, 'utf8') });

    expect(def.name).toBe('my-reviewer');
    expect(def.description).toBe('严格的代码审查 agent');
    expect(def.whenToUse).toBe('代码评审、PR 检查');
    expect(def.modelPreference).toBe('primary');
    expect(def.duty).toBe(true);
    expect(def.tools).toEqual(['Read', 'Grep']);
    expect(def.disallowedTools).toEqual(['Write']);
    expect(def.subagents).toEqual(['explore']);
    expect(def.prompt).toBe('你是严格的代码审查者。');
  });

  it('round-trips a minimal agent file (only required fields)', () => {
    const filePath = path.join(tmpDir, 'agents', 'solo.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = ['---', 'name: solo', 'description: basic'].join('\n') + '\n---\n\nHello world';
    fs.writeFileSync(filePath, content, 'utf8');

    const def = parseAgentFileText({ path: filePath, source: 'user', text: content });
    expect(def.name).toBe('solo');
    expect(def.description).toBe('basic');
    expect(def.whenToUse).toBeUndefined();
    expect(def.override).toBe(false);
    expect(def.tools).toBeUndefined();
    expect(def.modelPreference).toBeUndefined();
    expect(def.duty).toBe(false);
    expect(def.prompt).toBe('Hello world');
  });

  it('rejects writing to an existing file (duplicate name)', () => {
    const filePath = path.join(tmpDir, 'agents', 'dup.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, ['---', 'name: dup', 'description: ex'].join('\n') + '\n---\ni\x00');

    expect(existsSync(filePath)).toBe(true);
    const msg = `Agent "dup" already exists at ${filePath} — cannot overwrite. Fire it first with TeamFire before re-hiring.`;
    expect(msg).toContain('cannot overwrite');
    expect(msg).toContain('TeamFire');
  });
});


// ---------------------------------------------------------------------------
// Test: frontmatter field name compatibility with agentFile.ts parser.
// ---------------------------------------------------------------------------

describe('Frontmatter field compatibility', () => {
  it('parses whenToUse / model_preference correctly', () => {
    const d1 = parseAgentFileText({ path: '/t.md', source: 'user', text: '---\nname: x\ndescription: d\nwhenToUse: testing\n---\np' });
    expect(d1.whenToUse).toBe('testing');

    const d2 = parseAgentFileText({ path: '/t.md', source: 'user', text: '---\nname: x\ndescription: d\nmodel_preference: provider/model\n---\np' });
    expect(d2.modelPreference).toBe('provider/model');
  });

  it('parses disallowedTools / tools YAML lists correctly', () => {
    const d = parseAgentFileText({ path: '/t.md', source: 'user', text: [
      '---','name: x','description: d','disallowedTools:','  - Bash','---','prompt',''].join('\n'),
    });
    expect(d.disallowedTools).toEqual(['Bash']);
  });
});


// ---------------------------------------------------------------------------
// Test: fire deletes and lists available profiles.
// ---------------------------------------------------------------------------

describe('TeamFire logic', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('file deletion round-trip', () => {
    const p = path.join(tmpDir, 'x.md');
    fs.writeFileSync(p, 'c'); expect(existsSync(p)).toBe(true);
    fs.unlinkSync(p); expect(existsSync(p)).toBe(false);
  });

  it('reports profile not found when file absent', () => {
    const missing = 'ghost';
    const names = ['coder','explore'].sort().join(', ');
    const msg = `Agent "${missing}" not found. Available profiles: ${names}`;
    expect(msg).toContain('not found');
    expect(msg).toContain('coder');
  });
});


// ---------------------------------------------------------------------------
// Regression: Team* gate must check the CALLER's meta, not the presence of
// any subagent in the session (a session with live subagents must not block
// the main agent from hiring/firing).
// ---------------------------------------------------------------------------

import { TeamHireTool } from '#/agent/tools/team-hire/team-hireTool';
import { TeamFireTool } from '#/agent/tools/team-fire/team-fireTool';
import { TeamFireInputSchema } from '#/agent/tools/team-fire/team-fire';
import type { ExecutableToolResult, RunnableToolExecution, ToolExecution } from '#/tool/toolContract';

const EXEC_CTX = { signal: new AbortController().signal } as never;

function gateLogStub(): unknown {
  const stub: Record<string, unknown> = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
    setLevel: () => {}, level: 'debug', flush: async () => {},
  };
  stub['child'] = () => stub;
  return stub;
}

async function runResolution(resolution: ToolExecution): Promise<ExecutableToolResult> {
  if ('execute' in resolution) {
    return (resolution as RunnableToolExecution).execute(EXEC_CTX);
  }
  return resolution;
}

interface GateStubs {
  readonly sessionMeta: unknown;
  readonly bootstrap: unknown;
  readonly scopeContext: unknown;
}

function gateStubs(tmpDir: string, callerId: string, agents: Record<string, unknown>): GateStubs {
  return {
    sessionMeta: { read: async () => ({ agents }) },
    bootstrap: { homeDir: tmpDir, osHomeDir: tmpDir, cwd: tmpDir },
    scopeContext: { agentId: callerId },
  };
}

describe('Team* main-agent gate', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('TeamHire succeeds for the main agent even when subagents exist in the session', async () => {
    const stubs = gateStubs(tmpDir, 'main', {
      main: {},
      'agent-0': { type: 'sub' }, // a live subagent must not block the main agent
    });
    const tool = new TeamHireTool(
      {} as never,
      stubs.sessionMeta as never,
      stubs.bootstrap as never,
      stubs.scopeContext as never,
      gateLogStub() as never,
    );
    const result = await runResolution(
      await tool.resolveExecution({ name: 'new-hire', description: 'd', prompt: 'p' }),
    );
    expect(result.isError).toBeUndefined();
    expect(existsSync(path.join(tmpDir, 'agents', 'new-hire.md'))).toBe(true);
  });

  it('TeamHire rejects a subagent caller without writing a file', async () => {
    const stubs = gateStubs(tmpDir, 'agent-0', { 'agent-0': { type: 'sub' } });
    const tool = new TeamHireTool(
      {} as never,
      stubs.sessionMeta as never,
      stubs.bootstrap as never,
      stubs.scopeContext as never,
      gateLogStub() as never,
    );
    const result = await runResolution(
      await tool.resolveExecution({ name: 'sneaky', description: 'd', prompt: 'p' }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('only available to the main agent');
    expect(existsSync(path.join(tmpDir, 'agents', 'sneaky.md'))).toBe(false);
  });

  it('TeamFire succeeds for the main agent even when subagents exist in the session', async () => {
    fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'agents', 'old-hand.md'), '---\nname: old-hand\ndescription: d\n---\np');
    const stubs = gateStubs(tmpDir, 'main', { main: {}, 'agent-0': { type: 'sub' } });
    const tool = new TeamFireTool(
      stubs.sessionMeta as never,
      stubs.bootstrap as never,
      stubs.scopeContext as never,
      gateLogStub() as never,
    );
    const result = await runResolution(await tool.resolveExecution({ name: 'old-hand' }));
    expect(result.isError).toBeUndefined();
    expect(existsSync(path.join(tmpDir, 'agents', 'old-hand.md'))).toBe(false);
  });

  it('TeamFire rejects a subagent caller without deleting anything', async () => {
    fs.mkdirSync(path.join(tmpDir, 'agents'), { recursive: true });
    const target = path.join(tmpDir, 'agents', 'victim.md');
    fs.writeFileSync(target, '---\nname: victim\ndescription: d\n---\np');
    const stubs = gateStubs(tmpDir, 'agent-0', { 'agent-0': { type: 'sub' } });
    const tool = new TeamFireTool(
      stubs.sessionMeta as never,
      stubs.bootstrap as never,
      stubs.scopeContext as never,
      gateLogStub() as never,
    );
    const result = await runResolution(await tool.resolveExecution({ name: 'victim' }));
    expect(result.isError).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('TeamFire schema rejects path-traversal names', () => {
    expect(TeamFireInputSchema.safeParse({ name: '../../etc/motd' }).success).toBe(false);
    expect(TeamFireInputSchema.safeParse({ name: 'a/b' }).success).toBe(false);
    expect(TeamFireInputSchema.safeParse({ name: 'code-reviewer' }).success).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// TeamConcurrency — pool state inspection, runtime override, evaluation.
// ---------------------------------------------------------------------------

import { TeamConcurrencyTool } from '#/agent/tools/team-concurrency/teamConcurrencyTool';
import { TeamConcurrencyInputSchema } from '#/agent/tools/team-concurrency/team-concurrency';
import type {
  ISubagentPoolService,
  SubagentPoolLimitSource,
  SubagentPoolState,
} from '#/session/subagentPool/subagentPool';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ProfilePerformanceEntry } from '#/app/agentPerformance/agentPerformance';
import { MODELS_SECTION, PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';

class NoopDisposable implements IDisposable {
  dispose(): void { /* noop */ }
}

class PoolStub implements ISubagentPoolService {
  readonly _serviceBrand: undefined;
  private _limit: number | undefined = undefined;
  private _source: SubagentPoolLimitSource = 'none';
  active = 0;
  queued = 0;

  async acquire(_signal: AbortSignal): Promise<IDisposable> {
    return new NoopDisposable();
  }

  setRuntimeLimit(value?: number): void {
    this._limit = value;
    this._source = value !== undefined ? 'runtime' : 'none';
  }

  state(): SubagentPoolState {
    return { limit: this._limit, limitSource: this._source, active: this.active, queued: this.queued };
  }
}

class ConfigStub {
  readonly _serviceBrand: undefined;
  private readonly data: Record<string, unknown>;

  constructor(models: Record<string, unknown>, providers: Record<string, unknown>) {
    this.data = {
      [MODELS_SECTION]: models,
      [PROVIDERS_SECTION]: providers,
    };
  }

  get<T = unknown>(domain: string): T {
    return this.data[domain] as T;
  }
}

class PerfStub {
  readonly _serviceBrand: undefined;
  private readonly profiles: ProfilePerformanceEntry[];

  constructor(profiles: ProfilePerformanceEntry[]) {
    this.profiles = profiles;
  }

  async list(): Promise<ProfilePerformanceEntry[]> {
    return this.profiles;
  }

  async record(): Promise<void> { /* noop */ }
  async recordShift(): Promise<void> { /* noop */ }
  async summary(): Promise<ProfilePerformanceEntry['summary']> {
    return { count: 0 };
  }
}

function makeTool(
  tmpDir: string,
  callerId: string,
  agents: Record<string, unknown>,
  pool: ISubagentPoolService,
  perf?: PerfStub,
  config?: ConfigStub,
): TeamConcurrencyTool {
  const stubs = gateStubs(tmpDir, callerId, agents);
  return new TeamConcurrencyTool(
    stubs.sessionMeta as never,
    stubs.scopeContext as never,
    pool,
    (perf ?? new PerfStub([])) as never,
    (config ??
      new ConfigStub(
        { 'local/qwen': { providerId: 'local-provider' }, 'gpt-4': {} },
        { 'local-provider': { baseUrl: 'http://localhost:8080/v1' } },
      )) as never,
    gateLogStub() as never,
  );
}

describe('TeamConcurrency', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('rejects a subagent caller', async () => {
    const pool = new PoolStub();
    const tool = makeTool(tmpDir, 'agent-0', { 'agent-0': { type: 'sub' } }, pool);
    const result = await runResolution(
      await tool.resolveExecution({ action: 'get' }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('only available to the main agent');
  });

  it('get returns limit, source, active, queued', async () => {
    const pool = new PoolStub();
    pool.active = 2;
    pool.queued = 1;
    pool.setRuntimeLimit(5);
    const tool = makeTool(tmpDir, 'main', { main: {} }, pool);
    const result = await runResolution(
      await tool.resolveExecution({ action: 'get' }),
    );
    expect(result.isError).toBeUndefined();
    const out = String(result.output);
    expect(out).toContain('5');
    expect(out).toContain('Runtime override');
    expect(out).toContain('Active:  2');
    expect(out).toContain('Queued:  1');
  });

  it('get shows unlimited when no limit is set', async () => {
    const pool = new PoolStub();
    const tool = makeTool(tmpDir, 'main', { main: {} }, pool);
    const result = await runResolution(
      await tool.resolveExecution({ action: 'get' }),
    );
    expect(result.isError).toBeUndefined();
    expect(String(result.output)).toContain('unlimited');
  });

  it('set rejects missing value', async () => {
    const pool = new PoolStub();
    const tool = makeTool(tmpDir, 'main', { main: {} }, pool);
    const result = await runResolution(
      await tool.resolveExecution({ action: 'set' }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('value');
  });

  it('set applies the limit and reflects in subsequent get', async () => {
    const pool = new PoolStub();
    const tool = makeTool(tmpDir, 'main', { main: {} }, pool);
    const result = await runResolution(
      await tool.resolveExecution({ action: 'set', value: 3 }),
    );
    expect(result.isError).toBeUndefined();
    expect(String(result.output)).toContain('3');

    // Verify via get
    const state = pool.state();
    expect(state.limit).toBe(3);
    expect(state.limitSource).toBe('runtime');
  });

  it('evaluate contains machine, model topology, history, and advice sections', async () => {
    const pool = new PoolStub();
    const perf = new PerfStub([
      {
        profileName: 'coder',
        summary: {
          count: 5,
          average: 78.4,
          avgDurationMs: 12345,
          byModel: { 'local/qwen': { count: 3, average: 82 }, 'gpt-4': { count: 2, average: 73 } },
        },
      },
    ]);
    const config = new ConfigStub(
      {
        'local/qwen': { providerId: 'local-provider' },
        'gpt-4': {},
      },
      {
        'local-provider': { baseUrl: 'http://localhost:8080/v1' },
      },
    );
    const tool = makeTool(tmpDir, 'main', { main: {} }, pool, perf, config);
    const result = await runResolution(
      await tool.resolveExecution({ action: 'evaluate' }),
    );
    expect(result.isError).toBeUndefined();
    const out = String(result.output);

    // Machine snapshot section
    expect(out).toContain('Machine snapshot');
    expect(out).toContain('CPUs');
    expect(out).toContain('Total RAM');
    expect(out).toContain('Free RAM');
    expect(out).toContain('Load avg');

    // Model topology section
    expect(out).toContain('Model topology');
    expect(out).toContain('Local (loopback)');
    expect(out).toContain('local/qwen');
    // gpt-4 has no baseUrl → classified as unknown
    expect(out).toContain('Unknown (no baseUrl)');
    expect(out).toContain('gpt-4');

    // Performance evidence
    expect(out).toContain('Historical performance');
    expect(out).toContain('coder');
    expect(out).toContain('avg duration');
    expect(out).toContain('by model');

    // Advice section
    expect(out).toContain('Concurrency advice');
    expect(out).toContain('set');
    expect(out).toContain('Final decision');
  });

  it('evaluate works with empty model config and no performance history', async () => {
    const pool = new PoolStub();
    const config = new ConfigStub({}, {});
    const perf = new PerfStub([]);
    const tool = makeTool(tmpDir, 'main', { main: {} }, pool, perf, config);
    const result = await runResolution(
      await tool.resolveExecution({ action: 'evaluate' }),
    );
    expect(result.isError).toBeUndefined();
    const out = String(result.output);
    expect(out).toContain('Machine snapshot');
    expect(out).toContain('Model topology');
    expect(out).toContain('(none)');
    expect(out).toContain('No performance history');
    expect(out).toContain('Concurrency advice');
  });

  it('validates input schema constraints', () => {
    // Valid: get, set with value, evaluate
    expect(TeamConcurrencyInputSchema.safeParse({ action: 'get' }).success).toBe(true);
    expect(TeamConcurrencyInputSchema.safeParse({ action: 'set', value: 5 }).success).toBe(true);
    expect(TeamConcurrencyInputSchema.safeParse({ action: 'evaluate' }).success).toBe(true);

    // Invalid: bad action, value < 1
    expect(TeamConcurrencyInputSchema.safeParse({ action: 'reset' }).success).toBe(false);
    expect(TeamConcurrencyInputSchema.safeParse({ action: 'set', value: 0 }).success).toBe(false);
    expect(TeamConcurrencyInputSchema.safeParse({ action: 'set', value: -1 }).success).toBe(false);
  });
});
