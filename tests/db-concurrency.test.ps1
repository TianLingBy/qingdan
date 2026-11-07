# L3 真 PostgreSQL 集成检查（#103 / D57③ 的落地文件）。
#
# 本机没有 PostgreSQL 时自动跳过（打印 SKIP 并算一条通过的断言），CI 的
# `integration (ubuntu-latest, PostgreSQL 18)` job 会带着 QINGDAN_TEST_DB 真正执行。
#
# 用法：$env:QINGDAN_TEST_DB='postgres://postgres:postgres@127.0.0.1:5432/qingdan_test'
#       pwsh -NoProfile -File tests/db-concurrency.test.ps1
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'assert.ps1')

$dbUrl = $env:QINGDAN_TEST_DB
if ([string]::IsNullOrWhiteSpace($dbUrl)) { $dbUrl = $env:DATABASE_URL }
if ([string]::IsNullOrWhiteSpace($dbUrl)) {
  Write-Host 'SKIP 未设置 QINGDAN_TEST_DB / DATABASE_URL：本机无真 PG，跳过（CI integration job 会真跑）。'
  Assert-True $true '无真 PG 环境下跳过（不是误报绿灯：CI 上会执行）'
  Exit-Test
}

$env:DATABASE_URL = $dbUrl
Push-Location $root
try {
  # tsx 直接跑 api 的源码，但工作区依赖 @qingdan/contracts 走的是构建产物 dist/，
  # 所以 CI（以及任何干净 clone）必须先构建契约包，否则 migrate 会报 MODULE_NOT_FOUND。
  & pnpm -C packages/contracts build 2>&1 | Out-Host
  Assert-True ($LASTEXITCODE -eq 0) "契约包构建成功（退出码 $LASTEXITCODE）"

  & pnpm -C apps/api migrate 2>&1 | Out-Host
  Assert-True ($LASTEXITCODE -eq 0) "真 PG 迁移成功（退出码 $LASTEXITCODE）"

  $output = & pnpm -C apps/api exec tsx src/platform/db/db-concurrency.integration.ts 2>&1
  $output | Out-Host
  $code = $LASTEXITCODE
  Assert-True ($code -eq 0) "db-concurrency 检查通过（退出码 $code）"
  Assert-True (($output -join "`n") -match 'OK db-concurrency') '输出包含 OK db-concurrency'
}
finally {
  Pop-Location
}

Exit-Test
