#!/bin/sh
# uninstall-kimiteam.sh — POSIX-sh uninstaller for the kimiteam CLI bundle.
#
# Removes all program files introduced by install-kimiteam.sh.  Shared
# personal data under ~/.kimi-code is NEVER touched (see RED LINE below).
#
# Behaviour depends on whether the official `kimi` CLI is also installed:
#   - Official kimi present → only kimiteam program files are removed;
#     the official `kimi` binary and all shared data remain untouched.
#   - Official kimi absent   → kimiteam program files are removed AND
#     any now-empty subdirectories (bin/, lib/kimi/, lib/) are cleaned up.
#     Shared personal data is still NEVER touched.
#
# In both branches, main-team.cjs.bak-* backups are treated as program files
# and are always removed (they are re-creatable by re-installing).
#
# Usage:
#   bash scripts/uninstall-kimiteam.sh
#
# Remote (curl-to-bash, symmetric with install):
#   bash <(curl -fsSL https://raw.githubusercontent.com/Liewzheng/kimi-code/feat/subagent-team/scripts/uninstall-kimiteam.sh)

set -eu

# ---------------------------------------------------------------------------
# RED LINE — NEVER touch the official kimi installation or shared data
# ---------------------------------------------------------------------------
# This script ONLY removes files that install-kimiteam.sh introduced:
#   ~/.kimi-code/bin/kimiteam
#   ~/.kimi-code/lib/kimi/main-team.cjs
#   ~/.kimi-code/lib/kimi/main-team.cjs.sha256
#   ~/.kimi-code/lib/kimi/main-team.cjs.bak-*
#
# It MUST NOT read, write, or delete:
#   ~/.kimi-code/bin/kimi           — official launcher
#   ~/.kimi-code/lib/kimi/main.cjs  — official bundle
#   ~/.kimi-code/config.toml        — shared configuration
#   ~/.kimi-code/sessions/          — shared session data
#   ~/.kimi-code/agents/            — shared agent data
#   ~/.kimi-code/memory/            — shared memory data
#   ~/.kimi-code/server/            — shared server data
#   ~/.kimi-code/plugins/           — shared plugin data
#   ~/.kimi-code/search-index/      — shared search index
#   any other file or directory under ~/.kimi-code not listed above
# ---------------------------------------------------------------------------

KIMI_CODE_HOME="${HOME}/.kimi-code"
LIB_DIR="${KIMI_CODE_HOME}/lib/kimi"
BIN_DIR="${KIMI_CODE_HOME}/bin"

LAUNCHER="${BIN_DIR}/kimiteam"
BUNDLE="${LIB_DIR}/main-team.cjs"
SHA256="${LIB_DIR}/main-team.cjs.sha256"

# ---------------------------------------------------------------------------
# Detect whether the official kimi CLI is installed
# ---------------------------------------------------------------------------
has_official_kimi=false
if [ -f "${BIN_DIR}/kimi" ] || [ -f "${LIB_DIR}/main.cjs" ]; then
  has_official_kimi=true
fi

# ---------------------------------------------------------------------------
# Remove kimiteam-specific program files (idempotent — skip if absent)
# ---------------------------------------------------------------------------
found_any=false

if [ -f "${LAUNCHER}" ]; then
  rm -f "${LAUNCHER}"
  echo "Removed: ${LAUNCHER}"
  found_any=true
fi

if [ -f "${BUNDLE}" ]; then
  rm -f "${BUNDLE}"
  echo "Removed: ${BUNDLE}"
  found_any=true
fi

if [ -f "${SHA256}" ]; then
  rm -f "${SHA256}"
  echo "Removed: ${SHA256}"
  found_any=true
fi

# Always remove backup files (treated as program artifacts, not user data)
backup_count=0
if [ -d "${LIB_DIR}" ]; then
  for bk in "${LIB_DIR}/main-team.cjs.bak-"*; do
    [ -f "${bk}" ] || continue
    rm -f "${bk}"
    echo "Removed: ${bk}"
    backup_count=$((backup_count + 1))
    found_any=true
  done
fi

# ---------------------------------------------------------------------------
# Nothing was found — report and exit
# ---------------------------------------------------------------------------
if [ "${found_any}" = false ]; then
  echo "kimiteam is not installed (no files found under ${KIMI_CODE_HOME})."
  exit 0
fi

# ---------------------------------------------------------------------------
# Directory cleanup (only when official kimi is absent)
# ---------------------------------------------------------------------------
if [ "${has_official_kimi}" = false ]; then
  # Remove empty subdirectories that were left behind.
  # rmdir silently does nothing if the directory is not empty.
  rmdir "${LIB_DIR}" 2>/dev/null || true
  rmdir "${KIMI_CODE_HOME}/lib" 2>/dev/null || true
  rmdir "${BIN_DIR}" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Done — branch-specific summary
# ---------------------------------------------------------------------------
echo ""
if [ "${has_official_kimi}" = true ]; then
  echo "Uninstall complete. The official 'kimi' CLI is unaffected and can"
  echo "continue to be used as normal."
else
  echo "Uninstall complete. kimiteam program files have been removed."
  echo "Your personal data remains at:"
  echo "  ${KIMI_CODE_HOME}"
  echo "(config.toml, sessions/, agents/, memory/, server/, etc.)"
  echo ""
  echo "You may re-install kimiteam (or the official kimi) later to"
  echo "reuse this data."
fi

# ---------------------------------------------------------------------------
# PATH reminder (informational only — never modify user's profile)
# ---------------------------------------------------------------------------
case ":${PATH:-}:" in
  *:"${BIN_DIR}":*)
    echo ""
    echo "NOTE: ${BIN_DIR} is still in your PATH."
    echo "If you previously added it for kimiteam, you may remove the"
    echo "following line from your shell profile (~/.zshrc, ~/.bashrc, etc.):"
    echo ""
    echo "  export PATH=\"\${HOME}/.kimi-code/bin:\${PATH}\""
    echo ""
    echo "This step is optional — leaving it does no harm, but 'kimiteam'"
    echo "will no longer be found after uninstall (which is the intended"
    echo "result)."
    ;;
esac
