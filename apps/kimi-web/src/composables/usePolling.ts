// apps/kimi-web/src/composables/usePolling.ts
// Minimal interval poller for read-only right-side panels (team roster, usage).
// Start/stop are bound to the component lifecycle via onMounted/onBeforeUnmount,
// so mounting a panel starts the poll and the shared right-side `v-if` unmount
// stops it — no per-panel timer bookkeeping. One in-flight guard keeps a slow
// response from overlapping the next tick, mirroring TeamPanel's refresh().

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

export interface UsePolling<T> {
  /** Latest successfully-fetched value; null until the first success. */
  data: Ref<T | null>;
  /** True until the first fetch settles. */
  loading: Ref<boolean>;
  /** Last fetch error message (every failure), even when stale data is kept.
   *  Panels decide when to surface it — usually only while `data` is null. */
  error: Ref<string | null>;
  refresh: () => Promise<void>;
  /** Begin polling: immediate fetch, then every `intervalMs`. Bound to
   *  onMounted; exposed so tests can drive the lifecycle directly. */
  start: () => void;
  /** Stop polling and clear the interval. Bound to onBeforeUnmount. */
  stop: () => void;
}

export function usePolling<T>(fetch: () => Promise<T>, intervalMs: number): UsePolling<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(true);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      data.value = await fetch();
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      inFlight = false;
      loading.value = false;
    }
  }

  function start(): void {
    if (timer !== null) return;
    void refresh();
    timer = setInterval(() => void refresh(), intervalMs);
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  onMounted(start);
  onBeforeUnmount(stop);

  return { data, loading, error, refresh, start, stop };
}
