# 轻单本机部署：把仓库最新代码同步到部署目录并升级服务（2026-11-17）
#
# 为什么需要它：E:\qingdan-server\app 是仓库的**快照**，不是 git 工作树。
# 靠手工 copy 很容易停在旧版本（实测 11-17 时它还停在迁移 0030，落后仓库 5 个迁移）。
# 这个脚本把「备数据 -> 同步代码 -> 摆本机覆盖文件 -> 重建镜像 -> 跑迁移 -> 重启 -> 自检」
# 串成一条命令，每一步都可单独跳过（-SkipBackup / -SkipBuild）。
#
# 用法：
#   pwsh -File ops/local/sync-up.ps1                       # 全流程
#   pwsh -File ops/local/sync-up.ps1 -SkipBackup           # 已经手动备过
#   pwsh -File ops/local/sync-up.ps1 -DryRun               # 只看会做什么，不动手
#
# 不会碰的东西：.env（含密码与 pepper）、ops/backups（历史备份）、apps/web/dist（前端产物）

[CmdletBinding()]
param(
  [string]$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$DeployRoot = 'E:\qingdan-server',
  [string]$Distro     = 'Ubuntu',
  [switch]$SkipBackup,
  [switch]$SkipBuild,
  [switch]$SkipFrontend,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppDir     = Join-Path $DeployRoot 'app'
$WslAppDir  = '/mnt/e/qingdan-server/app'

function Say([string]$m) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $m) }
function Die([string]$m) { throw "[sync-up] $m" }

# WSL 里执行 docker compose 的统一入口：-T 关掉 tty，输出才能被捕获
function Compose([string]$composeArgs) {
  $cmd = "cd $WslAppDir && docker compose $composeArgs"
  if ($DryRun) { Say "DRY  wsl -d $Distro -u root -- bash -lc `"$cmd`""; return '' }
  $out = & wsl.exe -d $Distro -u root -- bash -lc $cmd 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Write-Host $out; Die "docker compose $composeArgs 失败（exit=$LASTEXITCODE）" }
  return $out
}

# ---------- 0. 前置检查 ----------
if (-not (Test-Path (Join-Path $AppDir '.env'))) { Die "找不到 $AppDir\.env，这不像部署目录" }
if (-not (Test-Path (Join-Path $RepoRoot 'docker-compose.yml'))) { Die "RepoRoot=$RepoRoot 不是轻单仓库根" }

$before = (& git -C $RepoRoot rev-parse --short HEAD 2>&1 | Out-String).Trim()
$branch = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
Say "源仓库：$RepoRoot ($branch @ $before)"
Say "部署目录：$AppDir"

# ---------- 1. 先备份（不可逆动作之前必须留退路） ----------
if ($SkipBackup) {
  Say '跳过备份（-SkipBackup）'
} else {
  Say '触发一次数据库备份 ...'
  if (-not $DryRun) {
    & wsl.exe -d $Distro -u root -- systemctl start qingdan-backup.service 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'qingdan-backup.service 启动失败' }
    $latest = Get-ChildItem (Join-Path $AppDir 'ops\backups') -Filter '*.dump' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { Die '备份目录里没有 .dump，拒绝继续（防止删列类迁移无处回滚）' }
    $ageMin = ((Get-Date) - $latest.LastWriteTime).TotalMinutes
    if ($ageMin -gt 10) { Die "最新备份是 $([math]::Round($ageMin,1)) 分钟前的，备份可能没跑成功" }
    Say "备份就绪：$($latest.Name)（$([math]::Round($latest.Length/1MB,1)) MB）"
  }
}

# ---------- 2. 同步代码 ----------
# /E 复制子目录含空目录；不用 /MIR，避免删掉部署目录里本机特有的东西。
# 排除：.env（密码）、.git（大）、node_modules（体积）、dist（自己构建）、
#       ops\backups（历史备份）、ops\local（本机覆盖文件单独摆）
Say '同步代码到部署目录 ...'
$rcArgs = @(
  $RepoRoot, $AppDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:2',
  '/XD', '.git', 'node_modules', 'dist', (Join-Path $RepoRoot 'ops\backups'),
  '/XF', '.env', '.env.local'
)
if ($DryRun) {
  Say ("DRY  robocopy " + ($rcArgs -join ' '))
} else {
  & robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "robocopy 失败（exit=$LASTEXITCODE）" }
  Say '代码已同步'
}

# ---------- 3. 摆本机覆盖文件 ----------
# compose 只会自动读**根目录**的 docker-compose.override.yml，
# 所以仓库 ops/local 下的那份必须复制到 app 根；Caddyfile.local 放 deploy/。
if (-not $DryRun) {
  Copy-Item (Join-Path $RepoRoot 'ops\local\docker-compose.override.yml') (Join-Path $AppDir 'docker-compose.override.yml') -Force
  Copy-Item (Join-Path $RepoRoot 'ops\local\Dockerfile.local')            (Join-Path $AppDir 'Dockerfile.local') -Force
  Copy-Item (Join-Path $RepoRoot 'ops\local\Caddyfile.local')             (Join-Path $AppDir 'deploy\Caddyfile.local') -Force
  Say '本机覆盖文件已就位（docker-compose.override.yml / Dockerfile.local / deploy\Caddyfile.local）'
}

# ---------- 4. 重建镜像 ----------
# 2026-11-17 踩过的坑：只 `build api` 会漏掉 migrate 自己的镜像。
# compose 里 migrate 是独立 build（target: builder），不重建它就会拿四天前的旧镜像跑，
# 旧镜像里的迁移文件列表是旧的，于是输出 `applied=0 skipped=30` 假装「都跑过了」，
# 结果库里缺 6 个迁移、api 启动被 schema-guard 拦下、整站 502。
if ($SkipBuild) {
  Say '跳过镜像重建（-SkipBuild）'
} else {
  Say '重建 api 与 migrate 镜像（这一步最慢，依赖层有缓存）...'
  Compose 'build api migrate' | Out-Null
  Say '镜像已重建'
}

# ---------- 5. 跑迁移（迁移不随应用自启，必须显式执行） ----------
Say '执行数据库迁移 ...'
$migrate = Compose '--profile tools run --rm migrate'
if ($migrate) { $migrate -split "`n" | Where-Object { $_ -match 'applied|已应用|skip|error|FAIL' } | Select-Object -Last 12 | ForEach-Object { Say "  $_" } }

# ---------- 6. 起服务 ----------
# `up -d` 等 api 过健康检查，启动慢时会先报 unhealthy 再自己转好（实测 10 秒后 ps 就是 healthy）。
# 所以这里失败不直接退出，等一轮再按 ps 判，避免把「慢」当「坏」。
Say '重启服务 ...'
try {
  Compose 'up -d' | Out-Null
} catch {
  Say 'up -d 报 unhealthy，等 60 秒后按实际状态判定 ...'
  if (-not $DryRun) { Start-Sleep -Seconds 60 }
  $ps = Compose 'ps --format "{{.Service}} {{.State}} {{.Status}}"'
  if ($ps) { $ps -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Say "  $_" } }
  if ($ps -notmatch 'api +running') { Die 'api 没有起来，查 docker compose logs api' }
  Say 'api 已就绪（启动慢，不是失败）'
}

# ---------- 7. 前端构建并发布（Caddy 直接挂 apps/web/dist，不重建镜像） ----------
if ($SkipFrontend) {
  Say '跳过前端发布（-SkipFrontend）'
} else {
  Say '构建前端 ...'
  if (-not $DryRun) {
    # apps/web 依赖 @qingdan/contracts 等 workspace 包的 dist，
    # 干净 worktree 里直接 `pnpm -C apps/web build` 会报 Cannot find module '@qingdan/contracts'。
    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
      Say '  首次运行，安装依赖 ...'
      & pnpm -C $RepoRoot install --frozen-lockfile 2>&1 | Select-Object -Last 2 | ForEach-Object { Say "  $_" }
    }
    & pnpm -C $RepoRoot -r build 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "  $_" }
    $src = Join-Path $RepoRoot 'apps\web\dist'
    $dst = Join-Path $AppDir 'apps\web\dist'
    if (-not (Test-Path $src)) { Die "前端产物不存在：$src" }
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $src $dst -Recurse -Force
    Say '前端已发布到 apps/web/dist'
  }
}

# ---------- 8. 自检 ----------
Start-Sleep -Seconds 8
Say '自检 ...'
$health = & curl.exe -sS --ssl-no-revoke -m 20 -o NUL -w '%{http_code}' 'https://qingdan.internal/api/v1/health' 2>&1
$root   = & curl.exe -sS --ssl-no-revoke -m 20 -o NUL -w '%{http_code}' 'https://qingdan.internal/' 2>&1
Say "https://qingdan.internal/api/v1/health = $health（期望 200）"
Say "https://qingdan.internal/ = $root（期望 200）"
if ($health -ne '200') { Die "健康检查没过（$health），服务可能没起来，查 docker compose logs api" }
Say '完成。'
