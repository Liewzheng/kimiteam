import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createKimiCodeUserAgent,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/kimi-code and reads its version', () => {
    const pkgPath = getHostPackageJsonPath();
    if (pkgPath === undefined) {
      throw new Error('expected a package.json in the repo tree');
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(pkgPath.endsWith(join('apps', 'kimi-code', 'package.json'))).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(pkgPath));
    expect(getVersion()).toBe(pkg.version);
  });

  it('degrades to undefined when no package.json exists up the tree (standalone bundle)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-no-pkg-'));
    try {
      expect(getHostPackageJsonPath(dir)).toBeUndefined();
      expect(getHostPackageRoot(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks up from startDir to locate a nested package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-pkg-'));
    try {
      const pkgDir = join(dir, 'a', 'b');
      mkdirSync(pkgDir, { recursive: true });
      const pkgPath = join(pkgDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ version: '9.9.9-test' }));

      const startDir = join(dir, 'a', 'b', 'src', 'cli');
      expect(getHostPackageJsonPath(startDir)).toBe(pkgPath);
      expect(getHostPackageRoot(startDir)).toBe(pkgDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds the product user-agent for ad-hoc fetches', () => {
    expect(createKimiCodeUserAgent('1.2.3')).toBe('kimi-code-cli/1.2.3');
  });
});
