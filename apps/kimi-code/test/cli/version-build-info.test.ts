import { describe, expect, it, vi } from 'vitest';

/**
 * A packaged bundle (native SEA, standalone team bundle) injects the version
 * at build time via `__KIMI_CODE_VERSION__`. `getVersion` must prefer that
 * over a runtime package.json lookup — the standalone team bundle ships
 * without a package.json (`~/.kimi-code/lib/kimi/`).
 */
vi.mock('#/cli/build-info', () => ({
  KIMI_BUILD_INFO: {
    version: '9.9.9-team',
    channel: 'team',
    commit: 'abc123',
    buildTarget: 'win32-x64',
  },
}));

import { getVersion } from '#/cli/version';

describe('getVersion with build-time injected version', () => {
  it('prefers KIMI_BUILD_INFO.version and never touches the filesystem', () => {
    expect(getVersion()).toBe('9.9.9-team');
  });
});
