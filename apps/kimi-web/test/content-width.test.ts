// apps/kimi-web/test/content-width.test.ts
// Per-session content width (narrow/wide): storage parsing/merge in
// lib/storage.ts and the session-binding composable in useContentWidthMode.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ref, type Ref } from 'vue';
import {
  loadContentWidth,
  saveContentWidth,
  STORAGE_KEYS,
} from '../src/lib/storage';
import { useContentWidthMode } from '../src/composables/useContentWidthMode';

function setup(sessionId: Ref<string | undefined>) {
  return useContentWidthMode(() => sessionId.value);
}

// The vitest (node) environment has no localStorage; stub one backed by a Map
// so the storage layer and the composable are exercised like in the browser.
// Same pattern as input-history.test.ts.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => {
      map.clear();
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

let original: Storage | undefined;

beforeEach(() => {
  original = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (original === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});

describe('loadContentWidth', () => {
  it('returns an empty map when nothing is stored', () => {
    expect(loadContentWidth()).toEqual({});
  });

  it('returns an empty map for invalid JSON or non-object values', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.contentWidth, 'not-json');
    expect(loadContentWidth()).toEqual({});
    globalThis.localStorage.setItem(STORAGE_KEYS.contentWidth, '["wide"]');
    expect(loadContentWidth()).toEqual({});
    globalThis.localStorage.setItem(STORAGE_KEYS.contentWidth, '42');
    expect(loadContentWidth()).toEqual({});
  });

  it('keeps only narrow/wide entries and drops unknown values', () => {
    globalThis.localStorage.setItem(
      STORAGE_KEYS.contentWidth,
      JSON.stringify({ a: 'wide', b: 'narrow', c: 'huge', d: true, e: 1 }),
    );
    expect(loadContentWidth()).toEqual({ a: 'wide', b: 'narrow' });
  });
});

describe('saveContentWidth', () => {
  it('merges onto the stored map instead of replacing it', () => {
    saveContentWidth({ a: 'wide' });
    saveContentWidth({ b: 'narrow' });
    expect(loadContentWidth()).toEqual({ a: 'wide', b: 'narrow' });
  });

  it('deletes the session entry when the value is undefined', () => {
    saveContentWidth({ a: 'wide', b: 'narrow' });
    saveContentWidth({ a: undefined });
    expect(loadContentWidth()).toEqual({ b: 'narrow' });
  });
});

describe('useContentWidthMode', () => {
  it('defaults to narrow for a session with no stored preference', () => {
    const sid = ref('s1');
    const cw = setup(sid);
    expect(cw.mode.value).toBe('narrow');
  });

  it('loads the stored preference for the active session', () => {
    saveContentWidth({ s1: 'wide' });
    const sid = ref('s1');
    const cw = setup(sid);
    expect(cw.mode.value).toBe('wide');
  });

  it('switching sessions switches to that session’s stored preference', () => {
    saveContentWidth({ s1: 'wide', s2: 'narrow' });
    const sid = ref('s1');
    const cw = setup(sid);
    expect(cw.mode.value).toBe('wide');
    sid.value = 's2';
    expect(cw.mode.value).toBe('narrow');
    sid.value = 's1';
    expect(cw.mode.value).toBe('wide');
  });

  it('persists a set mode for the active session only', () => {
    const sid = ref('s1');
    const cw = setup(sid);
    cw.setContentWidth('wide');
    expect(cw.mode.value).toBe('wide');
    expect(loadContentWidth()).toEqual({ s1: 'wide' });
  });

  it('toggles between narrow and wide and back', () => {
    const sid = ref('s1');
    const cw = setup(sid);
    cw.toggleContentWidth();
    expect(cw.mode.value).toBe('wide');
    cw.toggleContentWidth();
    expect(cw.mode.value).toBe('narrow');
    expect(loadContentWidth()).toEqual({ s1: 'narrow' });
  });

  it('does not persist without a session id and stays narrow', () => {
    const sid = ref<string | undefined>(undefined);
    const cw = setup(sid);
    cw.setContentWidth('wide');
    expect(cw.mode.value).toBe('narrow');
    expect(loadContentWidth()).toEqual({});
  });
});
