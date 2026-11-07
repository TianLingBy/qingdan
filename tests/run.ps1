# 项目测试入口：逐个执行 tests\*.test.ps1（子进程隔离），任一失败即退出码 1。
param([string]$Filter = '*.test.ps1')

$files = @(Get-ChildItem -Path $PSScriptRoot -Filter $Filter -File | Sort-Object Name)
if ($files.Count -eq 0) {
  Write-Host "没有匹配的测试文件: $Filter" -ForegroundColor Yellow
  exit 1
}

$failures = @()
foreach ($f in $files) {
  Write-Host "== $($f.Name)" -ForegroundColor Cyan
  & pwsh -NoProfile -File $f.FullName
  if ($LASTEXITCODE -ne 0) { $failures += $f.Name }
}

if ($failures.Count -gt 0) {
  Write-Host "FAILED ($($failures -join ', '))" -ForegroundColor Red
  exit 1
}
Write-Host "ALL PASSED ($($files.Count) files)" -ForegroundColor Green
exit 0
