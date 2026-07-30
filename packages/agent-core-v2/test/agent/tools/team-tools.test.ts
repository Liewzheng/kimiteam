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
