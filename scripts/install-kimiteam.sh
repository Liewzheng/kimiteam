#!/bin/sh
# install-kimiteam.sh — POSIX-sh one-shot installer for the kimiteam CLI bundle.
#
# Downloads the latest kimiteam-dev rolling release from GitHub and sets it up
# alongside the official `kimi` CLI.  The official `kimi` binary and its
# `lib/kimi/main.cjs` bundle are NEVER touched (see RED LINE below).
#
# Usage:
#   bash scripts/install-kimiteam.sh
#
# Requires: node >= 24, curl.

set -eu

# ---------------------------------------------------------------------------
# RED LINE — NEVER touch the official kimi installation
# ---------------------------------------------------------------------------
# This script ONLY manages:
#   ~/.kimi-code/bin/kimiteam          (the team-build launcher)
#   ~/.kimi-code/lib/kimi/main-team.cjs (the team-build CJS bundle)
#
# It MUST NOT read, write, or delete:
#   ~/.kimi-code/bin/kimi
#   ~/.kimi-code/lib/kimi/main.cjs
# ---------------------------------------------------------------------------

REPO="Liewzheng/kimi-code"
RELEASE="kimiteam-dev"
BASE_URL="https://github.com/${REPO}/releases/download/${RELEASE}"

INSTALL_DIR="${HOME}/.kimi-code"
LIB_DIR="${INSTALL_DIR}/lib/kimi"
BIN_DIR="${INSTALL_DIR}/bin"

BUNDLE_NAME="main-team.cjs"
BUNDLE_PATH="${LIB_DIR}/${BUNDLE_NAME}"
SHA256_FILE="main-team.cjs.sha256"
LAUNCHER_PATH="${BIN_DIR}/kimiteam"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

# Check for node (must be >= 24)
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 'node' not found in PATH." >&2
  echo "Please install Node.js >= 24 from https://nodejs.org/ or via your package manager." >&2
  exit 1
fi

node_version="$(node --version)"  # e.g. v24.15.0
node_major="$(echo "${node_version}" | sed 's/^v//' | cut -d. -f1)"
if [ "${node_major}" -lt 24 ]; then
  echo "ERROR: Node.js ${node_version} is too old.  Need >= 24." >&2
  echo "Please upgrade Node.js from https://nodejs.org/ or via your package manager." >&2
  exit 1
fi

# Check for curl
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: 'curl' not found in PATH.  Please install curl." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------
mkdir -p "${LIB_DIR}" "${BIN_DIR}"

# ---------------------------------------------------------------------------
# Backup existing main-team.cjs if present
# ---------------------------------------------------------------------------
if [ -f "${BUNDLE_PATH}" ]; then
  backup_name="main-team.cjs.bak-$(date +%Y%m%d-%H%M%S)"
  cp "${BUNDLE_PATH}" "${LIB_DIR}/${backup_name}"
  echo "Backed up existing bundle to ${LIB_DIR}/${backup_name}"
fi

# ---------------------------------------------------------------------------
# Download bundle + sha256
# ---------------------------------------------------------------------------
echo "Downloading ${BUNDLE_NAME} from ${BASE_URL}/..."
curl -fsSL -o "${BUNDLE_PATH}" "${BASE_URL}/${BUNDLE_NAME}"
echo "Downloaded ${BUNDLE_PATH}"

echo "Downloading ${SHA256_FILE}..."
curl -fsSL -o "${LIB_DIR}/${SHA256_FILE}" "${BASE_URL}/${SHA256_FILE}"

# ---------------------------------------------------------------------------
# Verify sha256 checksum
# ---------------------------------------------------------------------------
echo "Verifying sha256 checksum..."

# The sha256 file contains one line like:
#   <hash>  main.cjs
# But our local file is named main-team.cjs, so we need to check against
# the actual bytes, not the filename.  Use sha256sum/shasum with stdin.
expected_hash="$(cut -d' ' -f1 "${LIB_DIR}/${SHA256_FILE}")"
if command -v sha256sum >/dev/null 2>&1; then
  actual_hash="$(sha256sum "${BUNDLE_PATH}" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  actual_hash="$(shasum -a 256 "${BUNDLE_PATH}" | cut -d' ' -f1)"
else
  echo "WARNING: no sha256sum or shasum found; cannot verify checksum." >&2
  actual_hash=""
fi

if [ -n "${actual_hash}" ]; then
  if [ "${expected_hash}" != "${actual_hash}" ]; then
    echo "ERROR: sha256 mismatch!" >&2
    echo "  Expected: ${expected_hash}" >&2
    echo "  Actual:   ${actual_hash}" >&2
    exit 1
  fi
  echo "sha256 checksum OK: ${actual_hash}"
fi

# ---------------------------------------------------------------------------
# Write launcher wrapper
# ---------------------------------------------------------------------------
cat > "${LAUNCHER_PATH}" << 'LAUNCHER_EOF'
#!/bin/sh
# Launcher for the team-build Kimi Code CLI from source (main-team.cjs).
# Separate from bin/kimi so both the team build and official build coexist.
# KIMI_BUNDLE points to the team-built bundle.
set -eu
KIMI_BUNDLE="__LIB_DIR__/main-team.cjs"
# Enable the experimental secondary-model feature (subagent model, /secondary_model).
export KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1
# Enable the agent-core-v2 engine (subagent team tools: TeamHire/TeamFire/
# TeamScore/TeamMessage/TeamConcurrency, arbitrary subagent model ids,
# session-wide subagent concurrency pool).
export KIMI_CODE_EXPERIMENTAL_FLAG=1
exec node "$KIMI_BUNDLE" "$@"
LAUNCHER_EOF

# Substitute the real lib directory path
sed "s|__LIB_DIR__|${LIB_DIR}|g" "${LAUNCHER_PATH}" > "${LAUNCHER_PATH}.tmp"
mv "${LAUNCHER_PATH}.tmp" "${LAUNCHER_PATH}"

chmod +x "${LAUNCHER_PATH}"
echo "Installed launcher: ${LAUNCHER_PATH}"

# ---------------------------------------------------------------------------
# PATH reminder
# ---------------------------------------------------------------------------
case ":${PATH:-}:" in
  *:"${BIN_DIR}":*) ;;
  *)
    echo ""
    echo "NOTE: ${BIN_DIR} is not in your PATH."
    echo "Add the following to your shell profile (~/.zshrc, ~/.bashrc, etc.):"
    echo ""
    echo "  export PATH=\"\${HOME}/.kimi-code/bin:\${PATH}\""
    echo ""
    ;;
esac

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Installation complete.  Run 'kimiteam --version' to verify."
echo "Use 'kimiteam' as a drop-in replacement for 'kimi' with subagent-team features."
