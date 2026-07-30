/**
 * `agentFileCatalog` domain (L3) — user `IAgentProfileSource` producer.
 *
 * Discovers user agent profiles through `bootstrap` home paths and `hostFs`,
 * reports skipped files through `log`, and appends the `<home>/SYSTEM.md`
 * prompt-override profile (synthesized against the builtin default from the
 * App profile catalog) after the scanned profiles so it wins same-name
 * collisions within this contribution. Also exposes the effective default
 * profile — the `SYSTEM.md` override when present, else the builtin default,
 * refreshed on each `load()` pass — so every agent-file source can back
 * `${base_prompt}` with it. Bound at App scope.
 */

import { join } from 'pathe';
import fs, { type FSWatcher } from 'node:fs';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import {
  IAgentProfileCatalogService,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { discoverAgentFiles } from './agentFileDiscovery';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  profilesFromDiscovery,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from './agentProfileSource';
import { userAgentRoots } from './agentRoots';
import { loadSystemMdProfile } from './systemFile';

export interface IUserFileAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
  getDefaultProfile(): AgentProfile;
}

export const IUserFileAgentSource: ServiceIdentifier<IUserFileAgentSource> =
  createDecorator<IUserFileAgentSource>('userFileAgentSource');

export class UserFileAgentSource extends Disposable implements IUserFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.user;

  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  private defaultProfile: AgentProfile;

  /** Active watchers by directory — drives incremental updates on each load(). */
  private readonly _watchers = new Map<string, IDisposable>();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IAgentProfileCatalogService private readonly builtin: IAgentProfileCatalogService,
  ) {
    super();
    this.defaultProfile = builtin.getDefault();
  }

  getDefaultProfile(): AgentProfile {
    return this.defaultProfile;
  }

  async load(): Promise<AgentProfileContribution> {
    const roots = await userAgentRoots(
      this.fs,
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
      (message, error) => {
        this.log.warn(message, error);
      },
    );

    // Watch every root that the source actually discovers (existing dirs).
    // For candidate directories that do not exist yet we silently ignore
    // them — if they are later created by TeamHire a subsequent load() will
    // pick one up and start watching it.
    this.updateWatches([
      ...roots.map((r) => r.path),

      join(this.bootstrap.homeDir, 'agents'),
      join(this.bootstrap.osHomeDir, '.kimi-code/agents'),
    ]);

    const systemMd = await loadSystemMdProfile(
      this.fs,
      this.bootstrap.homeDir,
      this.builtin.getDefault(),
      (message) => this.log.warn(message),
    );
    this.defaultProfile = systemMd ?? this.builtin.getDefault();
    const contribution = profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
      (context) => this.defaultProfile.systemPrompt(context),
    );
    if (systemMd === undefined) return contribution;
    return { ...contribution, profiles: [...contribution.profiles, systemMd] };
  }

  // ---------------------------------------------------------------------
  // fs watch management
  // ---------------------------------------------------------------------

  private updateWatches(candidateDirs: string[]): void {
    const wanted = new Set(candidateDirs);

    // Close watchers whose directory is no longer a candidate (e.g. deleted).
    for (const [dir, disposable] of this._watchers) {
      if (!wanted.has(dir)) {
        disposable.dispose();
        this._watchers.delete(dir);
      }
    }

    for (const dir of wanted) {
      if (this._watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, () => {
          this.onDidChangeEmitter.fire();
        });
        this._watchers.set(dir, this._register({ dispose: () => watcher.close() }));
      } catch {
        // Directory does not exist or OS is unable to watch it — skip.
      }
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileAgentSource,
  UserFileAgentSource,
  ScopeActivation.OnScopeCreated,
  'agentFileCatalog',
);
