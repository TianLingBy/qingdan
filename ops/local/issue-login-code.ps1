﻿# 本机部署专用：给某个手机号签发一条「登录验证码」。
#
# 为什么需要它：生产模式（NODE_ENV=production）下登录只认 login_code 表里的一次性验证码，
# 而本机没接短信服务（TENCENT_SMS_* 全空），点「发送验证码」会返回 501。
# 这个脚本绕过短信通道，直接把一条码写进数据库，等价于「平台侧已经发过短信」。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File E:\qingdan-server\issue-login-code.ps1
#   powershell -ExecutionPolicy Bypass -File E:\qingdan-server\issue-login-code.ps1 -Phone 10000000002 -Code 135790
#
# 注意：验证码是一次性的（登录成功即 consumed_at 置位），再登录要重新签发。

param(
  [string]$Phone = '10000000001',
  [string]$Code = '000000',
  [int]$ValidMinutes = 43200   # 30 天
)

$ErrorActionPreference = 'Stop'
$appDir = 'E:\qingdan-server\app'
$envFile = Join-Path $appDir '.env'

if (-not (Test-Path $envFile)) { throw "找不到 $envFile" }

$pepper = $null
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*LOGIN_CODE_PEPPER\s*=\s*(.+)$') { $pepper = $Matches[1].Trim() }
}
if (-not $pepper) { throw '.env 里没有 LOGIN_CODE_PEPPER' }

# 与 apps/api/src/modules/platform/usecases/send-code.ts 的 hashLoginCode 保持一致：
# sha256(`${phone}:${code}:${pepper}`) 的小写 hex
$sha = [System.Security.Cryptography.SHA256]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes("${Phone}:${Code}:${pepper}")
$hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
$sha.Dispose()

$id = [guid]::NewGuid().ToString()
$sql = @"
INSERT INTO login_code (id, phone, purpose, code_hash, expires_at, request_ip, request_id)
VALUES ('$id', '$Phone', 'login', '$hash', now() + interval '$ValidMinutes minutes', '127.0.0.1', 'local-issue-$(Get-Date -Format yyyyMMddHHmmss)');
SELECT phone, expires_at, consumed_at FROM login_code WHERE id = '$id';
"@

$sqlPath = Join-Path $appDir '.tmp-login-code.sql'
[System.IO.File]::WriteAllText($sqlPath, $sql.Replace("`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))

try {
  $out = wsl.exe -d Ubuntu -u root -- bash -lc "cd /mnt/e/qingdan-server/app && docker compose exec -T postgres psql -U qingdan -d qingdan -v ON_ERROR_STOP=1 -f - < .tmp-login-code.sql" 2>&1
  $out | ForEach-Object { $_ }
  if ($LASTEXITCODE -ne 0) { throw "psql 退出码 $LASTEXITCODE" }
} finally {
  Remove-Item $sqlPath -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "已签发验证码：手机号 $Phone  验证码 $Code  有效期 $ValidMinutes 分钟（一次性，登录成功即失效）"
Write-Host '打开 https://qingdan.internal/ → 手机号 + 这个验证码 → 登录'
