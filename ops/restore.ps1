#Requires -Version 7.4
<#
.SYNOPSIS
  轻单备份恢复演练：把 dump 恢复到临时库，并比对关键表行数，打印 PASS/FAIL。

.DESCRIPTION
  - 默认恢复到 qingdan_restore_check，**不碰生产库**；
  - 目标临时库已存在时默认拒绝操作，显式 -Force 才会重建（只删除这个临时库）；
  - 恢复后逐表比对源库与临时库的 count(*)：tenant、employee、product、
    sales_order、inventory_batch、payment_transaction；
  - 任一行数不一致或查询失败 → 打印 FAIL 并 exit 1；
  - 演练结束后保留临时库供人工抽查，清理命令见脚本末尾提示。

.PARAMETER DumpPath
  pg_dump -Fc 生成的 .dump 文件路径（相对路径按仓库根解析）。

.PARAMETER TargetDb
  恢复到的临时库名，默认 qingdan_restore_check。

.PARAMETER Force
  目标临时库已存在时，先断开连接并删除重建。默认不加，避免误删。

.EXAMPLE
  pwsh -File ops/restore.ps1 -DumpPath ops/backups/qingdan-20261108-153000.dump

.EXAMPLE
  pwsh -File ops/restore.ps1 -DumpPath ops/backups/qingdan-20261108-153000.dump -Force
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DumpPath,

  [ValidatePattern('^[a-z_][a-z0-9_]{0,62}$')]
  [string]$TargetDb = 'qingdan_restore_check',

  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$opsDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $opsDir

# 相对路径统一按仓库根解析。
if (-not [System.IO.Path]::IsPathRooted($DumpPath)) {
  $DumpPath = Join-Path $repoRoot $DumpPath
}
if (-not (Test-Path -LiteralPath $DumpPath -PathType Leaf)) {
  throw "备份文件不存在：$DumpPath"
}
$DumpPath = (Resolve-Path -LiteralPath $DumpPath).Path

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw '未找到 docker 命令：请先安装 Docker Desktop / Docker Engine（本机当前未安装，无法恢复演练）。'
}

# 关键表：恢复后必须与源库行数一致。
$tables = @(
  'tenant',
  'employee',
  'product',
  'sales_order',
  'inventory_batch',
  'payment_transaction'
)

function Invoke-Psql {
  param(
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Sql
  )

  $output = & docker compose exec -T postgres psql -U $script:pgUser -d $Database -v ON_ERROR_STOP=1 -tAc $Sql
  if ($LASTEXITCODE -ne 0) {
    throw "psql 执行失败（库 $Database）：$Sql"
  }
  return ($output | Out-String).Trim()
}

Push-Location $repoRoot
try {
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'docker compose 不可用：请确认已安装 Compose v2 插件。'
  }

  & docker compose exec -T postgres pg_isready *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'postgres 容器未运行或未就绪：先执行 docker compose up -d postgres。'
  }

  # 从容器环境读取源库身份，脚本里不保存账号口令。
  $script:pgUser = ((& docker compose exec -T postgres printenv POSTGRES_USER) | Out-String).Trim()
  $sourceDb = ((& docker compose exec -T postgres printenv POSTGRES_DB) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($script:pgUser) -or [string]::IsNullOrWhiteSpace($sourceDb)) {
    throw '无法从 postgres 容器读取 POSTGRES_USER / POSTGRES_DB，请检查 .env 与服务状态。'
  }

  Write-Host "[restore] 源库：$sourceDb（用户 $($script:pgUser)）"
  Write-Host "[restore] 备份：$DumpPath"
  Write-Host "[restore] 目标：$TargetDb"

  # ---- 1) 准备临时库 ------------------------------------------------------
  $exists = Invoke-Psql -Database $sourceDb -Sql "SELECT 1 FROM pg_database WHERE datname = '$TargetDb'"
  if ($exists -eq '1') {
    if (-not $Force) {
      throw "目标库 $TargetDb 已存在。确认可覆盖后加 -Force（只会删除这个临时库）。"
    }
    Write-Host "[restore] -Force：删除并重建临时库 $TargetDb"
    Invoke-Psql -Database $sourceDb -Sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TargetDb' AND pid <> pg_backend_pid()" *> $null
    Invoke-Psql -Database $sourceDb -Sql "DROP DATABASE `"$TargetDb`"" *> $null
  }

  Invoke-Psql -Database $sourceDb -Sql "CREATE DATABASE `"$TargetDb`"" *> $null
  Write-Host "[restore] 临时库已创建。"

  # ---- 2) 恢复 ------------------------------------------------------------
  # pg_restore 从 stdin 读自定义格式，cmd 的 `<` 重定向是字节级，避免 PowerShell 管道转码。
  # --clean --if-exists：目标是全新库，重复对象的 DROP 会静默跳过，保证可重复执行。
  $cmdLine = 'docker compose exec -T postgres pg_restore -U {0} -d {1} --no-owner --no-privileges --clean --if-exists --exit-on-error < "{2}"' -f `
    $script:pgUser, $TargetDb, $DumpPath
  Write-Host '[restore] 正在恢复……'
  & cmd.exe /d /c $cmdLine
  if ($LASTEXITCODE -ne 0) {
    throw "pg_restore 失败（退出码 $LASTEXITCODE），临时库 $TargetDb 保留供排查。"
  }

  # ---- 3) 行数比对 --------------------------------------------------------
  Write-Host ''
  Write-Host ('{0,-24} {1,12} {2,12}   {3}' -f '表', '源库', '临时库', '结果')
  Write-Host ('-' * 62)

  $failures = @()
  foreach ($table in $tables) {
    try {
      $sourceCount = Invoke-Psql -Database $sourceDb -Sql "SELECT count(*) FROM public.$table"
      $restoreCount = Invoke-Psql -Database $TargetDb -Sql "SELECT count(*) FROM public.$table"
      if ($sourceCount -eq $restoreCount) {
        Write-Host ('{0,-24} {1,12} {2,12}   PASS' -f $table, $sourceCount, $restoreCount)
      }
      else {
        Write-Host ('{0,-24} {1,12} {2,12}   FAIL' -f $table, $sourceCount, $restoreCount)
        $failures += "$table（源 $sourceCount / 恢复 $restoreCount）"
      }
    }
    catch {
      Write-Host ('{0,-24} {1,12} {2,12}   FAIL' -f $table, 'ERROR', 'ERROR')
      $failures += "$table（查询失败：$($_.Exception.Message)）"
    }
  }

  Write-Host ''
  if ($failures.Count -gt 0) {
    Write-Host "[restore] FAIL：$($failures.Count) 张表不一致 → $($failures -join '；')" -ForegroundColor Red
    Write-Host "[restore] 临时库 $TargetDb 已保留，排查后可手动清理。"
    exit 1
  }

  Write-Host "[restore] PASS：$($tables.Count) 张关键表行数一致。" -ForegroundColor Green
  Write-Host "[restore] 临时库 $TargetDb 仍保留（不做自动删除）。抽查后可清理："
  Write-Host "  docker compose exec -T postgres psql -U $($script:pgUser) -d $sourceDb -c 'DROP DATABASE `"$TargetDb`"'"
}
finally {
  Pop-Location
}
