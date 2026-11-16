﻿# 轻单本机服务器启动器（2026-11-12）
# 作用：把 WSL2 里的 docker 栈拉起来，并对局域网发布 80/443。
# 为什么需要：WSL2 发行版在最后一个客户端进程退出后会自己停（实测 90 秒内就 Stopped），
# 所以必须留一个 keep-alive 进程；WSL 重启后 IP 可能变，portproxy 也要重设。
# 用法：pwsh -File E:\qingdan-server\start-server.ps1   （需要管理员：要改 portproxy 与防火墙规则）
#       不带参数时如果 WSL 已经跑着也会照常重设 portproxy，可重复执行。

[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu',
  [string]$AppDir = '/mnt/e/qingdan-server/app',
  [string]$HostName = 'qingdan.internal',
  [int[]]$Ports = @(80, 443)
)

$ErrorActionPreference = 'Continue'
function Say($m) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $m) }

# 1. 确保发行版在跑（第一次调用会把 VM 拉起来）
Say "启动 WSL 发行版 $Distro ..."
& wsl.exe -d $Distro -u root --exec /bin/true 2>&1 | Out-Null

# 2. keep-alive：没有就起一个 sleep infinity 顶住，WSL 就不会自己停
$alive = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*sleep*infinity*' }
if ($alive) {
  Say "keep-alive 已在运行 (pid=$($alive.ProcessId -join ','))"
} else {
  Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'root', '--exec', '/bin/sleep', 'infinity') -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Say "keep-alive 已启动"
}

# 3. 等 docker 服务 + 容器就位（最多 120 秒）
$ok = $false
for ($i = 0; $i -lt 24; $i++) {
  $state = (& wsl.exe -d $Distro -u root --exec systemctl is-active docker 2>&1 | Out-String).Trim()
  if ($state -eq 'active') { $ok = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $ok) { Say '警告：docker.service 没起来，后面步骤会失败'; }
Say "docker.service=$state"

# 4. 确保 compose 栈在跑（restart: unless-stopped 正常会自动起，这里只是兜底）
$ps = (& wsl.exe -d $Distro -u root --exec bash -lc "cd $AppDir && docker compose ps --format '{{.Name}} {{.Status}}'" 2>&1 | Out-String).Trim()
Say ("容器：`n" + $ps)
$running = ($ps -split "`n" | Where-Object { $_ -match 'qingdan-api-1' -and $_ -match 'Up' }).Count -gt 0
if (-not $running) {
  Say '容器未运行，执行 docker compose up -d'
  & wsl.exe -d $Distro -u root --exec bash -lc "cd $AppDir && docker compose up -d" 2>&1 | Out-Null
  Start-Sleep -Seconds 15
}

# 5. WSL IP（每次重启可能变）→ 重设 portproxy（80 与 443 都要）
$ipLine = (& wsl.exe -d $Distro -u root --exec hostname -I 2>&1 | Out-String).Trim()
$wslIp = ($ipLine -split '\s+')[0]
if (-not $wslIp) { throw '拿不到 WSL IP' }
Say "WSL IP = $wslIp"

foreach ($port in $Ports) {
  & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>&1 | Out-Null
  & netsh.exe interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp 2>&1 | Out-Null
  Say "portproxy 0.0.0.0:$port -> ${wslIp}:$port (exit=$LASTEXITCODE)"

  $ruleName = if ($port -eq 443) { 'Qingdan HTTPS 443' } else { "Qingdan HTTP $port" }
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
    Say "已加防火墙入站规则 $ruleName"
  }
}
$svc = Get-Service iphlpsvc -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') { Start-Service iphlpsvc; Say 'iphlpsvc 已启动' }

# 6. 自检：本机 HTTP（期望 301 跳 HTTPS）、本机 HTTPS、局域网 HTTPS
Start-Sleep -Seconds 5
$httpLocal = & curl.exe -sS --ssl-no-revoke -m 15 -o NUL -w '%{http_code}' "http://127.0.0.1/api/v1/health" 2>&1
$httpsLocal = & curl.exe -sS --ssl-no-revoke -m 15 -o NUL -w '%{http_code}' "https://$HostName/api/v1/health" 2>&1
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|172\.(1[7-9]|2[0-9]|3[01])\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
Say "http://127.0.0.1=$httpLocal（期望 301）  https://$HostName=$httpsLocal  局域网 IP=$lanIp"
Say '完成。'
