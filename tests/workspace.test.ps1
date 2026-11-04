# P0-1 workspace 包装：把 pnpm -r build / pnpm -r test 的退出码映射成断言。
# 找不到 Node 24 / pnpm 11 直接 FAIL 并打印原因（不静默 SKIP）。
. (Join-Path $PSScriptRoot 'assert.ps1')

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path $PSScriptRoot -Parent

Write-Host "仓库根：$repoRoot" -ForegroundColor Cyan
Assert-True (Test-Path (Join-Path $repoRoot 'pnpm-workspace.yaml')) '根目录存在 pnpm-workspace.yaml'
Assert-True (Test-Path (Join-Path $repoRoot 'package.json')) '根目录存在 package.json'

# ---- Node 24：优先固定目录，其次 PATH；低于 24 直接 FAIL ----
$nodeExe = Join-Path $env:LOCALAPPDATA 'nvm\v24.22.0\node.exe'
if (-not (Test-Path $nodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source } else { $nodeExe = $null }
}

$nodeMajor = 0
if ($nodeExe -and (Test-Path $nodeExe)) {
  $nodeVersion = & $nodeExe -p "process.versions.node" 2>$null
  if ($nodeVersion -match '^(\d+)\.') { $nodeMajor = [int]$Matches[1] }
  # 让 pnpm shim 也拿到 Node 24（shim 从 PATH 找 node）
  $env:Path = (Split-Path $nodeExe) + ';' + $env:Path
}

Assert-True ([bool]($nodeExe -and (Test-Path $nodeExe))) "找到 Node 可执行文件：$nodeExe"
if (-not $nodeMajor) {
  Write-Host "FAIL 无法确定 Node 版本（$nodeExe）" -ForegroundColor Red
  Exit-Test
}
Assert-True ($nodeMajor -eq 24) "Node 主版本为 24（实际 $nodeMajor）"

# ---- pnpm 11：优先 Get-Command pnpm，其次 D:\tools\pnpm11 ----
$pnpmKind = $null
$pnpmPath = $null
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue

if ($pnpmCmd -and $pnpmCmd.Source) {
  $pnpmKind = 'shim'
  $pnpmPath = $pnpmCmd.Source
} elseif (Test-Path 'D:\tools\pnpm11\node_modules\.bin\pnpm.cmd') {
  $pnpmKind = 'shim'
  $pnpmPath = 'D:\tools\pnpm11\node_modules\.bin\pnpm.cmd'
} elseif (Test-Path 'D:\tools\pnpm11\node_modules\pnpm\bin\pnpm.cjs') {
  $pnpmKind = 'cjs'
  $pnpmPath = 'D:\tools\pnpm11\node_modules\pnpm\bin\pnpm.cjs'
}

if (-not $pnpmPath) {
  Write-Host 'FAIL 找不到 pnpm：Get-Command pnpm 无结果，且 D:\tools\pnpm11 下既无 pnpm.cmd 也无 pnpm.cjs' -ForegroundColor Red
  Write-Host '      需先装 pnpm 11（或用 corepack enable），本测试不允许静默跳过。' -ForegroundColor Red
  Exit-Test
}
Assert-True (Test-Path $pnpmPath) "pnpm 可执行路径存在（$pnpmKind）：$pnpmPath"

function Invoke-Pnpm {
  param([string[]]$Arguments)
  # 输出直通控制台（Out-Host 不进管道），函数只返回退出码。
  if ($script:pnpmKind -eq 'cjs') {
    & $script:nodeExe $script:pnpmPath @Arguments | Out-Host
  } else {
    & $script:pnpmPath @Arguments | Out-Host
  }
  return $LASTEXITCODE
}

# 版本探测需要拿到文本，单独跑一次（输出走管道捕获）。
if ($pnpmKind -eq 'cjs') {
  $pnpmVersion = (& $nodeExe $pnpmPath --version 2>&1 | Out-String).Trim()
} else {
  $pnpmVersion = (& $pnpmPath --version 2>&1 | Out-String).Trim()
}
Assert-True ($pnpmVersion -match '^11\.') "pnpm 主版本为 11（实际输出 [$pnpmVersion]）"
if ($pnpmVersion -notmatch '^11\.') {
  Write-Host 'FAIL pnpm 版本不是 11.x，pnpm 10 会与仓库 store 冲突，先切到 pnpm 11。' -ForegroundColor Red
  Exit-Test
}

# ---- 逐包构建 ----
Write-Host '== pnpm -r build' -ForegroundColor Cyan
$buildExit = Invoke-Pnpm -Arguments @('-r', 'build')
Assert-Equal 0 $buildExit 'pnpm -r build 退出码为 0'

# ---- 逐包测试 ----
Write-Host '== pnpm -r test' -ForegroundColor Cyan
$testExit = Invoke-Pnpm -Arguments @('-r', 'test')
Assert-Equal 0 $testExit 'pnpm -r test 退出码为 0'

Exit-Test
