#!/bin/sh
# install-kimiteam.sh -- POSIX-sh one-shot installer for the kimiteam CLI bundle.
#
# Downloads the latest kimiteam-dev rolling release from GitHub and sets it up
# alongside the official `kimi` CLI.  The official `kimi` binary and its
# `lib/kimi/main.cjs` bundle are NEVER touched (see RED LINE below).
#
# Usage:
#   bash scripts/install-kimiteam.sh
#
# Requires: node >= 24, curl, unzip.

set -eu

# ---------------------------------------------------------------------------
# RED LINE -- NEVER touch the official kimi installation
# ---------------------------------------------------------------------------
# This script ONLY manages:
#   ~/.kimi-code/bin/kimiteam          (the team-build launcher)
#   ~/.kimi-code/lib/kimi/main-team.cjs (the team-build CJS bundle)
#   ~/.kimi-code/lib/kimi/dist-web/     (fork web assets served by kimiteam)
#   ~/.kimi-code/lib/kimi/*.sha256      (checksum records; the zips are removed)
#   ~/.kimi-code/lib/kimi/package.json  (written only when missing; kept if present)
#
# It MUST NOT read, write, or delete:
#   ~/.kimi-code/bin/kimi
#   ~/.kimi-code/lib/kimi/main.cjs
# ---------------------------------------------------------------------------

REPO="Liewzheng/kimiteam"
RELEASE="kimiteam-dev"
BASE_URL="https://github.com/${REPO}/releases/download/${RELEASE}"

INSTALL_DIR="${HOME}/.kimi-code"
LIB_DIR="${INSTALL_DIR}/lib/kimi"
BIN_DIR="${INSTALL_DIR}/bin"

BUNDLE_NAME="main-team.cjs"
BUNDLE_PATH="${LIB_DIR}/${BUNDLE_NAME}"
SHA256_FILE="main-team.cjs.sha256"
DIST_WEB_ZIP_NAME="dist-web.zip"
DIST_WEB_ZIP_SHA256_FILE="dist-web.zip.sha256"
DIST_WEB_DIR="${LIB_DIR}/dist-web"
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

node_version="$(command node --version)"  # e.g. v24.15.0
node_major="$(echo "${node_version}" | command sed 's/^v//' | command cut -d. -f1)"
if [ "${node_major}" -lt 24 ]; then
  echo "ERROR: Node.js ${node_version} is too old.  Need >= 24." >&2
  echo "Please upgrade Node.js from https://nodejs.org/ or via your package manager." >&2
  exit 1
fi

# Resolve the verified node binary to an absolute path NOW and bake it into the
# launcher below.  The launcher must NOT re-resolve node from PATH at runtime:
# a fresh shell may lack the version manager's PATH additions (e.g. nvm), and a
# different node earlier in PATH must not silently replace the one verified here.
# We scan PATH directly (not `command -v`) so a shell function or alias named
# 'node' cannot shadow the real executable.
node_bin_path=""
_oldifs=$IFS
IFS=:
for _dir in ${PATH:-}; do
  case "${_dir}" in
    /*) ;;
    *) continue ;;
  esac
  if [ -x "${_dir}/node" ]; then
    node_bin_path="${_dir}/node"
    break
  fi
done
IFS=$_oldifs
if [ -z "${node_bin_path}" ]; then
  echo "ERROR: cannot resolve a real 'node' executable in PATH." >&2
  echo "Please install Node.js >= 24 from https://nodejs.org/ or via your package manager." >&2
  exit 1
fi

# Check for curl
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: 'curl' not found in PATH.  Please install curl." >&2
  exit 1
fi

# Check for unzip (needed for the dist-web assets)
if ! command -v unzip >/dev/null 2>&1; then
  echo "ERROR: 'unzip' not found in PATH.  Please install unzip." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------
command mkdir -p "${LIB_DIR}" "${BIN_DIR}"

# ---------------------------------------------------------------------------
# Backup existing main-team.cjs if present
# ---------------------------------------------------------------------------
if [ -f "${BUNDLE_PATH}" ]; then
  backup_name="main-team.cjs.bak-$(command date +%Y%m%d-%H%M%S)"
  command cp "${BUNDLE_PATH}" "${LIB_DIR}/${backup_name}"
  echo "Backed up existing bundle to ${LIB_DIR}/${backup_name}"
fi

# ---------------------------------------------------------------------------
# Download bundle + sha256
# ---------------------------------------------------------------------------
echo "Downloading ${BUNDLE_NAME} from ${BASE_URL}/..."
command curl -fsSL -o "${BUNDLE_PATH}" "${BASE_URL}/${BUNDLE_NAME}"
echo "Downloaded ${BUNDLE_PATH}"

echo "Downloading ${SHA256_FILE}..."
command curl -fsSL -o "${LIB_DIR}/${SHA256_FILE}" "${BASE_URL}/${SHA256_FILE}"

# ---------------------------------------------------------------------------
# verify_sha256 <file> <hash-file>
# Verify <file>'s sha256 against the first whitespace-separated field of
# <hash-file> (the checksum file names the source path, which differs from our
# local filename, so we compare actual bytes).  Exits 1 on mismatch; warns and
# returns 0 when no hashing tool is available (parity with legacy behavior).
# ---------------------------------------------------------------------------
verify_sha256() {
  _file="$1"
  _hash_file="$2"
  _expected_hash="$(command cut -d' ' -f1 "${_hash_file}")"
  if command -v sha256sum >/dev/null 2>&1; then
    _actual_hash="$(command sha256sum "${_file}" | command cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    _actual_hash="$(command shasum -a 256 "${_file}" | command cut -d' ' -f1)"
  else
    echo "WARNING: no sha256sum or shasum found; cannot verify checksum." >&2
    return 0
  fi
  if [ "${_expected_hash}" != "${_actual_hash}" ]; then
    echo "ERROR: sha256 mismatch for ${_file}!" >&2
    echo "  Expected: ${_expected_hash}" >&2
    echo "  Actual:   ${_actual_hash}" >&2
    exit 1
  fi
  echo "sha256 checksum OK for ${_file}: ${_actual_hash}"
}

# ---------------------------------------------------------------------------
# Verify bundle sha256 checksum
# ---------------------------------------------------------------------------
echo "Verifying sha256 checksum..."
verify_sha256 "${BUNDLE_PATH}" "${LIB_DIR}/${SHA256_FILE}"

# ---------------------------------------------------------------------------
# Download dist-web.zip + sha256
# ---------------------------------------------------------------------------
echo "Downloading ${DIST_WEB_ZIP_NAME} from ${BASE_URL}/..."
command curl -fsSL -o "${LIB_DIR}/${DIST_WEB_ZIP_NAME}" "${BASE_URL}/${DIST_WEB_ZIP_NAME}"
echo "Downloaded ${LIB_DIR}/${DIST_WEB_ZIP_NAME}"

echo "Downloading ${DIST_WEB_ZIP_SHA256_FILE}..."
command curl -fsSL -o "${LIB_DIR}/${DIST_WEB_ZIP_SHA256_FILE}" "${BASE_URL}/${DIST_WEB_ZIP_SHA256_FILE}"

# ---------------------------------------------------------------------------
# Verify dist-web.zip sha256 (same pattern as the bundle)
# ---------------------------------------------------------------------------
echo "Verifying ${DIST_WEB_ZIP_NAME} sha256 checksum..."
verify_sha256 "${LIB_DIR}/${DIST_WEB_ZIP_NAME}" "${LIB_DIR}/${DIST_WEB_ZIP_SHA256_FILE}"

# ---------------------------------------------------------------------------
# Install dist-web (fork web assets)
# ---------------------------------------------------------------------------
# The zip's top level IS the dist-web content (index.html + assets/), so it
# unzips directly into ${DIST_WEB_DIR}.  Back up any previous dist-web first.
if [ -d "${DIST_WEB_DIR}" ]; then
  web_backup_name="dist-web.bak-$(command date +%Y%m%d-%H%M%S)"
  command cp -r "${DIST_WEB_DIR}" "${LIB_DIR}/${web_backup_name}"
  echo "Backed up existing dist-web to ${LIB_DIR}/${web_backup_name}"
  command rm -rf "${DIST_WEB_DIR}"
fi
command mkdir -p "${DIST_WEB_DIR}"
echo "Extracting ${DIST_WEB_ZIP_NAME} to ${DIST_WEB_DIR}..."
command unzip -q -o "${LIB_DIR}/${DIST_WEB_ZIP_NAME}" -d "${DIST_WEB_DIR}"
echo "Installed dist-web assets."

# Drop the zip; keep the small .sha256 record next to main-team.cjs.sha256.
command rm -f "${LIB_DIR}/${DIST_WEB_ZIP_NAME}"

# ---------------------------------------------------------------------------
# Ensure package.json marker (required for webAssetsDir resolution)
# ---------------------------------------------------------------------------
# The runtime resolves dist-web by walking up from the bundle (version.ts
# looks for a package.json within 6 levels); without one in ${LIB_DIR} the
# web server runs API-only and `kimi web` returns 404 on GET /.  If the
# official kimi already left a package.json here, keep it untouched -- our
# fork dist-web already overlays that directory, so the semantics are
# unchanged either way.
if [ ! -f "${LIB_DIR}/package.json" ]; then
  printf '%s\n' '{"name":"kimiteam","version":"0.33.0","type":"commonjs"}' > "${LIB_DIR}/package.json"
  echo "Wrote minimal package.json marker: ${LIB_DIR}/package.json"
else
  echo "package.json already exists, kept untouched: ${LIB_DIR}/package.json"
fi

# ---------------------------------------------------------------------------
# Write launcher wrapper
# ---------------------------------------------------------------------------
command cat > "${LAUNCHER_PATH}" << 'LAUNCHER_EOF'
#!/bin/sh
# Launcher for the team-build Kimi Code CLI from source (main-team.cjs).
# Separate from bin/kimi so both the team build and official build coexist.
# KIMI_BUNDLE points to the team-built bundle.
set -eu
KIMI_BUNDLE="__LIB_DIR__/main-team.cjs"
# Advertise the actual launcher name in resume hints instead of the hardcoded
# "kimi" (the 5 CLI resume-hint sites fall back to 'kimi' when this is unset).
export KIMI_CODE_BIN_NAME=kimiteam
# Enable the experimental secondary-model feature (subagent model, /secondary_model).
export KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1
# Enable the agent-core-v2 engine (subagent team tools: TeamHire/TeamFire/
# TeamScore/TeamMessage/TeamConcurrency, arbitrary subagent model ids,
# session-wide subagent concurrency pool).
export KIMI_CODE_EXPERIMENTAL_FLAG=1
# Start in team mode by default. Users can /team off or set
# [subagent] team_mode = false in config.toml to override (config wins).
export KIMI_CODE_TEAM_MODE=1
# The node binary path is baked in at install time (the verified binary's
# absolute path).  The launcher does NOT re-resolve node from PATH at runtime,
# so it is immune to PATH shadowing/hijack and to fresh shells missing the
# version manager's PATH additions.  If node moves, re-run the installer.
exec "__NODE_PATH__" "$KIMI_BUNDLE" "$@"
LAUNCHER_EOF

# Substitute the real lib directory path and the install-time node binary path
command sed -e "s|__LIB_DIR__|${LIB_DIR}|g" -e "s|__NODE_PATH__|${node_bin_path}|g" "${LAUNCHER_PATH}" > "${LAUNCHER_PATH}.tmp"
command mv "${LAUNCHER_PATH}.tmp" "${LAUNCHER_PATH}"

command chmod +x "${LAUNCHER_PATH}"
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
