// apps/kimi-web/test/agent-progress.test.ts
// Pure tool-progress grouping — the shared contract behind AgentDetailPanel's
// and TeamMemberDetailPanel's live workflow half.
import { describe, expect, it } from 'vitest';
import {
  groupProgress,
  progressFoldCount,
  PROGRESS_FOLD_THRESHOLD,
} from '../src/lib/agentProgress';

describe('groupProgress', () => {
  it('groups a "Calling …" line with its following output lines', () => {
    const groups = groupProgress(['Calling edit_file', '--- a', '+++ b', 'done']);
    expect(groups).toEqual([
      { key: 'g0', call: 'Calling edit_file', output: ['--- a', '+++ b', 'done'] },
    ]);
  });

  it('starts a new group at each "Calling …" line', () => {
    const groups = groupProgress(['Calling a', 'out1', 'Calling b', 'out2', 'out3']);
    expect(groups.map((g) => g.call)).toEqual(['Calling a', 'Calling b']);
    expect(groups[1]!.output).toEqual(['out2', 'out3']);
  });

  it('groups output with no preceding call into a call-less group', () => {
    const groups = groupProgress(['plain', 'Calling c', 'x']);
    expect(groups[0]).toEqual({ key: 'g0', call: '', output: ['plain'] });
  });

  it('returns [] for empty input and trims nothing here (caller trims)', () => {
    expect(groupProgress([])).toEqual([]);
  });
});

describe('fold thresholds', () => {
  it('folds only groups longer than the threshold', () => {
    const short = { key: 'g', call: '', output: Array(PROGRESS_FOLD_THRESHOLD).fill('x') };
    expect(progressFoldCount(short)).toBe(1); // 8 - 5 - 2
    const long = { key: 'g', call: '', output: Array(12).fill('x') };
    expect(progressFoldCount(long)).toBe(5); // 12 - 5 - 2
  });
});
