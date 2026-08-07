#!/bin/sh
# scripts/team-worktree.sh — team-mode worktree lifecycle (POSIX sh, set -eu).
#
# Single source of spec: .tmp/team-worktree-design-20260807.md (§B.1 + 补遗).
# Every command first resolves MAIN_ROOT from `git worktree list --porcelain`
# (first entry = the main tree) and asserts the main tree is on
# `feat/subagent-team`, so a worktree batch can never be driven from the wrong
# baseline. Exit codes: 0 ok / 1 usage / 2 precheck failed / 3 merge conflict
# bounced. The registry at $MAIN_ROOT/.tmp/team-worktrees.json is append-only
# JSONL (one status-transition row per event; current state = last row per name).

set -eu

usage() {
  cat <<'EOF'
usage: sh scripts/team-worktree.sh <command> [args]

team-mode worktree lifecycle. Must be run from the main tree, which must be on
branch feat/subagent-team.

commands:
  create <member> <slug> [--no-install]
      Create .worktrees/<member>-<slug>-<YYYYMMDD> on branch team/<name>.
      Runs `pnpm -C <dir> install --frozen-lockfile --prefer-offline` unless
      --no-install is given (times it), then prints the dispatch worktree
      section template (§A.2) and appends a registry row (status: active).
      Prechecks: slug must match ^[a-z0-9-]+$ and be <= 40 chars (exit 1);
      existing dir / existing branch abort with exit 2 (pick another slug).
  merge <name>
      Precheck main tree clean (hard abort exit 2), worktree clean, branch
      exists, then `git merge --no-ff --no-edit team/<name>`. On conflict:
      `git merge --abort`, print conflicting files, exit 3. On success appends
      a registry row (status: merged).
  clean <name>
      Remove the worktree and delete the branch, only when the branch is merged
      into HEAD and the worktree is clean. Unmerged / dirty -> exit 2 (use reap).
  reap <name> [--keep-branch] [--yes]
      Archive unmerged commits, force-remove the worktree and delete the branch
      (--keep-branch keeps the branch). Without --keep-branch an explicit --yes
      is required (exit 1 otherwise). Appends a registry row (status: reaped).
  list
      `git worktree list`, plus a table of team/* branches joined with the
      registry: name | member | todo_id | status | ahead | last_commit.

environment:
  WORKTREE_TODO_ID   optional; when set, create records it in the registry row.

exit codes: 0 ok / 1 usage / 2 precheck failed / 3 merge conflict bounced.
EOF
}

json_escape() {
  sed 's/\\/\\\\/g; s/"/\\"/g'
}

reg_append() {
  mkdir -p "$MAIN_ROOT/.tmp"
  printf '%s\n' "$1" >> "$REGISTRY"
}

iso_now() {
  date '+%Y-%m-%dT%H:%M:%S%z' | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
}

cmd_create() {
  member="${1:-}"
  slug="${2:-}"
  extra="${3:-}"
  if [ -z "$member" ] || [ -z "$slug" ]; then
    echo "error: create requires <member> <slug>" >&2
    exit 1
  fi
  if [ -n "$extra" ] && [ "$extra" != "--no-install" ]; then
    echo "error: unknown create option '$extra' (only --no-install)" >&2
    exit 1
  fi
  case "$slug" in
    *[!a-z0-9-]*)
      echo "error: slug '$slug' must match ^[a-z0-9-]+$" >&2
      exit 1
      ;;
  esac
  if [ "${#slug}" -gt 40 ]; then
    echo "error: slug too long (${#slug} > 40 characters)" >&2
    exit 1
  fi

  name="${member}-${slug}-$(date +%Y%m%d)"
  branch="team/$name"
  dir="$MAIN_ROOT/.worktrees/$name"

  if [ -e "$dir" ]; then
    echo "error: worktree dir already exists: $dir (pick a different slug)" >&2
    exit 2
  fi
  if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "error: branch already exists: $branch (pick a different slug)" >&2
    exit 2
  fi

  git -C "$MAIN_ROOT" worktree add "$dir" -b "$branch"

  if [ "$extra" = "--no-install" ]; then
    echo "install: skipped (--no-install)"
  else
    if ! command -v pnpm >/dev/null 2>&1; then
      echo "error: pnpm not found on PATH; cannot install (worktree left in place)" >&2
      exit 1
    fi
    echo "install: pnpm -C $dir install --frozen-lockfile --prefer-offline"
    t0="$(date +%s)"
    if ! pnpm -C "$dir" install --frozen-lockfile --prefer-offline; then
      echo "error: pnpm install failed (worktree left in place for retry)" >&2
      exit 1
    fi
    t1="$(date +%s)"
    echo "install: finished in $((t1 - t0))s"
  fi

  todo_id="${WORKTREE_TODO_ID:-}"
  install_json="false"
  [ "$extra" != "--no-install" ] && install_json="true"
  row="{\"name\":\"$name\",\"branch\":\"$branch\",\"dir\":\".worktrees/$name\","
  row="$row\"member\":\"$(printf '%s' "$member" | json_escape)\",\"slug\":\"$slug\""
  if [ -n "$todo_id" ]; then
    row="$row,\"todo_id\":\"$(printf '%s' "$todo_id" | json_escape)\""
  fi
  row="$row,\"install\":$install_json,\"status\":\"active\",\"created_at\":\"$(iso_now)\"}"
  reg_append "$row"

  echo "created worktree: $dir (branch $branch)"
  echo
  cat <<EOF
【工作树】你的独立工作树：${dir}（分支 ${branch}）
- 全程且仅在该路径内操作：Bash 每次调用必须传 cwd=${dir}；Read/Edit/Write/Glob/Grep 一律用该路径开头的绝对路径。
- 禁止读写主树 ${MAIN_ROOT} 下不属于你工作树的任何文件；git 命令只在你工作树内执行。
- 系统提示中的 git 状态/目录列表以主树为准，忽略它，以你的工作树为准。
- 红线：禁止安装构建链任何步骤（build:packages、kimi-web build、copy-web-assets、build:native、install-kimiteam、写 ~/.kimi-code）；禁止起常驻服务/占端口（dev:kap-server 等），验证只跑 vitest 单次 / tsc --noEmit。
- 完工定义：改动 git commit 到本分支（conventional commit，无 co-author），git status 干净；如改动用户可感知，已按 gen-changesets 生成 .changeset/${slug}.md 并一并提交。
EOF
}

cmd_merge() {
  name="${1:-}"
  if [ -z "$name" ]; then
    echo "error: merge requires <name>" >&2
    exit 1
  fi
  branch="team/$name"
  dir="$MAIN_ROOT/.worktrees/$name"

  if [ -n "$(git -C "$MAIN_ROOT" status --porcelain)" ]; then
    echo "error: main tree is dirty — refusing to merge (commit/stash first)" >&2
    exit 2
  fi
  if [ -d "$dir" ] && [ -n "$(git -C "$dir" status --porcelain 2>/dev/null || true)" ]; then
    echo "error: worktree $dir is dirty — clean it first" >&2
    exit 2
  fi
  if ! git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "error: branch not found: $branch" >&2
    exit 2
  fi

  if ! git -C "$MAIN_ROOT" merge --no-ff --no-edit "$branch"; then
    if git -C "$MAIN_ROOT" diff --quiet --diff-filter=U --; then
      git -C "$MAIN_ROOT" merge --abort 2>/dev/null || true
      echo "error: merge failed (non-conflict); merge aborted" >&2
      exit 3
    fi
    conflicts="$(git -C "$MAIN_ROOT" diff --name-only --diff-filter=U --)"
    git -C "$MAIN_ROOT" merge --abort
    echo "merge conflict — aborted. Conflicting files:"
    printf '%s\n' "$conflicts"
    exit 3
  fi

  merge_sha="$(git -C "$MAIN_ROOT" rev-parse HEAD)"
  reg_append "{\"name\":\"$name\",\"status\":\"merged\",\"merged_at\":\"$(iso_now)\",\"merge_sha\":\"$merge_sha\"}"
  echo "merged team/$name into main tree ($merge_sha)"
}

cmd_clean() {
  name="${1:-}"
  if [ -z "$name" ]; then
    echo "error: clean requires <name>" >&2
    exit 1
  fi
  branch="team/$name"
  dir="$MAIN_ROOT/.worktrees/$name"

  if ! git -C "$MAIN_ROOT" merge-base --is-ancestor "$branch" HEAD; then
    echo "error: branch $branch is not merged into HEAD — refusing to clean (use reap)" >&2
    exit 2
  fi
  if [ -d "$dir" ] && [ -n "$(git -C "$dir" status --porcelain 2>/dev/null || true)" ]; then
    echo "error: worktree $dir is dirty — commit/stash it, or reap" >&2
    exit 2
  fi

  if [ -d "$dir" ]; then
    git -C "$MAIN_ROOT" worktree remove "$dir"
    echo "cleaned: removed worktree $dir"
  fi
  if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$MAIN_ROOT" branch -d "$branch"
    echo "cleaned: deleted branch $branch"
  fi
}

cmd_reap() {
  name="${1:-}"
  if [ -z "$name" ]; then
    echo "error: reap requires <name>" >&2
    exit 1
  fi
  shift
  keep=0
  yes=0
  for arg in "$@"; do
    case "$arg" in
      --keep-branch) keep=1 ;;
      --yes) yes=1 ;;
      *)
        echo "error: unknown reap option '$arg' (use --keep-branch / --yes)" >&2
        exit 1
        ;;
    esac
  done

  branch="team/$name"
  dir="$MAIN_ROOT/.worktrees/$name"

  echo "reap $name: archiving unmerged commits (feat/subagent-team..$branch):"
  git -C "$MAIN_ROOT" log --oneline "feat/subagent-team..$branch" 2>/dev/null || true

  if [ "$keep" = 0 ] && [ "$yes" != 1 ]; then
    echo "error: reap without --keep-branch requires explicit --yes (force-removes the worktree and deletes branch $branch)" >&2
    exit 1
  fi

  if [ -d "$dir" ]; then
    git -C "$MAIN_ROOT" worktree remove --force "$dir"
    echo "reap: removed worktree $dir"
  else
    echo "reap: worktree $dir already absent"
  fi
  if [ "$keep" = 1 ]; then
    echo "reap: kept branch $branch (cherry-pick to salvage)"
  else
    if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$MAIN_ROOT" branch -D "$branch"
      echo "reap: deleted branch $branch"
    else
      echo "reap: branch $branch already absent"
    fi
  fi

  reg_append "{\"name\":\"$name\",\"status\":\"reaped\",\"reaped_at\":\"$(iso_now)\",\"keep_branch\":$keep}"
  echo "reap: registry updated (status reaped)"
}

cmd_list() {
  echo "== git worktree list =="
  git -C "$MAIN_ROOT" worktree list
  echo
  echo "== team/* branches joined with registry =="
  printf '%-42s | %-8s | %-7s | %-12s | %-5s | %s\n' name member todo_id status ahead last_commit

  rows_tmp="/tmp/team-worktree-rows.$$"
  names_tmp="/tmp/team-worktree-names.$$"
  : > "$rows_tmp"
  : > "$names_tmp"
  trap 'rm -f "$rows_tmp" "$names_tmp"' EXIT

  if [ -f "$REGISTRY" ]; then
    awk '
      {
        if (match($0, /"name":"[^"]*"/)) {
          name = substr($0, RSTART + 8, RLENGTH - 9)
          if (!(name in seen)) { seq[++c] = name; seen[name] = 1 }
          if (match($0, /"status":"[^"]*"/)) status[name] = substr($0, RSTART + 10, RLENGTH - 11)
          if (match($0, /"status":"active"/)) {
            if (match($0, /"member":"[^"]*"/)) member[name] = substr($0, RSTART + 10, RLENGTH - 11)
            if (match($0, /"todo_id":"[^"]*"/)) todo[name] = substr($0, RSTART + 11, RLENGTH - 12)
          }
        }
      }
      END {
        for (i = 1; i <= c; i++) {
          n = seq[i]
          print n "\t" (status[n] != "" ? status[n] : "?") "\t" (member[n] != "" ? member[n] : "-") "\t" (todo[n] != "" ? todo[n] : "-")
        }
      }
    ' "$REGISTRY" > "$rows_tmp"
    awk -F'\t' '{ print $1 }' "$rows_tmp" > "$names_tmp"

    while IFS="$(printf '\t')" read -r name status member todo; do
      [ -n "$name" ] || continue
      branch="team/$name"
      ahead="-"
      last="-"
      if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
        ahead="$(git -C "$MAIN_ROOT" rev-list --count "feat/subagent-team..$branch" 2>/dev/null || true)"
        last="$(git -C "$MAIN_ROOT" log -1 --format=%cs "$branch" 2>/dev/null || true)"
      fi
      printf '%-42s | %-8s | %-7s | %-12s | %-5s | %s\n' "$name" "$member" "$todo" "$status" "$ahead" "$last"
    done < "$rows_tmp"
  fi

  for branch in $(git -C "$MAIN_ROOT" for-each-ref --format='%(refname:short)' refs/heads/team/); do
    bname="${branch#team/}"
    if ! grep -qxF "$bname" "$names_tmp" 2>/dev/null; then
      ahead="$(git -C "$MAIN_ROOT" rev-list --count "feat/subagent-team..$branch" 2>/dev/null || true)"
      last="$(git -C "$MAIN_ROOT" log -1 --format=%cs "$branch" 2>/dev/null || true)"
      printf '%-42s | %-8s | %-7s | %-12s | %-5s | %s\n' "$bname" "-" "-" "unregistered" "$ahead" "$last"
    fi
  done

  rm -f "$rows_tmp" "$names_tmp"
  trap - EXIT
}

cmd="${1:-}"
case "$cmd" in
  '' | -h | --help)
    usage
    exit 1
    ;;
esac

MAIN_ROOT="$(git worktree list --porcelain 2>/dev/null | head -1 | cut -d' ' -f2)"
if [ -z "$MAIN_ROOT" ]; then
  echo "error: cannot resolve the main tree root (run from inside the repo)" >&2
  exit 1
fi
REGISTRY="$MAIN_ROOT/.tmp/team-worktrees.json"

current="$(git -C "$MAIN_ROOT" branch --show-current 2>/dev/null || true)"
if [ "$current" != "feat/subagent-team" ]; then
  echo "error: main tree must be on branch 'feat/subagent-team' (found '${current:-detached}')" >&2
  exit 2
fi

shift
case "$cmd" in
  create) cmd_create "$@" ;;
  merge) cmd_merge "$@" ;;
  clean) cmd_clean "$@" ;;
  reap) cmd_reap "$@" ;;
  list) cmd_list ;;
  *)
    echo "error: unknown command '$cmd'" >&2
    usage
    exit 1
    ;;
esac
