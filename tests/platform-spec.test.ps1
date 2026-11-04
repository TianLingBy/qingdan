# P0-2 口径锁定：跑 packages/contracts 的 spec-lock.test.ts，断言退出码 0。
# 覆盖 D16 编号 / D50 三层 / D21 取消级联 / D51 审计 100% / D52.1 AI 不放大。
. (Join-Path $PSScriptRoot 'assert.ps1')

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path $PSScriptRoot -Parent
$specLock = Join-Path $repoRoot 'packages\contracts\src\spec-lock.test.ts'

Assert-True (Test-Path $specLock) "口径锁定测试文件存在：packages/contracts/src/spec-lock.test.ts"

# ---- Node 24 ----
$nodeExe = Join-Path $env:LOCALAPPDATA 'nvm\v24.22.0\node.exe'
if (-not (Test-Path $nodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source } else { $nodeExe = $null }
}
$nodeMajor = 0
if ($nodeExe -and (Test-Path $nodeExe)) {
  $nodeVersion = & $nodeExe -p "process.versions.node" 2>$null
  if ($nodeVersion -match '^(\d+)\.') { $nodeMajor = [int]$Matches[1] }
  $env:Path = (Split-Path $nodeExe) + ';' + $env:Path
}
Assert-True ([bool]($nodeExe -and (Test-Path $nodeExe))) "找到 Node 可执行文件：$nodeExe"
if (-not $nodeMajor) {
  Assert-True $false "无法确定 Node 版本（$nodeExe）；本测试不允许静默通过"
  Exit-Test
}
Assert-True ($nodeMajor -eq 24) "Node 主版本为 24（实际 $nodeMajor）"

# ---- pnpm 11 ----
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
  Assert-True $false '找不到 pnpm（Get-Command pnpm 无结果，且 D:\tools\pnpm11 下无 pnpm.cmd / pnpm.cjs）；需先装 pnpm 11，本测试不允许静默跳过'
  Exit-Test
}
Assert-True (Test-Path $pnpmPath) "pnpm 可执行路径存在（$pnpmKind）：$pnpmPath"

if ($pnpmKind -eq 'cjs') {
  $pnpmVersion = (& $nodeExe $pnpmPath --version 2>&1 | Out-String).Trim()
} else {
  $pnpmVersion = (& $pnpmPath --version 2>&1 | Out-String).Trim()
}
Assert-True ($pnpmVersion -match '^11\.') "pnpm 主版本为 11（实际输出 [$pnpmVersion]）"
if ($pnpmVersion -notmatch '^11\.') {
  Assert-True $false "pnpm 版本不是 11.x（实际 [$pnpmVersion]），pnpm 10 会与仓库 store 冲突"
  Exit-Test
}

# ---- 跑口径锁定测试 ----
Write-Host '== pnpm -C packages/contracts exec vitest run src/spec-lock.test.ts' -ForegroundColor Cyan
$vitestArgs = @('-C', 'packages/contracts', 'exec', 'vitest', 'run', 'src/spec-lock.test.ts')
if ($pnpmKind -eq 'cjs') {
  & $nodeExe $pnpmPath @vitestArgs | Out-Host
} else {
  & $pnpmPath @vitestArgs | Out-Host
}
$specExit = $LASTEXITCODE

Assert-Equal 0 $specExit 'spec-lock.test.ts 退出码为 0'

Exit-Test
