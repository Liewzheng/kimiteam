# uninstall-kimiteam.ps1 — Windows PowerShell 卸载脚本(镜像 scripts/uninstall-kimiteam.sh)。
#
# 移除 install-kimiteam.ps1 引入的全部程序文件。共享个人数据
# (~/.kimi-code 下)绝不触碰(见下方 RED LINE)。
#
# 行为取决于官方 kimi CLI 是否也在本机:
#   - 官方 kimi 存在 → 仅移除 kimiteam 程序文件;官方 kimi 二进制
#     与共享数据保持不动。
#   - 官方 kimi 不存在 → 移除 kimiteam 程序文件,并清理因此变空的
#     子目录(bin\、lib\kimi\、lib\)。共享个人数据依然绝不触碰。
#
# 两种分支下,main-team.cjs.bak-* 备份一律视为程序文件移除
# (重装即可再生成)。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/uninstall-kimiteam.ps1
#
# 预览(不实际删除,仅显示将删除的文件):
#   powershell -ExecutionPolicy Bypass -File scripts/uninstall-kimiteam.ps1 -WhatIf
#
# 每个删除/清空动作前逐一确认:
#   powershell -ExecutionPolicy Bypass -File scripts/uninstall-kimiteam.ps1 -Confirm

[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# RED LINE —— 绝不触碰官方 kimi 安装或共享数据
# ---------------------------------------------------------------------------
# 本脚本只移除 install-kimiteam.ps1 引入的文件:
#   $HOME\.kimi-code\bin\kimiteam.ps1
#   $HOME\.kimi-code\lib\kimi\main-team.cjs
#   $HOME\.kimi-code\lib\kimi\main-team.cjs.sha256
#   $HOME\.kimi-code\lib\kimi\main-team.cjs.bak-*
#
# 绝不读/写/删:
#   $HOME\.kimi-code\bin\kimi             — 官方 launcher
#   $HOME\.kimi-code\lib\kimi\main.cjs    — 官方 bundle
#   $HOME\.kimi-code\config.toml          — 共享配置
#   $HOME\.kimi-code\sessions\            — 共享会话数据
#   $HOME\.kimi-code\agents\              — 共享 agent 数据
#   $HOME\.kimi-code\memory\              — 共享记忆数据
#   $HOME\.kimi-code\server\              — 共享服务端数据
#   $HOME\.kimi-code\plugins\             — 共享插件数据
#   $HOME\.kimi-code\search-index\        — 共享搜索索引
#   $HOME\.kimi-code 下未列出的任何其他文件/目录
# ---------------------------------------------------------------------------

$InstallDir = Join-Path $HOME '.kimi-code'
$LibDir = Join-Path $InstallDir 'lib\kimi'
$BinDir = Join-Path $InstallDir 'bin'

$LauncherPath = Join-Path $BinDir 'kimiteam.ps1'
$BundlePath = Join-Path $LibDir 'main-team.cjs'
$Sha256Path = Join-Path $LibDir 'main-team.cjs.sha256'

# ---------------------------------------------------------------------------
# 检测官方 kimi 是否安装
# ---------------------------------------------------------------------------
$hasOfficialKimi = (Test-Path -LiteralPath (Join-Path $BinDir 'kimi')) -or
                   (Test-Path -LiteralPath (Join-Path $LibDir 'main.cjs'))

# ---------------------------------------------------------------------------
# 移除 kimiteam 专用程序文件(幂等 —— 不存在则跳过)
# ---------------------------------------------------------------------------
$foundAny = $false

if (Test-Path -LiteralPath $LauncherPath) {
  if ($PSCmdlet.ShouldProcess($LauncherPath, 'Remove')) {
    Remove-Item -LiteralPath $LauncherPath -Force
    Write-Host "已删除: $LauncherPath"
  }
  $foundAny = $true
}

if (Test-Path -LiteralPath $BundlePath) {
  if ($PSCmdlet.ShouldProcess($BundlePath, 'Remove')) {
    Remove-Item -LiteralPath $BundlePath -Force
    Write-Host "已删除: $BundlePath"
  }
  $foundAny = $true
}

if (Test-Path -LiteralPath $Sha256Path) {
  if ($PSCmdlet.ShouldProcess($Sha256Path, 'Remove')) {
    Remove-Item -LiteralPath $Sha256Path -Force
    Write-Host "已删除: $Sha256Path"
  }
  $foundAny = $true
}

# 备份文件一律移除(视为程序产物,非用户数据)
if (Test-Path -LiteralPath $LibDir) {
  $backups = @(Get-ChildItem -LiteralPath $LibDir -Filter 'main-team.cjs.bak-*' -File -ErrorAction SilentlyContinue)
  foreach ($bk in $backups) {
    if ($PSCmdlet.ShouldProcess($bk.FullName, 'Remove')) {
      Remove-Item -LiteralPath $bk.FullName -Force
      Write-Host "已删除: $($bk.FullName)"
    }
    $foundAny = $true
  }
}

# ---------------------------------------------------------------------------
# 未找到任何文件 —— 提示并退出
# ---------------------------------------------------------------------------
if (-not $foundAny) {
  Write-Host "kimiteam 未安装(在 $InstallDir 下未找到任何文件)。"
  exit 0
}

# ---------------------------------------------------------------------------
# 目录清理(仅当官方 kimi 不存在时)
# ---------------------------------------------------------------------------
if (-not $hasOfficialKimi) {
  # 仅删除已变空的子目录(rmdir 语义:非空则保留,不报错)。
  # 顺序:先 lib\kimi,再 lib,最后 bin —— 与 sh 版一致。
  $emptyDirs = @(
    $LibDir,
    (Join-Path $InstallDir 'lib'),
    $BinDir
  )
  foreach ($d in $emptyDirs) {
    if (Test-Path -LiteralPath $d) {
      $entries = @(Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)
      if ($entries.Count -eq 0) {
        if ($PSCmdlet.ShouldProcess($d, 'Remove empty directory')) {
          Remove-Item -LiteralPath $d -Force
          Write-Host "已删除空目录: $d"
        }
      }
    }
  }
}

# ---------------------------------------------------------------------------
# 完成 —— 分支摘要
# ---------------------------------------------------------------------------
Write-Host ''
if ($hasOfficialKimi) {
  Write-Host '卸载完成。官方 kimi CLI 不受影响,可继续正常使用。'
} else {
  Write-Host '卸载完成。kimiteam 程序文件已移除。'
  Write-Host '个人数据仍保留在:'
  Write-Host "  $InstallDir"
  Write-Host '(config.toml、sessions\、agents\、memory\、server\ 等)'
  Write-Host ''
  Write-Host '之后可重新安装 kimiteam(或官方 kimi)复用这些数据。'
}

# ---------------------------------------------------------------------------
# PATH 提示(仅供参考 —— 绝不修改用户环境)
# ---------------------------------------------------------------------------
if (($env:Path -split ';') -contains $BinDir) {
  Write-Host ''
  Write-Host "提示: $BinDir 仍在 PATH 中。"
  Write-Host '若之前仅为 kimiteam 添加,可移除对应 PATH 条目,例如在 PowerShell 中执行:'
  Write-Host "  `$env:Path = `$env:Path.Replace(';$BinDir','')"
  Write-Host ''
  Write-Host '此步骤可选——留着无害,但卸载后 kimiteam 将无法找到(符合预期)。'
}
