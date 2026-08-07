/**
 * Kimi Code version helpers.
 *
 * `getVersion` reads the host CLI's `package.json#version`, preferring the
 * build-time injected `KIMI_BUILD_INFO.version` when present (every packaged
 * bundle — native SEA and standalone team bundles — injects it).
 *
 * The package.json walk **degrades to `undefined`** instead of throwing: the
 * standalone team bundle is deployed without a manifest
 * (`~/.kimi-code/lib/kimi/`, launcher runs `main-team.cjs` via node), so a
 * hard throw here crashes `kimi web` startup on paths that only need a
 * best-effort package root (web assets, update-source classification). Those
 * callers fall back to `KIMI_BUILD_INFO` / `undefined` semantics instead.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createKimiUserAgent, KIMI_CODE_PLATFORM, type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

import { CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { KIMI_BUILD_INFO } from './build-info';

const MODULE_DIR = import.meta.dirname;

/**
 * Walk upwards from `startDir` (default: this file's directory) until a
 * `package.json` shows up, so dev (`tsx src/main.ts` — this file in
 * `src/cli/`, pkg 2 levels up) and the npm package (`node dist/main.mjs` —
 * code bundled into `dist/`, pkg 1 level up) resolve correctly.
 *
 * Returns `undefined` when no manifest is found within 6 levels — the
 * standalone team bundle (`~/.kimi-code/lib/kimi/`) ships without a
 * `package.json`, and callers must degrade instead of crashing.
 */
export function getHostPackageJsonPath(startDir = MODULE_DIR): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function getHostPackageRoot(startDir = MODULE_DIR): string | undefined {
  const pkgPath = getHostPackageJsonPath(startDir);
  return pkgPath === undefined ? undefined : dirname(pkgPath);
}

export function getVersion(): string {
  if (KIMI_BUILD_INFO.version !== undefined) {
    return KIMI_BUILD_INFO.version;
  }
  const pkgPath = getHostPackageJsonPath();
  if (pkgPath === undefined) {
    // Genuinely broken install: neither a build-time version nor a manifest.
    throw new Error(
      `Could not determine the Kimi Code version: no build-time version and no package.json near ${MODULE_DIR}`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}

export function createKimiCodeHostIdentity(version = getVersion()): KimiHostIdentity {
  return {
    productName: CLI_USER_AGENT_PRODUCT,
    version,
    platform: KIMI_CODE_PLATFORM,
  };
}

/**
 * Product User-Agent (`kimi-code-cli/<version>`) for ad-hoc outbound fetches
 * that don't go through the provider pipeline (registry / catalog imports).
 */
export function createKimiCodeUserAgent(version = getVersion()): string {
  return createKimiUserAgent(createKimiCodeHostIdentity(version));
}
