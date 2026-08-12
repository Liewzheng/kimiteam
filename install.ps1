# install.ps1 - ASCII-only installer for the kimiteam CLI bundle (GitHub Pages short link).
#
# Mirrors scripts/install-kimiteam.ps1 (Chinese) and scripts/install-kimiteam.sh (bash),
# but is ASCII-only so it is safe to run via: irm <url> | iex
# The repo keeps the Chinese .ps1 for the -File path.
#
# Downloads the latest kimiteam-dev rolling release and installs it alongside the
# official kimi CLI. The official kimi binary and lib/kimi/main.cjs are NEVER touched.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   irm https://liewzheng.github.io/kimiteam/install.ps1 | iex
#
# Requires: node >= 24. Idempotent; re-running backs up the old bundle (upgrade).

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# RED LINE - NEVER touch the official kimi installation
# ---------------------------------------------------------------------------
# This script ONLY manages:
#   $HOME\.kimi-code\bin\kimiteam.ps1          (the team-build launcher)
#   $HOME\.kimi-code\lib\kimi\main-team.cjs    (the team-build CJS bundle)
#   $HOME\.kimi-code\lib\kimi\dist-web\        (fork web assets served by kimiteam)
#   $HOME\.kimi-code\lib\kimi\*.sha256         (checksum records; the zips are removed)
#   $HOME\.kimi-code\lib\kimi\package.json     (written only when missing; kept if present)
#
# It MUST NOT read, write, or delete:
#   $HOME\.kimi-code\bin\kimi
#   $HOME\.kimi-code\lib\kimi\main.cjs
# ---------------------------------------------------------------------------

$Repo = 'Liewzheng/kimiteam'
$Release = 'kimiteam-dev'
$BaseUrl = "https://github.com/${Repo}/releases/download/${Release}"

$InstallDir = Join-Path $HOME '.kimi-code'
$LibDir = Join-Path $InstallDir 'lib\kimi'
$BinDir = Join-Path $InstallDir 'bin'

$BundleName = 'main-team.cjs'
$BundlePath = Join-Path $LibDir $BundleName
$Sha256File = 'main-team.cjs.sha256'
$DistWebZipName = 'dist-web.zip'
$DistWebZipSha256File = 'dist-web.zip.sha256'
$DistWebDir = Join-Path $LibDir 'dist-web'
$LauncherPath = Join-Path $BinDir 'kimiteam.ps1'

# ---------------------------------------------------------------------------
# Pre-flight: node >= 24
# ---------------------------------------------------------------------------
$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $nodeCmd) {
  Write-Host 'ERROR: no node executable found (Application type; aliases/functions do not count). Install Node.js >= 24 from https://nodejs.org/ or via your package manager.' -ForegroundColor Red
  exit 1
}

$nodeVersion = & $nodeCmd --version   # e.g. v24.15.0
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') {
  $nodeMajor = [int]$Matches[1]
}
if ($nodeMajor -lt 24) {
  Write-Host "ERROR: Node.js ${nodeVersion} is too old. Need >= 24." -ForegroundColor Red
  Write-Host 'Please upgrade Node.js from https://nodejs.org/ or via your package manager.' -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $LibDir, $BinDir | Out-Null

# ---------------------------------------------------------------------------
# Back up the existing bundle, if present
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $BundlePath) {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupName = "main-team.cjs.bak-${timestamp}"
  Copy-Item -LiteralPath $BundlePath -Destination (Join-Path $LibDir $backupName)
  Write-Host "Backed up existing bundle to $LibDir\$backupName"
}

# ---------------------------------------------------------------------------
# Download bundle + sha256
# ---------------------------------------------------------------------------
# Windows PowerShell 5.1 defaults to TLS 1.0/1.1; GitHub needs TLS 1.2+, so raise it first.
[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

Write-Host "Downloading ${BundleName} from ${BaseUrl}/..."
Invoke-WebRequest -Uri "${BaseUrl}/${BundleName}" -OutFile $BundlePath -UseBasicParsing
Write-Host "Downloaded $BundlePath"

Write-Host "Downloading ${Sha256File}..."
Invoke-WebRequest -Uri "${BaseUrl}/${Sha256File}" -OutFile (Join-Path $LibDir $Sha256File) -UseBasicParsing

# ---------------------------------------------------------------------------
# Verify sha256
# ---------------------------------------------------------------------------
# The sha256 file contains one line like:
#   <hash>  apps/kimi-code/dist-native/intermediates/main.cjs
# Only the first whitespace-delimited token is the hash; verify actual bytes.
Write-Host 'Verifying sha256 checksum...'
$expectedHash = ((Get-Content -LiteralPath (Join-Path $LibDir $Sha256File) -TotalCount 1) -split '\s+')[0]
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BundlePath).Hash
if ($expectedHash -ne $actualHash) {
  Write-Host 'ERROR: sha256 mismatch!' -ForegroundColor Red
  Write-Host "  Expected: ${expectedHash}" -ForegroundColor Red
  Write-Host "  Actual:   ${actualHash}" -ForegroundColor Red
  exit 1
}
Write-Host "sha256 checksum OK: ${actualHash}"

# ---------------------------------------------------------------------------
# Download dist-web.zip + sha256
# ---------------------------------------------------------------------------
Write-Host "Downloading ${DistWebZipName} from ${BaseUrl}/..."
Invoke-WebRequest -Uri "${BaseUrl}/${DistWebZipName}" -OutFile (Join-Path $LibDir $DistWebZipName) -UseBasicParsing
Write-Host "Downloaded $(Join-Path $LibDir $DistWebZipName)"

Write-Host "Downloading ${DistWebZipSha256File}..."
Invoke-WebRequest -Uri "${BaseUrl}/${DistWebZipSha256File}" -OutFile (Join-Path $LibDir $DistWebZipSha256File) -UseBasicParsing

# ---------------------------------------------------------------------------
# Verify dist-web.zip sha256 (same pattern as the bundle)
# ---------------------------------------------------------------------------
Write-Host 'Verifying dist-web.zip sha256 checksum...'
$expectedWebHash = ((Get-Content -LiteralPath (Join-Path $LibDir $DistWebZipSha256File) -TotalCount 1) -split '\s+')[0]
$actualWebHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $LibDir $DistWebZipName)).Hash
if ($expectedWebHash -ne $actualWebHash) {
  Write-Host 'ERROR: dist-web.zip sha256 mismatch!' -ForegroundColor Red
  Write-Host "  Expected: ${expectedWebHash}" -ForegroundColor Red
  Write-Host "  Actual:   ${actualWebHash}" -ForegroundColor Red
  exit 1
}
Write-Host "dist-web.zip sha256 checksum OK: ${actualWebHash}"

# ---------------------------------------------------------------------------
# Back up and install dist-web (fork web assets)
# ---------------------------------------------------------------------------
# The zip's top level IS the dist-web content (index.html + assets/), so it
# unzips directly into $DistWebDir.
if (Test-Path -LiteralPath $DistWebDir) {
  $webTimestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $webBackupName = "dist-web.bak-${webTimestamp}"
  Copy-Item -LiteralPath $DistWebDir -Destination (Join-Path $LibDir $webBackupName) -Recurse
  Write-Host "Backed up existing dist-web to $LibDir\$webBackupName"
  Remove-Item -LiteralPath $DistWebDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $DistWebDir | Out-Null
Write-Host "Extracting ${DistWebZipName} to $DistWebDir ..."
# Fully-qualify the built-in cmdlet: if Pscx (PowerShell Community Extensions)
# is installed, its same-named Expand-Archive (parameter sets EntryPath/
# OutputPath, no -DestinationPath) auto-loads first in PSModulePath order,
# shadowing the built-in Microsoft.PowerShell.Archive\Expand-Archive and
# making this line fail - it must stay fully qualified; do not revert to the
# bare name.
Microsoft.PowerShell.Archive\Expand-Archive -LiteralPath (Join-Path $LibDir $DistWebZipName) -DestinationPath $DistWebDir
Write-Host 'Installed dist-web assets.'

# Drop the zip; keep the small .sha256 record next to main-team.cjs.sha256.
Remove-Item -LiteralPath (Join-Path $LibDir $DistWebZipName) -Force

# ---------------------------------------------------------------------------
# Ensure package.json marker (required for webAssetsDir resolution)
# ---------------------------------------------------------------------------
# The runtime resolves dist-web by walking up from the bundle (version.ts
# looks for a package.json within 6 levels); without one in $LibDir the web
# server runs API-only and `kimi web` returns 404 on GET /.  If the official
# kimi already left a package.json here, keep it untouched - our fork dist-web
# already overlays that directory, so the semantics are unchanged either way.
$PackageJsonPath = Join-Path $LibDir 'package.json'
if (-not (Test-Path -LiteralPath $PackageJsonPath)) {
  Set-Content -LiteralPath $PackageJsonPath -Value '{"name":"kimiteam","version":"0.33.0","type":"commonjs"}' -Encoding ASCII -NoNewline
  Write-Host "Wrote minimal package.json marker: $PackageJsonPath"
} else {
  Write-Host "package.json already exists, kept untouched: $PackageJsonPath"
}

# ---------------------------------------------------------------------------
# Write launcher (ASCII-only, no BOM)
# ---------------------------------------------------------------------------
# The node path is baked in at install time: pre-flight verified $nodeCmd is an
# Application-type node, so we take its absolute path via .Path and expand it
# into the launcher at generation time.  The launcher does NOT re-resolve node
# from PATH at runtime - this prevents PATH shadowing/hijack (a different node
# earlier in PATH at runtime does not take effect) and also prevents version
# managers (e.g. nvm) whose PATH additions are not persisted from leaving the
# launcher unable to find node.
# NOTE: if node moves or is replaced later, re-run this installer.
$launcherContent = @"
`$env:KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL = '1'
`$env:KIMI_CODE_EXPERIMENTAL_FLAG = '1'
`$env:KIMI_CODE_TEAM_MODE = '1'
`$env:KIMI_CODE_BIN_NAME = 'kimiteam'
& '__NODE_PATH__' "`$HOME\.kimi-code\lib\kimi\main-team.cjs" @args
"@
$launcherContent = $launcherContent.Replace('__NODE_PATH__', $nodeCmd.Path)
[System.IO.File]::WriteAllText($LauncherPath, $launcherContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Installed launcher: $LauncherPath"

# ---------------------------------------------------------------------------
# PATH reminder
# ---------------------------------------------------------------------------
if ($env:Path -split ';' -notcontains $BinDir) {
  $hint = '$env:Path += ";' + $BinDir + '"'
  Write-Host ''
  Write-Host "NOTE: $BinDir is not in your PATH."
  Write-Host 'Add it in PowerShell (or it takes effect on next login):'
  Write-Host "  $hint"
  Write-Host ''
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Installation complete. Verify with:'
Write-Host "  & $LauncherPath --version"
Write-Host "Or add $BinDir to PATH and run kimiteam directly."
