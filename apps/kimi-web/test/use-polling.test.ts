// apps/kimi-web/test/use-polling.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from '../src/composables/usePolling';

// usePolling binds its interval to onMounted/onBeforeUnmount, which no-op with a
// console warning outside a component; the test drives start()/stop() directly
// and silences the harmless warning.
describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches immediately on start, then on the interval', async () => {
    const fetch = vi.fn().mockResolvedValue('v1');
    const polling = usePolling(fetch, 2500);

    expect(fetch).not.toHaveBeenCalled();
    expect(polling.loading.value).toBe(true);

    polling.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(polling.loading.value).toBe(false);
    expect(polling.data.value).toBe('v1');

    await vi.advanceTimersByTimeAsync(2500);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps last data and surfaces the error when a later poll fails', async () => {
    const fetch = vi.fn().mockResolvedValueOnce('v1').mockRejectedValueOnce(new Error('boom'));
    const polling = usePolling(fetch, 2500);

    polling.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polling.data.value).toBe('v1');
    expect(polling.error.value).toBeNull();

    await vi.advanceTimersByTimeAsync(2500);
    expect(polling.error.value).toBe('boom');
    expect(polling.data.value).toBe('v1');
    expect(polling.loading.value).toBe(false);
  });

  it('sets the error and clears loading when the first fetch fails', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('down'));
    const polling = usePolling(fetch, 2500);

    polling.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(polling.error.value).toBe('down');
    expect(polling.loading.value).toBe(false);
    expect(polling.data.value).toBeNull();
  });

  it('skips an interval tick while a slow fetch is still in flight', async () => {
    const fetch = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve('slow'), 3000);
      });
    });
    const polling = usePolling(fetch, 2500);

    polling.start();
    await vi.advanceTimersByTimeAsync(0);
    // First fetch started and is still pending (resolves at t=3000).
    expect(fetch).toHaveBeenCalledTimes(1);

    // Interval fires at t=2500 while the fetch is in flight — the tick is skipped.
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Fetch resolves at t=3000; the next interval tick fetches again.
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stop clears the interval so no further polls run', async () => {
    const fetch = vi.fn().mockResolvedValue('v1');
    const polling = usePolling(fetch, 2500);

    polling.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    polling.stop();
    await vi.advanceTimersByTimeAsync(2500 * 5);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent — a second start does not double-fetch', async () => {
    const fetch = vi.fn().mockResolvedValue('v1');
    const polling = usePolling(fetch, 2500);

    polling.start();
    polling.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
