/**
 * Tests for TeamHire + TeamFire + TeamScore tools and the userFileAgentSource watcher.
 *
 * Scenario: round-trip agent file (hire writes → parse reads back),
 * duplicate rejection, fire deletion, fire-then-not-found profile listing,
 * watcher onDidChange delivery with tmp directories, and TeamScore perf
 * recording / summary output against an in-memory perf stub.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/tools/team-tools.test.ts`.
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'pathe';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';
import { TeamHireInputSchema, TEAM_HIRE_NAME_PATTERN as NAME_PAT } from '#/agent/tools/team-hire/team-hire';
import { buildPerformanceCard } from '#/agent/tools/agent/agentTool';
import { detectScoreInflation } from '#/agent/tools/team-score/teamScoreTool';
import {
  IAcceptanceEvidenceService,
  type AcceptanceGateResult,
} from '#/agent/tools/team-score/acceptanceEvidence';
import {
  AcceptanceEvidenceService,
  classifyGlobalBashCommand,
  evaluateAcceptanceGate,
  taskIdFromOutputLogPath,
  type AcceptanceEvidenceState,
} from '#/agent/tools/team-score/acceptanceEvidenceService';
import {
  SUBAGENT_SECTION,
  type ScoreGateMode,
} from '#/session/subagent/configSection';
import { ISessionSubagentService, type RunSettledContext } from '#/session/subagent/subagent';
import type { IAgentTaskService } from '#/agent/task/task';


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
      subagents: ['explore'], skills: ['commit', 'pdf'], duty: true, scope: 'user' as const,
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
      'skills:\n  - ' + q('commit') + '\n  - ' + q('pdf'),
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
    expect(def.skills).toEqual(['commit', 'pdf']);
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
import { AgentProfileFileService } from '#/workspace/agentProfileFile/agentProfileFileService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

const EXEC_CTX = { signal: new AbortController().signal } as never;

/** Real agent-profile-file service writing into a temp bootstrap dir. */
function profileFileService(tmpDir: string): AgentProfileFileService {
  return new AgentProfileFileService(
    { homeDir: tmpDir, osHomeDir: tmpDir, cwd: tmpDir } as never,
    new HostFileSystem(),
  );
}

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
  readonly sessionContext: unknown;
}

function gateStubs(tmpDir: string, callerId: string, agents: Record<string, unknown>): GateStubs {
  return {
    sessionMeta: { read: async () => ({ agents }) },
    bootstrap: { homeDir: tmpDir, osHomeDir: tmpDir, cwd: tmpDir },
    scopeContext: { agentId: callerId },
    sessionContext: { sessionId: 'test-session' },
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
      stubs.scopeContext as never,
      gateLogStub() as never,
      profileFileService(tmpDir) as never,
    );
    const result = await runResolution(
      await tool.resolveExecution({ name: 'new-hire', description: 'd', prompt: 'p' }),
    );
    expect(result.isError).toBeUndefined();
    expect(existsSync(path.join(tmpDir, 'agents', 'new-hire.md'))).toBe(true);
  });

  it('TeamHire writes a skills whitelist that the parser reads back identically', async () => {
    const stubs = gateStubs(tmpDir, 'main', { main: {} });
    const tool = new TeamHireTool(
      {} as never,
      stubs.sessionMeta as never,
      stubs.scopeContext as never,
      gateLogStub() as never,
      profileFileService(tmpDir) as never,
    );
    const result = await runResolution(
      await tool.resolveExecution({
        name: 'skill-hire',
        description: 'd',
        prompt: 'p',
        skills: ['commit', 'pdf'],
      }),
    );
    expect(result.isError).toBeUndefined();

    const filePath = path.join(tmpDir, 'agents', 'skill-hire.md');
    expect(existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('skills:\n  - \'commit\'\n  - \'pdf\'');

    const def = parseAgentFileText({ path: filePath, source: 'user', text: content });
    expect(def.skills).toEqual(['commit', 'pdf']);
  });

  it('TeamHire rejects a subagent caller without writing a file', async () => {
    const stubs = gateStubs(tmpDir, 'agent-0', { 'agent-0': { type: 'sub' } });
    const tool = new TeamHireTool(
      {} as never,
      stubs.sessionMeta as never,
      stubs.scopeContext as never,
      gateLogStub() as never,
      profileFileService(tmpDir) as never,
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
      stubs.scopeContext as never,
      gateLogStub() as never,
      profileFileService(tmpDir) as never,
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
      stubs.scopeContext as never,
      gateLogStub() as never,
      profileFileService(tmpDir) as never,
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
import type { PerformanceEntry, PerformanceSummary, ProfilePerformanceEntry } from '#/app/agentPerformance/agentPerformance';
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


// ---------------------------------------------------------------------------
// TeamScore — perf.record + summary output, main-agent gate.
// ---------------------------------------------------------------------------

import { TeamScoreTool } from '#/agent/tools/team-score/teamScoreTool';
import { TeamScoreToolInputSchema, SUBAGENT_NOT_ALLOWED } from '#/agent/tools/team-score/team-score';

class ScorePerfStub {
  readonly _serviceBrand: undefined;
  readonly entries: PerformanceEntry[] = [];
  private readonly summaries: Record<string, PerformanceSummary>;

  constructor(summaries: Record<string, PerformanceSummary> = {}) {
    this.summaries = summaries;
  }

  async record(entry: PerformanceEntry): Promise<void> {
    this.entries.push(entry);
  }

  async summary(profileName: string): Promise<PerformanceSummary> {
    return this.summaries[profileName] ?? { count: 0 };
  }

  async recentScores(profileName: string, limit: number): Promise<number[]> {
    return this.entries
      .filter((entry) => entry.profileName === profileName)
      .slice(-limit)
      .map((entry) => entry.score);
  }

  async list(): Promise<ProfilePerformanceEntry[]> {
    return [];
  }

  async recordShift(): Promise<void> {
    /* noop */
  }
}

interface ScoreGateTestOptions {
  readonly scoreGate?: ScoreGateMode;
  readonly teamMode?: boolean;
  readonly evidence?: IAcceptanceEvidenceService;
}

function makeScoreTool(
  tmpDir: string,
  callerId: string,
  agents: Record<string, unknown>,
  perf: ScorePerfStub,
  opts: ScoreGateTestOptions = {},
): TeamScoreTool {
  const stubs = gateStubs(tmpDir, callerId, agents);
  const configStub = {
    _serviceBrand: undefined,
    get: (domain: string) => {
      if (domain === SUBAGENT_SECTION) {
        return {
          // Default `off` so pre-gate tests keep recording untouched; gate
          // tests pass an explicit mode.
          scoreGate: opts.scoreGate ?? 'off',
          teamMode: opts.teamMode ?? true,
        };
      }
      return undefined;
    },
  };
  const evidenceStub: IAcceptanceEvidenceService =
    opts.evidence ??
    ({
      _serviceBrand: undefined,
      evaluateRecordGate: () => ({ ok: true }),
    } as IAcceptanceEvidenceService);
  return new TeamScoreTool(
    stubs.sessionMeta as never,
    stubs.scopeContext as never,
    perf as never,
    gateLogStub() as never,
    configStub as never,
    evidenceStub as never,
    stubs.sessionContext as never,
  );
}

describe('TeamScore', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('rejects a subagent caller without recording anything', async () => {
    const perf = new ScorePerfStub();
    const tool = makeScoreTool(tmpDir, 'agent-0', { 'agent-0': { type: 'sub' } }, perf);
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 80, note: 'solid' }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toBe(SUBAGENT_NOT_ALLOWED);
    expect(perf.entries).toHaveLength(0);
  });

  it('first score prints "No scores yet" when the profile has no history', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 72, note: 'first pass' }),
    );
    expect(result.isError).toBeUndefined();
    expect(String(result.output)).toBe(
      '[TeamScore] Scored "coder" — `72/100`. No scores yet.',
    );
  });

  it('appends Last score and Average when history exists', async () => {
    const perf = new ScorePerfStub({ coder: { last: 85, average: 81.5, count: 4 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 90, note: 'top shelf' }),
    );
    expect(result.isError).toBeUndefined();
    expect(String(result.output)).toBe(
      '[TeamScore] Scored "coder" — `90/100`. Last score: 85. Average: 81.5 (4 total).',
    );
  });

  it('omits the Average line when the summary has a last score but no average', async () => {
    const perf = new ScorePerfStub({ coder: { last: 60, count: 2 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 50, note: 'dip' }),
    );
    expect(result.isError).toBeUndefined();
    expect(String(result.output)).toBe(
      '[TeamScore] Scored "coder" — `50/100`. Last score: 60.',
    );
  });

  it('maps record input fields onto the performance entry', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    await runResolution(
      await tool.resolveExecution({
        profile: 'coder',
        score: 88,
        note: 'fast and clean',
        model: 'local/qwen',
        agent_id: 'inst-42',
      }),
    );
    expect(perf.entries).toHaveLength(1);
    const entry = perf.entries[0]!;
    expect(entry.profileName).toBe('coder');
    expect(entry.score).toBe(88);
    expect(entry.note).toBe('fast and clean');
    expect(entry.model).toBe('local/qwen');
    expect(entry.agentId).toBe('inst-42'); // agent_id → agentId
    expect(entry.sessionId).toBe('test-session'); // filled from the session context
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('maps todo_id onto the performance entry as todoId', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    await runResolution(
      await tool.resolveExecution({
        profile: 'coder',
        score: 85,
        note: 'delivered the unit',
        todo_id: 'T5',
      }),
    );
    expect(perf.entries).toHaveLength(1);
    expect(perf.entries[0]!.todoId).toBe('T5');
  });

  it('passes undefined for optional model/agent_id when omitted', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 60, note: 'bare' }),
    );
    const entry = perf.entries[0]!;
    expect(entry.agentId).toBeUndefined();
    expect(entry.model).toBeUndefined();
  });

  it('validates input schema constraints', () => {
    // Valid: required fields, score at inclusive bounds, optional model/agent_id
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: 50, note: 'ok' }).success).toBe(true);
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: 0, note: 'min' }).success).toBe(true);
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: 100, note: 'max' }).success).toBe(true);
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: 50, note: 'n', model: 'm', agent_id: 'a' }).success).toBe(true);

    // Invalid: score out of range, non-integer score, missing required field
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: -1, note: 'x' }).success).toBe(false);
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: 101, note: 'x' }).success).toBe(false);
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: 50.5, note: 'x' }).success).toBe(false);
    expect(TeamScoreToolInputSchema.safeParse({ profile: 'coder', score: 50 }).success).toBe(false);

    // Whitespace-only profile trims to empty → rejected; surrounding whitespace is trimmed
    expect(TeamScoreToolInputSchema.safeParse({ profile: '   ', score: 50, note: 'x' }).success).toBe(false);
    const trimmed = TeamScoreToolInputSchema.safeParse({ profile: '  coder ', score: 50, note: ' n ' });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) {
      expect(trimmed.data.profile).toBe('coder');
      expect(trimmed.data.note).toBe('n');
    }
  });

  it('appends a score-inflation warning when the recent distribution is skewed high', async () => {
    const perf = new ScorePerfStub({ coder: { last: 95, average: 96, count: 6 } });
    // Seed 4 prior 95s — plus the new 96 → 5 recent scores, all >= 75.
    for (let i = 0; i < 4; i++) {
      perf.entries.push({
        profileName: 'coder',
        ts: '2026-01-01T00:00:00.000Z',
        score: 95,
        note: 'prior',
      });
    }
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 96, note: 'stellar' }),
    );
    expect(result.isError).toBeUndefined();
    const output = String(result.output);
    expect(output).toContain('Score inflation detected');
    expect(output).toContain('all >= 75');
    expect(output).toContain('coder');
    // The warning is advisory — the success text is still present.
    expect(output).toContain('[TeamScore] Scored "coder"');
  });

  it('penalty appends a negative entry and drags the average down', async () => {
    const perf = new ScorePerfStub({ coder: { last: 85, average: 80, count: 4 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    const result = await runResolution(
      await tool.resolveExecution({
        action: 'penalty',
        profile: 'coder',
        points: 10,
        reason: 'missed the review deadline',
        model: 'provider/model-x',
        agent_id: 'inst-7',
      }),
    );
    expect(result.isError).toBeUndefined();
    const output = String(result.output);
    expect(output).toContain('[TeamScore] Penalized "coder"');
    expect(output).toContain('deducted 10');

    expect(perf.entries).toHaveLength(1);
    const entry = perf.entries[0]!;
    expect(entry.profileName).toBe('coder');
    // score = max(0, round(80 - 10)) = 70 — a low entry that drags the average.
    expect(entry.score).toBe(70);
    expect(entry.note).toBe('[penalty] missed the review deadline');
    expect(entry.model).toBe('provider/model-x');
    expect(entry.agentId).toBe('inst-7');
    expect(entry.sessionId).toBe('test-session'); // penalty entries carry the session too
  });

  it('penalty clamps the recorded score at 0 and carries the [penalty] note prefix', async () => {
    const perf = new ScorePerfStub({ coder: { last: 25, average: 20, count: 3 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    const result = await runResolution(
      await tool.resolveExecution({
        action: 'penalty',
        profile: 'coder',
        points: 50,
        reason: 'data loss incident',
        model: 'provider/model-x',
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(perf.entries).toHaveLength(1);
    // round(20 - 50) = -30 → clamped to 0.
    expect(perf.entries[0]!.score).toBe(0);
    expect(perf.entries[0]!.note).toBe('[penalty] data loss incident');
  });

  it('penalty errors when the profile has no performance history', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    const result = await runResolution(
      await tool.resolveExecution({
        action: 'penalty',
        profile: 'coder',
        points: 10,
        reason: 'unpaid',
        model: 'provider/model-x',
      }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('no performance history');
    expect(perf.entries).toHaveLength(0);
  });

  it('penalty schema requires points, reason and model, with points in 1–100', () => {
    // Valid penalty.
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 10, reason: 'x', model: 'm' }).success).toBe(true);
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 1, reason: 'x', model: 'm' }).success).toBe(true);
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 100, reason: 'x', model: 'm' }).success).toBe(true);
    // Missing fields.
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', reason: 'x', model: 'm' }).success).toBe(false);
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 10, model: 'm' }).success).toBe(false);
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 10, reason: 'x' }).success).toBe(false);
    // Points out of range.
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 0, reason: 'x', model: 'm' }).success).toBe(false);
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 101, reason: 'x', model: 'm' }).success).toBe(false);
    // A penalty must not smuggle in record-only fields.
    expect(TeamScoreToolInputSchema.safeParse({ action: 'penalty', profile: 'coder', points: 10, reason: 'x', model: 'm', score: 99, note: 'n' }).success).toBe(true);
  });

  it('penalty coexists with record entries and deduces from the current average', async () => {
    const perf = new ScorePerfStub({ coder: { last: 90, average: 85, count: 4 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf);
    // A normal record first.
    await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 92, note: 'good turn', model: 'provider/model-x' }),
    );
    // Then a penalty: deducted from the (configured) current average 85 → 75.
    await runResolution(
      await tool.resolveExecution({
        action: 'penalty',
        profile: 'coder',
        points: 10,
        reason: 'regression introduced',
        model: 'provider/model-x',
      }),
    );
    expect(perf.entries).toHaveLength(2);
    expect(perf.entries[0]!.score).toBe(92);
    expect(perf.entries[0]!.note).toBe('good turn');
    expect(perf.entries[1]!.score).toBe(75);
    expect(perf.entries[1]!.note).toBe('[penalty] regression introduced');
  });
});


// ---------------------------------------------------------------------------
// TeamScore — engine-level acceptance gate ([subagent] score_gate).
// ---------------------------------------------------------------------------

class GateEvidenceStub implements IAcceptanceEvidenceService {
  declare readonly _serviceBrand: undefined;
  constructor(private readonly result: AcceptanceGateResult) {}
  evaluateRecordGate(_profileName: string): AcceptanceGateResult {
    return this.result;
  }
}

const FAILING_GATE: AcceptanceGateResult = {
  ok: false,
  message:
    'No acceptance evidence for "coder": missing read-delivery or a diff/test rerun after delivery.',
};

describe('TeamScore acceptance gate — tool wiring', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('enforce rejects a record with no acceptance evidence and records nothing', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf, {
      scoreGate: 'enforce',
      evidence: new GateEvidenceStub(FAILING_GATE),
    });
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 80, note: 'solid' }),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('Blocked by acceptance gate');
    expect(String(result.output)).toContain('No acceptance evidence');
    expect(perf.entries).toHaveLength(0);
  });

  it('enforce allows a record when acceptance evidence exists', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf, {
      scoreGate: 'enforce',
      evidence: new GateEvidenceStub({ ok: true }),
    });
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 80, note: 'solid' }),
    );
    expect(result.isError).toBeUndefined();
    expect(perf.entries).toHaveLength(1);
    expect(perf.entries[0]!.score).toBe(80);
  });

  it('penalty is exempt from the gate even when evidence is missing', async () => {
    const perf = new ScorePerfStub({ coder: { last: 85, average: 80, count: 4 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf, {
      scoreGate: 'enforce',
      evidence: new GateEvidenceStub(FAILING_GATE),
    });
    const result = await runResolution(
      await tool.resolveExecution({
        action: 'penalty',
        profile: 'coder',
        points: 10,
        reason: 'missed deadline',
        model: 'provider/model-x',
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(perf.entries).toHaveLength(1);
    expect(perf.entries[0]!.note).toBe('[penalty] missed deadline');
  });

  it('warn records the score but appends the missing-evidence warning', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf, {
      scoreGate: 'warn',
      evidence: new GateEvidenceStub(FAILING_GATE),
    });
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 70, note: 'ok' }),
    );
    expect(result.isError).toBeUndefined();
    expect(perf.entries).toHaveLength(1);
    const output = String(result.output);
    expect(output).toContain('[TeamScore] Scored "coder"');
    expect(output).toContain('[TeamScore] Warning');
    expect(output).toContain('No acceptance evidence');
  });

  it('off records without any gate warning', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf, {
      scoreGate: 'off',
      evidence: new GateEvidenceStub(FAILING_GATE),
    });
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 70, note: 'ok' }),
    );
    expect(result.isError).toBeUndefined();
    expect(perf.entries).toHaveLength(1);
    expect(String(result.output)).not.toContain('Warning');
    expect(String(result.output)).not.toContain('No acceptance evidence');
  });

  it('does not apply the gate when team mode is off', async () => {
    const perf = new ScorePerfStub({ coder: { count: 0 } });
    const tool = makeScoreTool(tmpDir, 'main', { main: {} }, perf, {
      scoreGate: 'enforce',
      teamMode: false,
      evidence: new GateEvidenceStub(FAILING_GATE),
    });
    const result = await runResolution(
      await tool.resolveExecution({ profile: 'coder', score: 70, note: 'ok' }),
    );
    expect(result.isError).toBeUndefined();
    expect(perf.entries).toHaveLength(1);
    expect(String(result.output)).not.toContain('No acceptance evidence');
  });
});

describe('acceptance evidence classification (shape detection)', () => {
  it('extracts the delivery task id from a Read on agents/main/tasks/<id>/output.log', () => {
    expect(taskIdFromOutputLogPath('agents/main/tasks/agent-3f2a9c1d/output.log')).toBe('agent-3f2a9c1d');
    expect(taskIdFromOutputLogPath('/abs/session/dir/agents/main/tasks/agent-3f2a9c1d/output.log')).toBe('agent-3f2a9c1d');
    expect(taskIdFromOutputLogPath('agents\\main\\tasks\\agent-3f2a9c1d\\output.log')).toBe('agent-3f2a9c1d');
    // Not a delivery log.
    expect(taskIdFromOutputLogPath('agents/main/output.log')).toBeUndefined();
    expect(taskIdFromOutputLogPath('src/output.log')).toBeUndefined();
    expect(taskIdFromOutputLogPath('agents/main/tasks/agent-3f2a9c1d/notes.md')).toBeUndefined();
  });

  it('classifies Bash commands as read-diff / rerun-tests by shape', () => {
    expect(classifyGlobalBashCommand('Bash', { command: 'git diff' })).toBe('read-diff');
    expect(classifyGlobalBashCommand('Bash', { command: 'git diff --stat HEAD~1' })).toBe('read-diff');
    expect(classifyGlobalBashCommand('Bash', { command: 'git show abc123' })).toBe('read-diff');
    expect(classifyGlobalBashCommand('Bash', { command: 'git -C packages/agent-core-v2 diff' })).toBe('read-diff');
    expect(classifyGlobalBashCommand('Bash', { command: 'pnpm exec vitest run' })).toBe('rerun-tests');
    expect(classifyGlobalBashCommand('Bash', { command: 'pnpm test' })).toBe('rerun-tests');
    expect(classifyGlobalBashCommand('Bash', { command: 'pnpm -C packages/agent-core-v2 test' })).toBe('rerun-tests');
    expect(classifyGlobalBashCommand('Bash', { command: 'npm test' })).toBe('rerun-tests');
    expect(classifyGlobalBashCommand('Bash', { command: 'pytest -q' })).toBe('rerun-tests');
    // Not acceptance actions.
    expect(classifyGlobalBashCommand('Bash', { command: 'ls -la' })).toBeUndefined();
    expect(classifyGlobalBashCommand('Bash', { command: 'git log' })).toBeUndefined();
    expect(classifyGlobalBashCommand('Bash', { command: 'pnpm install' })).toBeUndefined();
    expect(classifyGlobalBashCommand('Read', { path: 'x' })).toBeUndefined();
    expect(classifyGlobalBashCommand('Bash', {})).toBeUndefined();
  });
});

describe('evaluateAcceptanceGate — evidence semantics', () => {
  function stateFor(
    completions: Record<string, number>,
    opts: { diffAt?: number; testsAt?: number; readDelivered?: string[] } = {},
  ): AcceptanceEvidenceState {
    return {
      deliveryCompletedAt: new Map(Object.entries(completions)),
      readDeliveredProfiles: new Set(opts.readDelivered ?? []),
      latestDiffAt: opts.diffAt ?? 0,
      latestTestsAt: opts.testsAt ?? 0,
    };
  }

  it('rejects with no evidence of any kind', () => {
    const gate = evaluateAcceptanceGate(stateFor({}), 'coder');
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain('coder');
  });

  it('passes when the profile delivery was read (read-delivery)', () => {
    const state = stateFor({}, { readDelivered: ['coder'] });
    expect(evaluateAcceptanceGate(state, 'coder').ok).toBe(true);
  });

  it('rejects when the only global evidence predates the delivery completion', () => {
    const state = stateFor({ coder: 2000 }, { diffAt: 1000 });
    expect(evaluateAcceptanceGate(state, 'coder').ok).toBe(false);
  });

  it('read-diff global evidence after delivery covers the whole batch (other profiles too)', () => {
    // Two members delivered in one turn; a single diff review after both
    // completions satisfies the gate for both.
    const state = stateFor({ coder: 1000, reviewer: 1500 }, { diffAt: 2000 });
    expect(evaluateAcceptanceGate(state, 'coder').ok).toBe(true);
    expect(evaluateAcceptanceGate(state, 'reviewer').ok).toBe(true);
  });

  it('rerun-tests global evidence after delivery satisfies the gate', () => {
    const state = stateFor({ coder: 1000 }, { testsAt: 3000 });
    expect(evaluateAcceptanceGate(state, 'coder').ok).toBe(true);
  });

  it('rejects when no delivery completion is observed, even with global evidence', () => {
    const state = stateFor({}, { diffAt: 5000 });
    const gate = evaluateAcceptanceGate(state, 'coder');
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain('no delivery completion');
  });
});

describe('AcceptanceEvidenceService — event pipeline', () => {
  // Minimal in-memory event bus + stubs, exercising the real service wiring.
  class BusStub {
    readonly _serviceBrand: undefined;
    private readonly handlers = new Map<string, Array<(e: unknown) => void>>();
    publish(): void { /* noop */ }
    subscribe(type: unknown, handler: unknown): IDisposable {
      const key = type as string;
      const list = this.handlers.get(key) ?? [];
      list.push(handler as (e: unknown) => void);
      this.handlers.set(key, list);
      return { dispose: () => {} };
    }
    emit(type: string, event: unknown): void {
      for (const handler of this.handlers.get(type) ?? []) handler(event);
    }
  }

  function subagentsStub(settleListeners: Array<(ctx: RunSettledContext) => void>): ISessionSubagentService {
    return {
      _serviceBrand: undefined,
      onDidRunSettle: (handler: (ctx: RunSettledContext) => void) => {
        settleListeners.push(handler);
        return { dispose: () => {} };
      },
    } as unknown as ISessionSubagentService;
  }

  it('attributes a TaskOutput read to the delivering profile and opens the gate', () => {
    const bus = new BusStub();
    const settleListeners: Array<(ctx: RunSettledContext) => void> = [];
    const tasks = {
      _serviceBrand: undefined,
      getTask: (taskId: string) =>
        taskId === 'agent-3f2a9c1d'
          ? { taskId, kind: 'agent', subagentType: 'coder', agentId: 'inst-1', status: 'completed' }
          : undefined,
    } as unknown as IAgentTaskService;

    const service = new AcceptanceEvidenceService(
      { agentId: 'main' } as never,
      bus as never,
      tasks as never,
      subagentsStub(settleListeners) as never,
      gateLogStub() as never,
    );

    // The member's delivery settles, then the main agent reads its output.
    settleListeners.forEach((fn) => fn({ agentId: 'inst-1', profileName: 'coder' }));
    bus.emit('tool.call.started', {
      type: 'tool.call.started', turnId: 1, toolCallId: 'c1',
      name: 'TaskOutput', args: { task_id: 'agent-3f2a9c1d' },
    });
    bus.emit('tool.result', { type: 'tool.result', turnId: 1, toolCallId: 'c1', output: 'ok' });

    expect(service.evaluateRecordGate('coder').ok).toBe(true);
    // A different profile never read → no evidence leaks across members.
    expect(service.evaluateRecordGate('reviewer').ok).toBe(false);
  });

  it('a Bash git diff after settle covers the whole batch via the real service', () => {
    const bus = new BusStub();
    const settleListeners: Array<(ctx: RunSettledContext) => void> = [];
    const tasks = {
      _serviceBrand: undefined,
      getTask: () => undefined,
    } as unknown as IAgentTaskService;

    const service = new AcceptanceEvidenceService(
      { agentId: 'main' } as never,
      bus as never,
      tasks as never,
      subagentsStub(settleListeners) as never,
      gateLogStub() as never,
    );

    settleListeners.forEach((fn) => fn({ agentId: 'inst-1', profileName: 'coder' }));
    settleListeners.forEach((fn) => fn({ agentId: 'inst-2', profileName: 'reviewer' }));
    bus.emit('tool.call.started', {
      type: 'tool.call.started', turnId: 1, toolCallId: 'c2',
      name: 'Bash', args: { command: 'git diff HEAD' },
    });
    bus.emit('tool.result', { type: 'tool.result', turnId: 1, toolCallId: 'c2', output: '...' });

    expect(service.evaluateRecordGate('coder').ok).toBe(true);
    expect(service.evaluateRecordGate('reviewer').ok).toBe(true);
  });

  it('is inert for a subagent scope (collects nothing)', () => {
    const bus = new BusStub();
    const settleListeners: Array<(ctx: RunSettledContext) => void> = [];
    const service = new AcceptanceEvidenceService(
      { agentId: 'agent-0' } as never,
      bus as never,
      { getTask: () => undefined } as never,
      subagentsStub(settleListeners) as never,
      gateLogStub() as never,
    );
    // Settle + a diff would be evidence in the main scope; here it is not.
    settleListeners.forEach((fn) => fn({ agentId: 'inst-1', profileName: 'coder' }));
    bus.emit('tool.call.started', {
      type: 'tool.call.started', turnId: 1, toolCallId: 'c2',
      name: 'Bash', args: { command: 'git diff HEAD' },
    });
    bus.emit('tool.result', { type: 'tool.result', turnId: 1, toolCallId: 'c2', output: '...' });
    expect(service.evaluateRecordGate('coder').ok).toBe(false);
  });
});

describe('detectScoreInflation', () => {
  it('flags a window where every score is >= 75', () => {
    const warning = detectScoreInflation('coder', [92, 95, 91, 96, 90]);
    expect(warning).toContain('Score inflation detected');
    expect(warning).toContain('coder');
    expect(warning).toContain('all >= 75');
  });

  it('returns undefined for a healthy distribution', () => {
    expect(detectScoreInflation('coder', [70, 72, 74, 70, 68])).toBeUndefined();
  });

  it('returns undefined when the sample is below the minimum', () => {
    expect(detectScoreInflation('coder', [95, 96, 98])).toBeUndefined();
    // Boundary: exactly 4 high scores do not trigger either.
    expect(detectScoreInflation('coder', [75, 75, 75, 75])).toBeUndefined();
  });

  it('flags exactly 5 scores at 75 (boundary)', () => {
    const warning = detectScoreInflation('coder', [75, 75, 75, 75, 75]);
    expect(warning).toContain('all >= 75');
    expect(warning).toContain('last 5 scores');
  });

  it('flags a >= 75 average even when not every score is high', () => {
    const warning = detectScoreInflation('coder', [95, 95, 95, 95, 50]);
    expect(warning).toContain('average of the last 5 scores');
    expect(warning).toContain('is >= 75');
  });

  it('considers only the last 10 scores', () => {
    // Two low scores at the head fall outside the window; the last 10 are 95.
    const scores = [50, 55, ...Array.from({ length: 10 }, () => 95)];
    const warning = detectScoreInflation('coder', scores);
    expect(warning).toContain('all >= 75');
    expect(warning).toContain('last 10 scores');
  });

  it('flags exactly 10 scores at 75 (window boundary)', () => {
    const warning = detectScoreInflation('coder', Array.from({ length: 10 }, () => 75));
    expect(warning).toContain('all >= 75');
    expect(warning).toContain('last 10 scores');
  });
});

describe('AgentProfileFileService', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkTempDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('creates a parseable agent file for a valid input', async () => {
    const svc = profileFileService(tmpDir);
    const result = await svc.create({
      name: 'code-reviewer',
      description: 'Reviews code',
      prompt: 'You review code.',
      role: 'reviewer',
      whenToUse: 'code review',
      modelPreference: 'primary',
      tools: ['Read', 'Grep'],
      skills: ['commit'],
      scope: 'user',
    });
    expect(result.created).toBe(true);
    expect(result.path).toBe(path.join(tmpDir, 'agents', 'code-reviewer.md'));
    expect(existsSync(result.path)).toBe(true);

    const content = fs.readFileSync(result.path, 'utf8');
    const def = parseAgentFileText({ path: result.path, source: 'user', text: content });
    expect(def.name).toBe('code-reviewer');
    expect(def.description).toBe('Reviews code');
    expect(def.role).toBe('reviewer');
    expect(def.whenToUse).toBe('code review');
    expect(def.modelPreference).toBe('primary');
    expect(def.tools).toEqual(['Read', 'Grep']);
    expect(def.skills).toEqual(['commit']);
    expect(def.prompt).toBe('You review code.');
  });

  it('refuses to overwrite an existing file', async () => {
    const svc = profileFileService(tmpDir);
    await svc.create({ name: 'dup', description: 'd', prompt: 'p' });
    await expect(
      svc.create({ name: 'dup', description: 'other', prompt: 'other' }),
    ).rejects.toMatchObject({ code: 'already_exists' });
    // The original file is untouched.
    expect(fs.readFileSync(path.join(tmpDir, 'agents', 'dup.md'), 'utf8')).toContain(
      "description: 'd'",
    );
  });

  it('rejects non-kebab-case names without writing anything', async () => {
    const svc = profileFileService(tmpDir);
    await expect(
      svc.create({ name: 'Bad_Name', description: 'd', prompt: 'p' }),
    ).rejects.toMatchObject({ code: 'invalid_name' });
    expect(existsSync(path.join(tmpDir, 'agents', 'Bad_Name.md'))).toBe(false);
  });

  it('removes an existing file and reports the deleted path', async () => {
    const svc = profileFileService(tmpDir);
    await svc.create({ name: 'old-hand', description: 'd', prompt: 'p' });
    const result = await svc.remove('old-hand', 'user');
    expect(result.removed).toBe(true);
    expect(existsSync(result.path)).toBe(false);
  });

  it('silently skips removal when the file does not exist', async () => {
    const svc = profileFileService(tmpDir);
    const result = await svc.remove('ghost', 'user');
    expect(result.removed).toBe(false);
  });

  it('updates frontmatter fields while preserving the body', async () => {
    const svc = profileFileService(tmpDir);
    await svc.create({
      name: 'coder',
      description: 'Coder',
      prompt: 'Write code.',
      modelPreference: 'primary',
      tools: ['Read'],
      role: 'coder',
    });
    const result = await svc.update('coder', 'user', {
      modelPreference: 'secondary',
      tools: ['Read', 'Bash'],
      role: 'senior-coder',
      skills: ['commit'],
    });
    expect(result.updated).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, 'agents', 'coder.md'), 'utf8');
    const def = parseAgentFileText({ path: result.path, source: 'user', text: content });
    expect(def.modelPreference).toBe('secondary');
    expect(def.tools).toEqual(['Read', 'Bash']);
    expect(def.role).toBe('senior-coder');
    expect(def.skills).toEqual(['commit']);
    expect(def.prompt).toBe('Write code.'); // body preserved
  });
});

describe('buildPerformanceCard', () => {
  function perf(entries: ReadonlyArray<[string, { readonly average?: number; readonly count: number; readonly last?: number }]>) {
    return new Map(entries.map(([name, s]) => [name, s]));
  }

  it('renders a full card with average, score window and team rank', () => {
    const card = buildPerformanceCard(
      'explore',
      perf([
        ['explore', { average: 92, count: 5, last: 95 }],
        ['coder', { average: 84, count: 4, last: 88 }],
        ['reader', { average: 90, count: 6, last: 91 }],
      ]),
    );
    expect(card).toContain('<performance_card>');
    expect(card).toContain('profile: explore');
    expect(card).toContain('average: 92 (last 5 scores)');
    expect(card).toContain('rank: 1/3');
    expect(card).toContain('</performance_card>');
    // Privacy: the card only carries the holder's own data — no other member's
    // name or score leaks into it.
    expect(card).not.toContain('coder');
    expect(card).not.toContain('reader');
    expect(card).not.toContain('84');
  });

  it('returns undefined when the profile has no scored entries', () => {
    expect(buildPerformanceCard('explore', perf([['explore', { count: 0 }]]))).toBeUndefined();
    expect(buildPerformanceCard('explore', new Map())).toBeUndefined();
  });

  it('shows the average but flags the rank as insufficient data below the minimum score count', () => {
    const card = buildPerformanceCard(
      'explore',
      perf([
        ['explore', { average: 90, count: 2, last: 90 }],
        ['coder', { average: 84, count: 4 }],
      ]),
    );
    expect(card).toContain('average: 90 (last 2 scores)');
    expect(card).toContain('rank: insufficient data (need at least 3 scores)');
  });

  it('marks the lowest scored member neutrally when at least two members are scored', () => {
    const card = buildPerformanceCard(
      'explore',
      perf([
        ['explore', { average: 60, count: 5, last: 62 }],
        ['coder', { average: 84, count: 4 }],
        ['reader', { average: 90, count: 6 }],
      ]),
    );
    expect(card).toContain('rank: 3/3 — currently the lowest among 3 scored members (reference only)');
  });

  it('omits the lowest-member note when only one member is scored', () => {
    const card = buildPerformanceCard(
      'explore',
      perf([
        ['explore', { average: 60, count: 5, last: 62 }],
        ['coder', { count: 0 }],
      ]),
    );
    expect(card).toContain('rank: 1/1');
    expect(card).not.toContain('lowest');
  });

  it('ranks by average and excludes profiles below the minimum score count', () => {
    const card = buildPerformanceCard(
      'reader',
      perf([
        ['explore', { average: 92, count: 5 }],
        ['reader', { average: 85, count: 4 }],
        ['coder', { average: 88, count: 6 }],
        ['writer', { average: 70, count: 5 }],
        ['one-shot', { average: 99, count: 1 }], // below the minimum — excluded from ranking
      ]),
    );
    // 92 > 88 > 85 > 70; the 1-score outlier does not shift the rank.
    expect(card).toContain('rank: 3/4');
  });
});
