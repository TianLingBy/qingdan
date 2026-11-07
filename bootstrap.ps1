<#
.SYNOPSIS
  轻单工程仓一键初始化：装 hook、跑全量测试，可选建模块分支。幂等，可重复跑。

.DESCRIPTION
  给任何 Agent / 协作者用：不需要先读一堆文档才能开始。
  公开仓只含代码与接口说明书；产品口径、契约与团队检查点属内部资料，不在本仓内。

.PARAMETER Module
  可选。模块名（platform / masterdata / inventory / purchase / processing / sales /
  internal-trade / settlement / test）。给了就校验 apps/api/src/modules/<Module> 存在，
  并建/切 feat/<Module> 分支。

.EXAMPLE
  pwsh -NoProfile -File bootstrap.ps1
  pwsh -NoProfile -File bootstrap.ps1 -Module platform
#>
param(
  [string]$Module = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
Set-Location $root

function Fail([string]$msg) { Write-Host "BOOTSTRAP-FAIL $msg" -ForegroundColor Red; exit 1 }
function Step([string]$msg) { Write-Host "== $msg" -ForegroundColor Cyan }

# 0. 必须在仓库根（防止在上级目录误跑）
if (-not (Test-Path (Join-Path $root '.git'))) { Fail "不在仓库根（找不到 .git）：$root" }
if (-not (Test-Path (Join-Path $root 'package.json'))) { Fail "找不到 package.json，目录不对：$root" }

# 1. pwsh 版本（5.1 会在带中文的 .ps1 上炸）
Step '检查 PowerShell 版本'
$v = $PSVersionTable.PSVersion
if ($v.Major -lt 7) {
  Fail "需要 PowerShell 7+，当前 $v。Windows: winget install Microsoft.PowerShell；macOS: brew install --cask powershell；Ubuntu: 微软官方 apt 源"
}
Write-Host "OK pwsh $v"

# 2. git
Step '检查 git'
$gitVersion = git --version 2>$null
if ($LASTEXITCODE -ne 0 -or -not $gitVersion) { Fail '找不到 git' }
Write-Host "OK $gitVersion"

# 3. hook + 全量测试（install-hooks 内部会跑 tests\run.ps1）
Step '安装 pre-commit hook 并跑全量测试'
$installer = Join-Path $root 'install-hooks.ps1'
if (-not (Test-Path $installer)) { Fail '缺少 install-hooks.ps1（仓库不完整？）' }
& $installer
if ($LASTEXITCODE -ne 0) { Fail 'hook 安装或测试未通过：先修测试，不要提交' }

# 4. 可选：模块分支
if ($Module) {
  $moduleDir = Join-Path (Join-Path (Join-Path (Join-Path $root 'apps') 'api') 'src') "modules\$Module"
  if (-not (Test-Path $moduleDir)) {
    $available = @(Get-ChildItem (Join-Path (Join-Path (Join-Path (Join-Path $root 'apps') 'api') 'src') 'modules') -Directory |
      ForEach-Object { $_.Name })
    Fail "模块不存在：$Module。可选：$($available -join ', ')"
  }

  $branch = 'feat/' + $Module
  Step "准备分支 $branch"
  $existing = @(git branch --list $branch)
  if ($existing.Count -gt 0) {
    git switch $branch 2>&1 | Out-Null
  } else {
    git switch -c $branch 2>&1 | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Fail "建/切分支失败：$branch" }
  Write-Host "OK 当前分支 $branch"
}

# 5. 收尾
Step '下一步'
Write-Host '必读：README.md（快速开始 / 目录 / 测试 / 模块）'
Write-Host '提交前：pwsh -NoProfile -File tests\run.ps1（hook 也会自动跑）'
Write-Host 'BOOTSTRAP-OK'
exit 0
