// apps/kimi-web/src/lib/sessionSelection.test.ts
import { describe, expect, it } from 'vitest';

import {
  applySessionSelection,
  sessionMenuActions,
  sessionRange,
} from './sessionSelection';

describe('sessionRange', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('returns the inclusive span from anchor to target in list order', () => {
    expect(sessionRange(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  it('handles anchor after target (reverse range)', () => {
    expect(sessionRange(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('returns just the target when anchor equals target', () => {
    expect(sessionRange(order, 'c', 'c')).toEqual(['c']);
  });

  it('falls back to the target when the anchor is not in this list (cross-group shift)', () => {
    expect(sessionRange(order, 'other-group-id', 'c')).toEqual(['c']);
  });

  it('falls back to the target when the target is not in the list', () => {
    expect(sessionRange(order, 'b', 'missing')).toEqual(['missing']);
  });

  it('returns the target on an empty list', () => {
    expect(sessionRange([], 'a', 'x')).toEqual(['x']);
  });
});

describe('applySessionSelection', () => {
  it('plain click replaces the selection with just the clicked id', () => {
    expect(applySessionSelection(['a', 'b', 'c'], { kind: 'select', id: 'd' })).toEqual(['d']);
  });

  it('ctrl/cmd click toggles an id into the selection', () => {
    expect(applySessionSelection(['a'], { kind: 'toggle', id: 'b' })).toEqual(['a', 'b']);
  });

  it('ctrl/cmd click toggles an id out of the selection', () => {
    expect(applySessionSelection(['a', 'b'], { kind: 'toggle', id: 'a' })).toEqual(['b']);
  });

  it('shift click replaces the selection with the range', () => {
    expect(
      applySessionSelection(['x', 'y'], { kind: 'range', id: 'c', ids: ['b', 'c', 'd'], additive: false }),
    ).toEqual(['b', 'c', 'd']);
  });

  it('ctrl/cmd + shift click unions the range into the selection', () => {
    expect(
      applySessionSelection(['x'], { kind: 'range', id: 'c', ids: ['b', 'c'], additive: true }),
    ).toEqual(['x', 'b', 'c']);
  });

  it('right-click on an unselected row selects just that row', () => {
    expect(applySessionSelection(['a', 'b'], { kind: 'contextmenu', id: 'c' })).toEqual(['c']);
  });

  it('right-click on an already-selected row keeps the whole selection (bulk menu)', () => {
    expect(applySessionSelection(['a', 'b', 'c'], { kind: 'contextmenu', id: 'b' })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('sessionMenuActions', () => {
  it('single selection shows copy + rename + fork + export + archive', () => {
    expect(sessionMenuActions(1)).toEqual(['copyIds', 'rename', 'fork', 'export', 'archive']);
  });

  it('multi selection collapses to batch ops only (copy IDs + archive)', () => {
    expect(sessionMenuActions(3)).toEqual(['copyIds', 'archive']);
  });

  it('an empty selection offers no menu (defensive)', () => {
    expect(sessionMenuActions(0)).toEqual([]);
  });
});
