---
"@moonshot-ai/kimi-code": patch
---

Harden `scripts/team-worktree.sh` against identifier injection: validate `member`/`slug` (and `name` in merge/clean/reap) against `^[a-z0-9][a-z0-9-]*$` at every subcommand entry point so a value like `../../evil` or `foo;x` can no longer escape `.worktrees/` or reach a shell/path splice, and reject surplus arguments (e.g. `merge a b`) instead of silently swallowing them. Sync the team-worktree SKILL.md parameter rule to match.
