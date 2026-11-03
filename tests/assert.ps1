# 极简断言：供 *.test.ps1 点源使用。失败计数放 $global，Exit-Test 据此给退出码。
$global:TestFailed = 0
$global:TestPassed = 0

function Assert-True([bool]$Condition, [string]$Message) {
  if ($Condition) {
    $global:TestPassed++
    Write-Host "PASS  $Message"
  } else {
    $global:TestFailed++
    Write-Host "FAIL  $Message" -ForegroundColor Red
  }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  Assert-True ("$Expected" -eq "$Actual") "$Message (期望 [$Expected]，实际 [$Actual])"
}

function Exit-Test {
  if ($global:TestFailed -gt 0) {
    Write-Host "FAILED $($global:TestFailed) / $($global:TestPassed + $global:TestFailed)" -ForegroundColor Red
    exit 1
  }
  Write-Host "OK $($global:TestPassed) checks" -ForegroundColor Green
  exit 0
}
