// apps/kimi-web/src/composables/sessionDerivedCache.ts
// Per-session derived-value cache (F1: session-switch render lag).
//
// A session switch used to rebuild every derived view (`turns`, `tasks`,
// `todos`, ...) because their computeds read `activeSessionId` at the top and
// therefore invalidated on every switch — even when the newly selected
// session's data was unchanged since the last visit. The fresh objects broke
// every prop reference, so Vue re-rendered the whole ChatPane subtree on each
// switch (the KeepAlive DOM cache can't help: it caches DOM, not the derived
// arrays feeding the props).
//
// This helper caches ONE computed per session. Each session's computed reads
// ONLY that session's own reactive inputs (never `activeSessionId`), so it is
// not invalidated by a switch; switching back re-reads the cached computed and
// hands the UI the SAME array/object references, letting Vue skip the subtree
// re-render.
//
// Eviction: MRU, capped at `max`. The default matches the WS subscription cap
// (MAX_WS_SUBSCRIPTIONS = 4) / KeepAlive cap (CHAT_PANE_CACHE_MAX = 4): a
// session past the cap is cold on every layer (DOM evicted, WS cursor stale →
// snapshot rebuild), so retaining its derived array buys nothing but memory.
// The most-recently-touched session (the active one) sits at the tail and is
// never evicted while it is being read.
import { computed, type ComputedRef } from 'vue';

export function createSessionDerivedCache<T>(
  derive: (sessionId: string) => T,
  max = 4,
): (sessionId: string) => ComputedRef<T> {
  const cache = new Map<string, ComputedRef<T>>();
  const order: string[] = [];
  return (sessionId: string): ComputedRef<T> => {
    const existing = cache.get(sessionId);
    if (existing !== undefined) {
      // Touch → move to the MRU tail so the active session survives eviction.
      const idx = order.indexOf(sessionId);
      if (idx !== -1) order.splice(idx, 1);
      order.push(sessionId);
      return existing;
    }
    const ref = computed(() => derive(sessionId));
    cache.set(sessionId, ref);
    order.push(sessionId);
    while (order.length > max) {
      const victim = order.shift();
      if (victim === undefined) break;
      cache.delete(victim);
    }
    return ref;
  };
}
