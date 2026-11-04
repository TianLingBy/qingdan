# P0-1 测试底座自检：BOM / Exit-Test / run.ps1 未被改坏。
# 本文件自身同样受这些规则约束（自身带 BOM、结尾调用 Exit-Test）。
. (Join-Path $PSScriptRoot 'assert.ps1')

$testsDir = $PSScriptRoot
$allPs1 = @(Get-ChildItem -Path $testsDir -Filter *.ps1 -File | Sort-Object Name)
$testFiles = @(Get-ChildItem -Path $testsDir -Filter *.test.ps1 -File | Sort-Object Name)

Write-Host "tests/ 下 .ps1 共 $($allPs1.Count) 个，其中 *.test.ps1 $($testFiles.Count) 个" -ForegroundColor Cyan
Assert-True ($allPs1.Count -ge 5) "tests/ 下至少 5 个 .ps1（实际 $($allPs1.Count)）"
Assert-True ($testFiles.Count -ge 3) "tests/ 下至少 3 个 *.test.ps1（实际 $($testFiles.Count)）"

# 1) 所有 .ps1 必须带 UTF-8 BOM（前 3 字节 EF BB BF），否则 5.1 按 GBK 解码中文会炸。
$badBom = @()
foreach ($f in $allPs1) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if ($bytes.Length -ge 3) {
    $first3 = ($bytes[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' '
  } else {
    $first3 = '(不足 3 字节)'
  }
  if (-not $hasBom) { $badBom += "$($f.Name)=$first3" }
  Assert-True $hasBom "BOM $($f.Name) 前3字节=$first3"
}
if ($badBom.Count -gt 0) {
  Write-Host "缺 BOM 的文件：$($badBom -join ', ')" -ForegroundColor Yellow
  Write-Host "补 BOM：`$p='<路径>'; [System.IO.File]::WriteAllText(`$p,[System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes(`$p)),[System.Text.UTF8Encoding]::new(`$true))" -ForegroundColor Yellow
}

# 2) 每个 *.test.ps1 正文必须包含 Exit-Test，否则失败会被静默吞掉（退出码 0）。
foreach ($f in $testFiles) {
  $text = [System.IO.File]::ReadAllText($f.FullName)
  Assert-True ($text -match 'Exit-Test') "$($f.Name) 正文包含 Exit-Test"
}

# 3) run.ps1 必须保持原样语义：枚举 *.test.ps1 + 用 $LASTEXITCODE 判失败（只断言，不改文件）。
$runPath = Join-Path $testsDir 'run.ps1'
Assert-True (Test-Path $runPath) 'tests/run.ps1 存在'
$runText = if (Test-Path $runPath) { [System.IO.File]::ReadAllText($runPath) } else { '' }
Assert-True ($runText -match 'Get-ChildItem') 'run.ps1 用 Get-ChildItem 枚举测试文件'
Assert-True ($runText -match '-Filter\s+\$Filter') 'run.ps1 通过 -Filter $Filter 过滤'
Assert-True ($runText -match '\$Filter = ''\*\.test\.ps1''') "run.ps1 默认 Filter 仍是 '*.test.ps1'"
Assert-True ($runText -match '\$LASTEXITCODE') 'run.ps1 用 $LASTEXITCODE 判单个测试失败'
Assert-True ($runText -match 'ALL PASSED') 'run.ps1 全绿时打印 ALL PASSED'
Assert-True ($runText -match 'FAILED') 'run.ps1 失败时打印 FAILED 汇总'

Exit-Test
