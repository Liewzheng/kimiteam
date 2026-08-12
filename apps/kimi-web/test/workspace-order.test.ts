import { describe, expect, it } from 'vitest';
import {
  moveInOrder,
  parseWorkspaceSortMode,
  reconcileWorkspaceOrder,
  sortByWorkspaceOrder,
  sortWorkspacesByRecent,
  sortWorkspacesByName,
} from '../src/lib/workspaceOrder';

describe('reconcileWorkspaceOrder', () => {
  it('returns null for an empty current set so a not-yet-loaded state never wipes the order', () => {
    expect(reconcileWorkspaceOrder([], ['ws-1', 'ws-2'])).toBeNull();
  });

  it('returns null when the id set is unchanged (a daemon reorder must not rewrite the order)', () => {
    expect(reconcileWorkspaceOrder(['ws-2', 'ws-1'], ['ws-1', 'ws-2'])).toBeNull();
  });

  it('prepends newly-seen ids (newest first)', () => {
    expect(reconcileWorkspaceOrder(['ws-3', 'ws-1', 'ws-2'], ['ws-1', 'ws-2'])).toEqual([
      'ws-3',
      'ws-1',
      'ws-2',
    ]);
  });

  it('drops ids that no longer exist', () => {
    expect(reconcileWorkspaceOrder(['ws-1'], ['ws-2', 'ws-1', 'ws-3'])).toEqual(['ws-1']);
  });

  it('snapshots the initial order on first load', () => {
    expect(reconcileWorkspaceOrder(['ws-2', 'ws-1'], [])).toEqual(['ws-2', 'ws-1']);
  });

  // Regression guard for the "dragged empty workspace bounces back on refresh"
  // bug: if the reconciler is ever fed a *partial* workspace set, it drops the
  // missing workspace and the next call (with the full set) re-adds it at the
  // top. The watcher avoids this by only reconciling once loading has settled,
  // but the reconciler's own "drop + re-add at top" behavior is what makes the
  // guard necessary — pinning it here documents the contract.
  it('drops a temporarily-absent workspace and re-adds it at the top (why the watcher waits for load)', () => {
    const dragged = ['ws-b', 'ws-c', 'ws-empty'];
    const afterPartial = reconcileWorkspaceOrder(['ws-b', 'ws-c'], dragged);
    expect(afterPartial).toEqual(['ws-b', 'ws-c']);
    const afterFull = reconcileWorkspaceOrder(['ws-empty', 'ws-b', 'ws-c'], afterPartial!);
    expect(afterFull).toEqual(['ws-empty', 'ws-b', 'ws-c']);
  });
});

describe('sortByWorkspaceOrder', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('orders items by their position in the order list', () => {
    expect(sortByWorkspaceOrder(items, ['c', 'a', 'b']).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('places unknown ids at the front, keeping their relative order', () => {
    expect(sortByWorkspaceOrder(items, ['b']).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    sortByWorkspaceOrder(items, ['c', 'a', 'b']);
    expect(items).toEqual(copy);
  });
});

describe('sortWorkspacesByRecent', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('orders workspaces by most-recent activity first', () => {
    const lastEditedAt = new Map<string, number>([
      ['a', 100],
      ['b', 300],
      ['c', 200],
    ]);
    expect(sortWorkspacesByRecent(items, lastEditedAt).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('places workspaces without a timestamp (no sessions) at the end', () => {
    const lastEditedAt = new Map<string, number>([['b', 100]]);
    expect(sortWorkspacesByRecent(items, lastEditedAt).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps relative order when timestamps tie (stable sort)', () => {
    const lastEditedAt = new Map<string, number>([
      ['a', 100],
      ['b', 100],
      ['c', 100],
    ]);
    expect(sortWorkspacesByRecent(items, lastEditedAt).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const copy = [...items];
    sortWorkspacesByRecent(items, new Map([['c', 1]]));
    expect(items).toEqual(copy);
  });
});

describe('sortWorkspacesByName', () => {
  const items = [{ id: 'a', name: 'zeta' }, { id: 'b', name: 'alpha' }, { id: 'c', name: 'Mike' }];

  it('orders workspaces by display name, ascending, case-insensitive', () => {
    expect(sortWorkspacesByName(items).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('is number-aware (ws-2 before ws-10)', () => {
    const rows = [{ id: 'w1', name: 'ws-10' }, { id: 'w2', name: 'ws-2' }];
    expect(sortWorkspacesByName(rows).map((x) => x.id)).toEqual(['w2', 'w1']);
  });

  it('falls back to the id when the name is empty', () => {
    const rows = [{ id: 'zeta-ws' }, { id: 'alpha-ws', name: '' }];
    expect(sortWorkspacesByName(rows).map((x) => x.id)).toEqual(['alpha-ws', 'zeta-ws']);
  });

  it('is stable and does not mutate the input', () => {
    const copy = [...items];
    sortWorkspacesByName(items);
    expect(items).toEqual(copy);
    expect(sortWorkspacesByName(items).length).toBe(3);
  });
});

describe('parseWorkspaceSortMode', () => {
  it('keeps an explicit manual / recent / name choice', () => {
    expect(parseWorkspaceSortMode('manual')).toBe('manual');
    expect(parseWorkspaceSortMode('recent')).toBe('recent');
    expect(parseWorkspaceSortMode('name')).toBe('name');
  });

  it('defaults to name for unset or unknown values (list stays stable)', () => {
    expect(parseWorkspaceSortMode(null)).toBe('name');
    expect(parseWorkspaceSortMode('by-magic')).toBe('name');
  });
});

describe('moveInOrder', () => {
  // The drop indicator is a line at the top (before) or bottom (after) of the
  // target, so the result must place fromId immediately next to toId.
  it('moves an item down so it lands before the target', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves an item up so it lands before the target', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('inserts after the target when position is "after"', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('can move an item to the very bottom by dropping after the last item', () => {
    expect(moveInOrder(['A', 'B', 'C'], 'A', 'C', 'after')).toEqual(['B', 'C', 'A']);
  });

  it('swaps with the adjacent item when dropping after it', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when dropping before the adjacent item in the indicator direction', () => {
    // "before b" keeps a above b; to move a below b you drop after b instead.
    expect(moveInOrder(['a', 'b', 'c'], 'a', 'b', 'before')).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when from === to', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('returns the original order when an id is missing', () => {
    expect(moveInOrder(['a', 'b'], 'x', 'b')).toEqual(['a', 'b']);
    expect(moveInOrder(['a', 'b'], 'a', 'x')).toEqual(['a', 'b']);
  });
});
