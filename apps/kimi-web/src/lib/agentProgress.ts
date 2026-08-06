// apps/kimi-web/src/lib/agentProgress.ts
// Pure tool-progress grouping, extracted from AgentDetailPanel so both the
// subagent detail and the team-member detail share one tested algorithm:
// flat progress lines → tool-call groups ("Calling …" starts a group, following
// non-call lines are its output) + the fold thresholds for long outputs.

export interface ProgressGroup {
  key: string;
  /** The "Calling …" tool-call line, or '' for output with no preceding call. */
  call: string;
  output: string[];
}

/** Group flat progress lines into tool-call groups. */
export function groupProgress(lines: string[]): ProgressGroup[] {
  const groups: ProgressGroup[] = [];
  let current: ProgressGroup | null = null;
  let idx = 0;
  for (const line of lines) {
    if (line.startsWith('Calling ')) {
      current = { key: `g${idx++}`, call: line, output: [] };
      groups.push(current);
    } else if (current) {
      current.output.push(line);
    } else {
      current = { key: `g${idx++}`, call: '', output: [line] };
      groups.push(current);
    }
  }
  return groups;
}

/** A group whose output is longer than this folds to a head + tail. */
export const PROGRESS_FOLD_THRESHOLD = 8;
export const PROGRESS_HEAD = 5;
export const PROGRESS_TAIL = 2;

/** Number of hidden lines when a group is folded. */
export function progressFoldCount(group: ProgressGroup): number {
  return group.output.length - PROGRESS_HEAD - PROGRESS_TAIL;
}
