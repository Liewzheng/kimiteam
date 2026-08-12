// apps/kimi-web/src/composables/useContentWidthMode.ts
// Per-session chat content width: 'narrow' (default) clamps content to the
// reading column; 'wide' lets content grow to its natural width. The choice is
// isolated per session and persisted to localStorage so re-opening a session
// restores its mode. The read/write/merge logic lives in lib/storage.ts
// (loadContentWidth / saveContentWidth) so it stays unit-testable without a
// component; this composable only binds the current session id to that store.
import { computed, ref, type ComputedRef } from 'vue';
import {
  loadContentWidth,
  saveContentWidth,
  type ContentWidthMode,
} from '../lib/storage';

export interface UseContentWidthMode {
  /** Current mode for the active session; `'narrow'` when unset or sessionless. */
  mode: ComputedRef<ContentWidthMode>;
  setContentWidth: (mode: ContentWidthMode) => void;
  toggleContentWidth: () => void;
}

export function useContentWidthMode(
  sessionId: () => string | undefined,
): UseContentWidthMode {
  // In-memory copy of the persisted per-session map, kept in sync on writes.
  // Read directly from storage (not the DOM) so the same source of truth drives
  // both the initial load and any later write.
  const prefs = ref(loadContentWidth());
  const sid = computed(() => sessionId());

  const mode = computed<ContentWidthMode>(() => {
    const id = sid.value;
    return id ? (prefs.value[id] ?? 'narrow') : 'narrow';
  });

  function setContentWidth(next: ContentWidthMode): void {
    const id = sid.value;
    if (!id) return; // no session yet (empty composer) — nothing to isolate
    prefs.value = { ...prefs.value, [id]: next };
    saveContentWidth({ [id]: next });
  }

  function toggleContentWidth(): void {
    setContentWidth(mode.value === 'wide' ? 'narrow' : 'wide');
  }

  return { mode, setContentWidth, toggleContentWidth };
}
