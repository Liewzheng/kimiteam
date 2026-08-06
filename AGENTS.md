# Repository-level Agent Guide

Reply in the same language as the user.

This is a TypeScript monorepo built for agent-assisted development. Keep the root `AGENTS.md` limited to hot-path rules: the project map, hard constraints, and workflow requirements — things every task needs to know.

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.

## Project Map

- `apps/kimi-code`: the CLI / TUI application. It consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must not depend directly on `@moonshot-ai/agent-core`. When writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).
- `apps/kimi-web`: the browser web UI, a peer to the TUI — Vue 3 + Vite + vue-i18n, talking to the server over REST + WebSocket under `/api/v1`. Must not depend on `@moonshot-ai/agent-core` (wire types are re-implemented locally). Debug against both engines via the root `pnpm dev:v1` / `pnpm dev:v2` backend scripts. See `apps/kimi-web/AGENTS.md`.
- `apps/vis`, `apps/vis/server`, `apps/vis/web`: visual debugging tools for sessions and replays.
- `apps/kimi-inspect`: web inspector for the kap-server `/api/v1/debug` RPC surface — workspace/session browser, per-session chat, Model Catalog, and Service panels (Session/Agent scopes). Built on its own ProxyChannel-style client (`src/channel/`) typed by agent-core-v2 Service interfaces; model resolution goes through `IModelCatalog.inspect` (kosong's resolution pass). No Service-event push channel: panels fetch/refresh on demand (15 s react-query poll); the one exception is session-level status via a second `/api/v1/ws` client (`src/activity/`). Chat renders turn-granularly from the **transcript** surface, not context memory. The Vite dev server proxies `/api` to a running kap-server (`KIMI_SERVER_URL`, default `http://127.0.0.1:58627`) and zero-config auto-connects via `GET /__inspect/servers` (`vite/serverDiscovery.ts`).
- `packages/agent-core`: the unified agent engine — Agent, Session, profile, skills, tools, plan, permission, background, records, and the in-process DI service layer (`src/services/`).
- `packages/agent-core-v2`: the DI × Scope agent engine (the v2 port behind kap-server). Four `LifecycleScope` tiers — `App` / `Workspace` / `Session` / `Agent` (`_base/di/scope.ts`); the Workspace scope owns the handler-shared resources (skills / AGENTS.md, agent profiles, MCP, fs, trust), loaded once per handler and refreshed by fs watch, consumed by sessions via seed contracts. See `packages/agent-core-v2/AGENTS.md`; use the `agent-core-dev` skill (`.agents/skills/agent-core-dev/SKILL.md`) when developing here.
- `packages/node-sdk`: the public TypeScript SDK and harness.
- `packages/kosong`: the LLM / provider abstraction layer.
- `packages/kaos`: the execution environment and file/process abstractions.
- `packages/oauth`: Kimi OAuth and managed auth utilities.
- `packages/telemetry`: shared client-side telemetry infrastructure.
- `packages/transcript`: the isomorphic transcript rendering data layer — pure TypeScript (browser-safe, no engine imports) and the sole owner of all transcript contract types (`src/contract/`); consumed by `packages/kap-server` (engine events → transcript, REST + WS). Owns the op-batch sequencing contract (`transcriptSeqSchema` in `contract/schema.ts`): a per-(session, agent) monotonic batch `seq`, the `transcript_since` cursor, and the `GET .../transcript/ops` catch-up shape. The cold rebuild is a two-level fold over `wire.jsonl` (`history/groupTurns.ts` + `history/foldFacts.ts`) with 0-based turn ordinals. Plan content is a recorded fact: ExitPlanMode submissions offload to `agents/<agentId>/plan/<planId>/v<N>.md` and persist a reference-only `plan.revision`, projected to the `modes.plan` badge. Live-projected wire details (usage / timing / retry / …) are NOT backfilled by the cold rebuild (known limitation).
- `packages/kap-server`: the Kimi Code server, backed by agent-core-v2 (DI × Scope). Exposes sessions over REST + WebSocket (`/api/v1` + `/api/v1/ws`); bootstrapped from `src/start.ts`, consumed by `apps/kimi-code`. Session routes compose `ISessionIndex` → `IWorkspaceLifecycleService.handlerFor` → the handler's `ISessionLifecycleService`; `fs:search` additionally accepts a workspace reference (registered id or absolute root) in the `{session_id}` slot (first-class form: `POST /api/v1/workspace/fs:search`). The RPC surface is `/api/v1/debug/*` — a reflection dispatcher over the ENTIRE scoped DI registry (every Service callable, no whitelist), mounted only with `--debug-endpoints` on a loopback bind behind bearer auth. Global search is `POST /api/v1/search` (cross-session full-text, `terms` / `literal` modes) backed by a minidb database at `<home>/search-index`; live sessions are served from the in-memory transcript store instead (`source: 'live' | 'index'`).
- `packages/klient`: the client SDK — a contract-driven facade over agent-core-v2 with aggregated `global.*` / `session(id).*` / `agent(id).*` methods, zod validation on every call, and klient-level typed event forwarding. Transport is chosen once at creation via subpath entry (`@moonshot-ai/klient/ipc|memory`); both return the same `Klient`. Hosts the e2e suites (legacy `/api/v1` live suites + docker e2e runner). See `packages/klient/AGENTS.md`.
- `packages/server-e2e`: live e2e tests and scenarios against a running server (`KIMI_SERVER_URL`, default `http://127.0.0.1:58627`).
- `packages/tree-sitter-bash`: a pure-TypeScript bash parser (no runtime deps, no wasm) producing tree-sitter-bash 0.25.0 named-node types with UTF-16 code-unit offsets. `parse(source, { timeoutMs, maxNodes })` runs under a deterministic budget (default 50 ms / 50k nodes); treat aborted/hasError trees as "cannot analyze". Parser only, no safety judgments. Known deviations are tracked in the package README's "Known differences" section.
- `packages/minidb`: the embedded JSON document store (`MiniDb`) behind kap-server's search index — snapshot + WAL persistence with an exclusive write lock (losers open read-only and catch up from the WAL), plus a larger-than-RAM full-text layer (`src/text-index/`): default tokenizer keeps ASCII words + CJK uni/bigrams; `src/trigram.ts` (hashed 2/3-gram) backs substring-exact search. Derived state is checkpointed as persistent index **generations** (`generations/g-NNNNNN/` + `CURRENT`); full recovery is the automatic fallback for missing/invalid generations. Heavy maintenance runs through the unified scheduler (`src/maintenance.ts` — one heavy task per db); full-text builds run off the main thread in a worker (`OpenOptions.textBuildWorker: false` rolls back to inline). Text-index definitions persist in `db.textindexes.json`.

## Environment Requirements

- **Node.js**: `>=24.15.0` (from the root `package.json` `engines`; `.nvmrc` is `24.15.0`, used by nvm / fnm / mise to pick the minimum recommended version).
- **pnpm**: `10.33.0` (from the root `package.json` `packageManager`).
- `pnpm install` will fail when the Node version is not satisfied, because `.npmrc` sets `engine-strict=true`.

## Monorepo Workspace Maintenance

- `pnpm-workspace.yaml` is the source of truth for workspace membership, but `flake.nix` also contains **hardcoded** `workspacePaths` and `workspaceNames` lists.
- **Whenever you add or remove a workspace package, you MUST update both `pnpm-workspace.yaml` and `flake.nix` — for every package, including leaf / test / e2e packages that nothing depends on.**
  - `pnpm-workspace.yaml` uses globs (`packages/*`, `apps/*`), so most packages land there automatically; `flake.nix` is fully manual and is where omissions happen.
  - Missing a path in `flake.nix`'s `workspacePaths` will silently drop files from the Nix build's `src` fileset.
  - Missing a name in `flake.nix`'s `workspaceNames` will break `pnpmConfigHook` because dependencies for that workspace will not be fetched.
- The automated "Check flake.nix workspace sync" (`scripts/check-nix-workspace.mjs`) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A leaf package outside that closure (e.g. an e2e package nobody imports) slips through even when it is missing from `flake.nix`. A green check is therefore NOT proof that `flake.nix` is fully in sync — keep it updated by hand on every add/remove, do not rely on the check to catch omissions.

## General Coding Rules

- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- The `Agent` class in `packages/agent-core/src/agent` must be usable on its own. The constructor must not force the caller to create a `Session` instance, nor require an `agentId` or `session`. It may accept an optional `sessionId` as a request-config hint — for example mapped to the provider's `prompt_cache_key` — but the instance must not hold `sessionId`, and must not depend on the Session lifecycle, metadata, or parent/child relationship logic.
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it. Breaking changes go through changesets and a `major` bump, gated by the rule below.

## Experimental Features

- Gate a not-yet-public feature behind an experimental flag. Add the flag to the registry at `packages/agent-core/src/flags/registry.ts`, then check it with `flags.enabled('my-feature')`. Flags are env-driven and default off: `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one, `KIMI_CODE_EXPERIMENTAL_FLAG` enables all. Release by flipping the entry's `default` to `true`.

## Where to Update Instructions

- Hard rules that affect almost every task: update the root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md`.
- Keep instruction updates focused and supported by code facts.

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- When creating a PR, the PR title must follow Conventional Commit style, e.g. `chore: remove legacy format commands`.
- When an AI agent opens or updates a PR, fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic summary of the diff.
- Do not submit vague AI-generated PR text. The human author must understand the change well enough to explain the code, edge cases, and why the approach fits this repository.
- After finishing a task and before submitting a PR, you must run the `gen-changesets` skill (see `.agents/skills/gen-changesets/SKILL.md`) and generate a changeset under `.changeset/` according to its rules.
- When generating a changeset, **never** decide on a `major` bump on your own. When you judge a change to meet the major criteria (breaking changes, incompatible user configuration, renamed or removed commands/arguments, changed behavior semantics, etc.), you must stop and explain it to the user and ask for confirmation. **Only write `major` after the user has explicitly agreed.** Otherwise default to `minor` (and fall back to `patch` if `minor` is unclear). See the "Hard rule: confirm with the user before writing `major`" section in `.agents/skills/gen-changesets/SKILL.md` for details.
- Prefer importing via `import ... from '#/...'`, which serves the same purpose as `import ... from '@/...'`.
- Do not commit throwaway scratch or exploratory files. Never stage:
  - Agent working notes or handoff/summary documents (e.g. `HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`).
  - Throwaway UI/UX prototypes or design mockups (e.g. `*-designs.html`, `*-mockup.html`, `*-demo(s).html`) at the repo root or under a `design/` folder. The only tracked `.html` files should be Vite `index.html` entrypoints.
  Before committing or opening a PR, run `git status` and `git diff --staged --stat` and remove anything matching these patterns. Put scratch work under `.tmp/` (gitignored) instead of the repo root or the source tree.
