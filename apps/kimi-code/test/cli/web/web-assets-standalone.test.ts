import { describe, expect, it, vi } from 'vitest';

/**
 * Standalone team bundle (`~/.kimi-code/lib/kimi/`, launcher runs
 * `main-team.cjs` via node): no package.json anywhere near the bundle, so
 * `getHostPackageRoot()` degrades to `undefined`. The `kimi web` startup must
 * not crash on the missing manifest — it falls back to an API-only server.
 */
vi.mock('#/cli/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/version')>();
  return { ...actual, getHostPackageRoot: () => undefined };
});

import { resolveServerWebAssetsDir, serverWebAssetsDir } from '#/cli/sub/web/run';

describe('web assets dir for a standalone bundle without package.json', () => {
  it('resolves no assets dir when neither SEA assets nor a package root exist', () => {
    expect(resolveServerWebAssetsDir(null)).toBeUndefined();
  });

  it('serverWebAssetsDir returns undefined (API-only server) without a package root', () => {
    expect(serverWebAssetsDir({}, null)).toBeUndefined();
    expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, null)).toBeUndefined();
  });
});
