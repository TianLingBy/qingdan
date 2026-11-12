# L3 真 PostgreSQL 业务流 e2e（#103 第二项）。
#
# 本机没有 PostgreSQL 时自动跳过（打印 SKIP 并算一条通过的断言），CI 的
# `integration (ubuntu-latest, PostgreSQL 18)` job 会带着 QINGDAN_TEST_DB 真正执行。
#
# 覆盖：登录 → 建 E 单 → 完成扣库存 → 生成 C 草稿 → 确认结算。
# 未覆盖：`建 A 单 → 完成入库`（端点已实现，见 docs/local-acceptance-2026-11-12.md
# 第三之二节的手工补测；这里还没接进来，库存仍由脚本造数提供）。
#
# 用法：$env:QINGDAN_TEST_DB='postgres://postgres:postgres@127.0.0.1:5432/qingdan_test'
#       pwsh -NoProfile -File tests/e2e-business-flow.test.ps1
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
  # 同 db-concurrency：工作区依赖 @qingdan/contracts 走 dist/，干净 clone 必须先构建。
  & pnpm -C packages/contracts build 2>&1 | Out-Host
  Assert-True ($LASTEXITCODE -eq 0) "契约包构建成功（退出码 $LASTEXITCODE）"

  & pnpm -C apps/api migrate 2>&1 | Out-Host
  Assert-True ($LASTEXITCODE -eq 0) "真 PG 迁移成功（退出码 $LASTEXITCODE）"

  $output = & pnpm -C apps/api exec tsx src/platform/db/e2e-business-flow.integration.ts 2>&1
  $output | Out-Host
  $code = $LASTEXITCODE
  Assert-True ($code -eq 0) "e2e 业务流通过（退出码 $code）"
  Assert-True (($output -join "`n") -match 'OK e2e-business-flow') '输出包含 OK e2e-business-flow'
}
finally {
  Pop-Location
}

Exit-Test
