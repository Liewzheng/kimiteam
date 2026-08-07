# install-kimiteam.ps1 — Windows PowerShell 安装脚本(镜像 scripts/install-kimiteam.sh)。
#
# 从 GitHub Release kimiteam-dev 下载最新分发文件,安装到官方 kimi CLI 旁边。
# 官方 kimi 二进制与 lib/kimi/main.cjs bundle 绝不触碰(见下方 RED LINE)。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/install-kimiteam.ps1
#
# 要求: Node >= 24。幂等可重复运行,自动备份旧版即升级。

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# RED LINE —— 绝不触碰官方 kimi 安装
# ---------------------------------------------------------------------------
# 本脚本只管理:
#   $HOME\.kimi-code\bin\kimiteam.ps1          (team 构建启动器)
#   $HOME\.kimi-code\lib\kimi\main-team.cjs    (team 构建 CJS bundle)
#   $HOME\.kimi-code\lib\kimi\dist-web\        (fork web 资产,kimiteam 服务用)
#   $HOME\.kimi-code\lib\kimi\*.sha256         (校验记录;zip 解压后删除)
#
# 绝不读/写/删:
#   $HOME\.kimi-code\bin\kimi
#   $HOME\.kimi-code\lib\kimi\main.cjs
# ---------------------------------------------------------------------------

$Repo = 'Liewzheng/kimi-code'
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
# 预检: Node >= 24
# ---------------------------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCmd) {
  Write-Host 'ERROR: 未在 PATH 中找到 node。请安装 Node.js >= 24(https://nodejs.org/ 或包管理器)。' -ForegroundColor Red
  exit 1
}

$nodeVersion = & node --version   # 例如 v24.15.0
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') {
  $nodeMajor = [int]$Matches[1]
}
if ($nodeMajor -lt 24) {
  Write-Host "ERROR: 当前 Node.js 版本 ${nodeVersion} 过旧,需要 >= 24。" -ForegroundColor Red
  Write-Host '请从 https://nodejs.org/ 或包管理器升级 Node.js。' -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------------------
# 创建目录
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $LibDir, $BinDir | Out-Null

# ---------------------------------------------------------------------------
# 备份旧 bundle(若存在)
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $BundlePath) {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupName = "main-team.cjs.bak-${timestamp}"
  Copy-Item -LiteralPath $BundlePath -Destination (Join-Path $LibDir $backupName)
  Write-Host "已备份旧 bundle 到 $LibDir\$backupName"
}

# ---------------------------------------------------------------------------
# 下载 bundle + sha256
# ---------------------------------------------------------------------------
# Windows PowerShell 5.1 默认 TLS 1.0/1.1,GitHub 需要 TLS 1.2+,先抬高。
[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

Write-Host "正在从 $BaseUrl/ 下载 $BundleName ..."
Invoke-WebRequest -Uri "${BaseUrl}/${BundleName}" -OutFile $BundlePath -UseBasicParsing
Write-Host "已下载 $BundlePath"

Write-Host "正在下载 $Sha256File ..."
Invoke-WebRequest -Uri "${BaseUrl}/${Sha256File}" -OutFile (Join-Path $LibDir $Sha256File) -UseBasicParsing

# ---------------------------------------------------------------------------
# 校验 sha256
# ---------------------------------------------------------------------------
# sha256 文件内容形如:
#   <hash>  apps/kimi-code/dist-native/intermediates/main.cjs
# 只取第一列哈希,按实际字节校验(与文件名无关)。
Write-Host '正在校验 sha256 ...'
$expectedHash = ((Get-Content -LiteralPath (Join-Path $LibDir $Sha256File) -TotalCount 1) -split '\s+')[0]
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BundlePath).Hash
if ($expectedHash -ne $actualHash) {
  Write-Host 'ERROR: sha256 校验失败!' -ForegroundColor Red
  Write-Host "  期望: ${expectedHash}" -ForegroundColor Red
  Write-Host "  实际: ${actualHash}" -ForegroundColor Red
  exit 1
}
Write-Host "sha256 校验通过: ${actualHash}"

# ---------------------------------------------------------------------------
# 下载 dist-web.zip + sha256
# ---------------------------------------------------------------------------
Write-Host "正在从 $BaseUrl/ 下载 $DistWebZipName ..."
Invoke-WebRequest -Uri "${BaseUrl}/${DistWebZipName}" -OutFile (Join-Path $LibDir $DistWebZipName) -UseBasicParsing
Write-Host "已下载 $(Join-Path $LibDir $DistWebZipName)"

Write-Host "正在下载 $DistWebZipSha256File ..."
Invoke-WebRequest -Uri "${BaseUrl}/${DistWebZipSha256File}" -OutFile (Join-Path $LibDir $DistWebZipSha256File) -UseBasicParsing

# ---------------------------------------------------------------------------
# 校验 dist-web.zip sha256(与 main-team.cjs 同模式)
# ---------------------------------------------------------------------------
Write-Host '正在校验 dist-web.zip sha256 ...'
$expectedWebHash = ((Get-Content -LiteralPath (Join-Path $LibDir $DistWebZipSha256File) -TotalCount 1) -split '\s+')[0]
$actualWebHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $LibDir $DistWebZipName)).Hash
if ($expectedWebHash -ne $actualWebHash) {
  Write-Host 'ERROR: dist-web.zip sha256 校验失败!' -ForegroundColor Red
  Write-Host "  期望: ${expectedWebHash}" -ForegroundColor Red
  Write-Host "  实际: ${actualWebHash}" -ForegroundColor Red
  exit 1
}
Write-Host "dist-web.zip sha256 校验通过: ${actualWebHash}"

# ---------------------------------------------------------------------------
# 备份并安装 dist-web(fork web 资产)
# ---------------------------------------------------------------------------
# zip 顶层即 dist-web 内容(index.html + assets/),直接解压进 $DistWebDir。
if (Test-Path -LiteralPath $DistWebDir) {
  $webTimestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $webBackupName = "dist-web.bak-${webTimestamp}"
  Copy-Item -LiteralPath $DistWebDir -Destination (Join-Path $LibDir $webBackupName) -Recurse
  Write-Host "已备份旧 dist-web 到 $LibDir\$webBackupName"
  Remove-Item -LiteralPath $DistWebDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $DistWebDir | Out-Null
Write-Host "正在解压 $DistWebZipName 到 $DistWebDir ..."
Expand-Archive -LiteralPath (Join-Path $LibDir $DistWebZipName) -DestinationPath $DistWebDir
Write-Host '已安装 dist-web 资产。'

# 删除 zip,保留小体积 .sha256 记录(与 main-team.cjs.sha256 一致)。
Remove-Item -LiteralPath (Join-Path $LibDir $DistWebZipName) -Force

# ---------------------------------------------------------------------------
# 写启动器(纯 ASCII,无 BOM)
# ---------------------------------------------------------------------------
$launcherContent = @"
`$env:KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL = '1'
`$env:KIMI_CODE_EXPERIMENTAL_FLAG = '1'
`$env:KIMI_CODE_TEAM_MODE = '1'
`$env:KIMI_CODE_BIN_NAME = 'kimiteam'
& node "`$HOME\.kimi-code\lib\kimi\main-team.cjs" @args
"@
[System.IO.File]::WriteAllText($LauncherPath, $launcherContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已安装启动器: $LauncherPath"

# ---------------------------------------------------------------------------
# PATH 提示
# ---------------------------------------------------------------------------
if ($env:Path -split ';' -notcontains $BinDir) {
  $hint = '$env:Path += ";' + $BinDir + '"'
  Write-Host ''
  Write-Host "提示: $BinDir 不在 PATH 中。"
  Write-Host '可在 PowerShell 中手动加入(或下次登录自动生效):'
  Write-Host "  $hint"
  Write-Host ''
}

# ---------------------------------------------------------------------------
# 完成
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '安装完成。在 PowerShell 中运行 kimiteam --version 验证:'
Write-Host "  & $LauncherPath --version"
Write-Host "或把 $BinDir 加入 PATH 后直接运行 kimiteam。"
