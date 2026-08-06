// apps/kimi-web/src/lib/sessionSelection.ts
// Pure session multi-select + context-menu model for the sidebar. No Vue, no
// i18n — the component resolves labels and applies the returned id set.
//
// Selection semantics (file-manager style, consistent with the chat list):
//   - plain click            → selection = { clicked }, and the session opens
//   - Ctrl/Cmd + click       → toggle the clicked session in/out of selection
//   - Shift + click          → selection = the range from the anchor to the
//                              clicked session (within a workspace group's
//                              visible order); Ctrl/Cmd+Shift adds the range
//   - right-click on a row   → if the row is already selected, keep the whole
//                              selection (bulk menu); otherwise select just it

export type SessionSelectionAction =
  | { kind: 'select'; id: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'range'; id: string; ids: string[]; additive: boolean }
  | { kind: 'contextmenu'; id: string };

/** The ids strictly between `anchorId` and `targetId` in `orderedIds`, both
 *  inclusive. When either endpoint is missing from the list (e.g. a Shift+click
 *  whose anchor lives in another workspace group), falls back to just the
 *  target so the click still selects something predictable. */
export function sessionRange(orderedIds: string[], anchorId: string, targetId: string): string[] {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (a === -1 || b === -1) return [targetId];
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return orderedIds.slice(start, end + 1);
}

/** Apply a selection action to the previous id set, returning the next set.
 *  Non-mutating (returns a new array). */
export function applySessionSelection(
  prev: readonly string[],
  action: SessionSelectionAction,
): string[] {
  switch (action.kind) {
    case 'select':
      return [action.id];
    case 'toggle': {
      const set = new Set(prev);
      if (set.has(action.id)) set.delete(action.id);
      else set.add(action.id);
      return [...set];
    }
    case 'range': {
      const set = new Set(action.additive ? prev : []);
      for (const id of action.ids) set.add(id);
      return [...set];
    }
    case 'contextmenu':
      return prev.includes(action.id) ? [...prev] : [action.id];
  }
}

/** Context-menu item keys for a selection of `selectedCount` rows. Copy-ID and
 *  archive apply to any non-empty selection; rename/fork/export are single-row
 *  operations and only show when exactly one session is selected. */
export type SessionMenuActionKey = 'copyIds' | 'rename' | 'fork' | 'export' | 'archive';

export function sessionMenuActions(selectedCount: number): SessionMenuActionKey[] {
  if (selectedCount <= 0) return [];
  const items: SessionMenuActionKey[] = ['copyIds'];
  if (selectedCount === 1) items.push('rename', 'fork', 'export');
  items.push('archive');
  return items;
}
