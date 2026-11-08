#Requires -Version 7.4
<#
.SYNOPSIS
  轻单数据库备份：用 pg_dump 自定义格式（-Fc）导出，并按份数或天数清理旧备份。

.DESCRIPTION
  - 在仓库根目录执行 `docker compose exec -T postgres pg_dump`，输出到 ops/backups/；
  - 文件名形如 qingdan-20261108-153000.dump，按时间戳天然不重名，可重复执行；
  - 只删除 ops/backups 下匹配 qingdan-*.dump 的文件，不碰其它文件，也不删刚生成的这一份；
  - 需要 PowerShell 7.4+（原生命令的 `>` 重定向按字节写入，不会把二进制转成文本）。

.PARAMETER KeepCount
  保留最近多少份备份（默认 14）。必须 >= 1，当前这次备份永远保留。

.PARAMETER KeepDays
  额外按天数清理：> 0 时，早于 N 天的备份也会删除（默认 0 = 只按份数保留）。

.PARAMETER OutDir
  备份目录，默认 ops/backups。相对路径按仓库根解析。

.EXAMPLE
  pwsh -File ops/backup.ps1

.EXAMPLE
  pwsh -File ops/backup.ps1 -KeepCount 30

.EXAMPLE
  pwsh -File ops/backup.ps1 -KeepDays 7
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 10000)]
  [int]$KeepCount = 14,

  [ValidateRange(0, 3650)]
  [int]$KeepDays = 0,

  [string]$OutDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$opsDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $opsDir

# 相对路径统一按仓库根解析，避免受调用者当前目录影响。
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $opsDir 'backups'
}
elseif (-not [System.IO.Path]::IsPathRooted($OutDir)) {
  $OutDir = Join-Path $repoRoot $OutDir
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw '未找到 docker 命令：请先安装 Docker Desktop / Docker Engine（本机当前未安装，无法备份）。'
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

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $target = Join-Path $OutDir "qingdan-$stamp.dump"
  if (Test-Path -LiteralPath $target) {
    throw "目标文件已存在，拒绝覆盖：$target"
  }

  Write-Host "[backup] 开始导出：$target"
  # sh -lc 让 pg_dump 直接读容器内的 POSTGRES_USER / POSTGRES_DB，避免在脚本里存库名口令。
  & docker compose exec -T postgres sh -lc 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > $target
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    throw "pg_dump 失败（退出码 $LASTEXITCODE），已删除不完整的备份文件。"
  }

  $size = (Get-Item -LiteralPath $target).Length
  if ($size -le 0) {
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    throw 'pg_dump 产物为空，备份失败。'
  }
  Write-Host ("[backup] 完成：{0}（{1:N2} MB）" -f $target, ($size / 1MB))

  # ---- 清理旧备份（只处理本目录下的 qingdan-*.dump）-----------------------
  $all = @(
    Get-ChildItem -LiteralPath $OutDir -Filter 'qingdan-*.dump' -File |
      Sort-Object LastWriteTime -Descending
  )

  $stale = @()
  if ($KeepDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    $stale += @($all | Where-Object { $_.LastWriteTime -lt $cutoff })
  }
  $stale += @($all | Select-Object -Skip $KeepCount)

  $stale = @(
    $stale |
      Sort-Object FullName -Unique |
      Where-Object { $_.FullName -ne $target }
  )

  foreach ($file in $stale) {
    Remove-Item -LiteralPath $file.FullName -Force
    Write-Host "[backup] 已清理旧备份：$($file.Name)"
  }

  $remaining = @(Get-ChildItem -LiteralPath $OutDir -Filter 'qingdan-*.dump' -File).Count
  Write-Host "[backup] 当前保留 $remaining 份备份（KeepCount=$KeepCount，KeepDays=$KeepDays）。"
}
finally {
  Pop-Location
}
