# 部署配置漂移守卫：容器/编排/环境变量/运维脚本的关键约定不能被悄悄改坏。
# 本文件只做静态检查（不启动 docker）：CI 机器上也没有 docker，运行验证在目标服务器上做。
. (Join-Path $PSScriptRoot 'assert.ps1')

$root = Split-Path -Parent $PSScriptRoot
function Read-Text([string]$rel) {
  $path = Join-Path $root $rel
  if (-not (Test-Path $path)) { return '' }
  return [System.IO.File]::ReadAllText($path)
}

# 1) 部署相关文件必须齐全（缺一个就等于部署路径断了）。
$required = @(
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  '.env.example',
  'deploy/Caddyfile',
  'docs/deploy.md',
  'ops/backup.ps1',
  'ops/restore.ps1'
)
foreach ($rel in $required) {
  Assert-True (Test-Path (Join-Path $root $rel)) "存在 $rel"
}

# 2) Dockerfile：两阶段 + 非 root + 入口路径必须与 apps/api/package.json 的 main 一致。
$dockerfile = Read-Text 'Dockerfile'
Assert-True ($dockerfile -match '(?m)^FROM\s+node:24-bookworm-slim\s+AS\s+builder') 'Dockerfile 有 builder 阶段（node:24）'
Assert-True ($dockerfile -match '(?m)^FROM\s+node:24-bookworm-slim\s+AS\s+runtime') 'Dockerfile 有 runtime 阶段（node:24）'
Assert-True ($dockerfile -match '(?m)^USER\s+qingdan') 'Dockerfile 以非 root 用户运行'
Assert-True ($dockerfile -match 'dumb-init') 'Dockerfile 用 dumb-init 转发信号（优雅关闭依赖它）'
Assert-True ($dockerfile -match 'pnpm\s+--filter\s+@qingdan/api\s+deploy\s+--prod') 'Dockerfile 用 pnpm deploy 只产生产依赖'

$apiMain = ''
$apiPkgPath = Join-Path $root 'apps/api/package.json'
if (Test-Path $apiPkgPath) {
  $apiMain = (Get-Content $apiPkgPath -Raw | ConvertFrom-Json).main
}
Assert-True ($apiMain -eq './dist/main.js') "apps/api/package.json 的 main 是 ./dist/main.js（实际 [$apiMain]）"
$cmdPath = ($apiMain -replace '^\./', '')
Assert-True ($dockerfile -match [regex]::Escape("apps/api/$cmdPath")) "Dockerfile 的 CMD 指向 apps/api/$cmdPath"

# 3) compose：数据库版本、健康依赖、迁移不随应用自启、健康检查打真实端点。
$compose = Read-Text 'docker-compose.yml'
foreach ($svc in @('postgres:', 'api:', 'caddy:', 'migrate:')) {
  Assert-True ($compose -match "(?m)^\s{2}$([regex]::Escape($svc))") "compose 有服务 $($svc.TrimEnd(':'))"
}
Assert-True ($compose -match 'postgres:18-alpine') 'compose 使用 postgres:18-alpine'
Assert-True ($compose -match 'condition:\s*service_healthy') 'compose 用 service_healthy 串起启动顺序'
Assert-True ($compose -match 'profiles:\s*\["tools"\]') 'migrate 在 tools profile 里（不随应用自启）'
Assert-True ($compose -match '/api/v1/health') 'api 健康检查打 /api/v1/health'
Assert-True ($compose -match 'pgdata:/var/lib/postgresql\b') 'PG18 数据卷挂到 /var/lib/postgresql（不是 .../data）'
Assert-True ($compose -notmatch "`t") 'compose 不含 tab 缩进'

# 4) 环境变量漂移：config.ts 里每一项都必须能在 .env.example 里找到。
$configText = Read-Text 'apps/api/src/platform/config.ts'
# 两种写法都要认：`KEY: schema`（内联）与 `KEY,`（上面用 const 定义、这里简写）。
$configKeys = @(
  [regex]::Matches($configText, '(?m)^\s{2}([A-Z][A-Z0-9_]*):\s') | ForEach-Object { $_.Groups[1].Value }
  [regex]::Matches($configText, '(?m)^\s{2}([A-Z][A-Z0-9_]*),\s*$') | ForEach-Object { $_.Groups[1].Value }
) | Sort-Object -Unique
Assert-True ($configKeys.Count -ge 10) "config.ts 解析到 $($configKeys.Count) 个环境变量"

$envText = Read-Text '.env.example'
$envKeys = [regex]::Matches($envText, '(?m)^([A-Z][A-Z0-9_]*)\s*=') |
  ForEach-Object { $_.Groups[1].Value } |
  Sort-Object -Unique

$missing = @($configKeys | Where-Object { $envKeys -notcontains $_ })
Assert-True ($missing.Count -eq 0) ".env.example 覆盖 config.ts 全部环境变量（缺：$($missing -join ', ')）"
Assert-True ($envKeys -contains 'DATABASE_URL') '.env.example 有 DATABASE_URL'
Assert-True ($envKeys -contains 'SITE_ADDRESS') '.env.example 有 SITE_ADDRESS（Caddy 站点地址）'

# .env 绝不入库：被 gitignore 忽略，且没有被跟踪。
$gitignore = Read-Text '.gitignore'
Assert-True ($gitignore -match '(?m)^\.env\r?$') '.gitignore 忽略 .env'
Assert-True ((Read-Text '.gitignore') -match '!\.env\.example') '.gitignore 放行 .env.example（模板要入库）'

# 5) 运维脚本：带 BOM（否则 Windows PowerShell 5.1 按 GBK 解码中文会炸）+ 语法解析通过。
foreach ($rel in @('ops/backup.ps1', 'ops/restore.ps1')) {
  $path = Join-Path $root $rel
  if (-not (Test-Path $path)) { continue }
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $first3 = if ($bytes.Length -ge 3) { ($bytes[0..2] | ForEach-Object { $_.ToString('X2') }) -join ' ' } else { '(不足 3 字节)' }
  Assert-True $hasBom "$rel 带 UTF-8 BOM（前3字节=$first3）"

  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Assert-True ($errors.Count -eq 0) "$rel 语法解析 0 错误（实际 $($errors.Count)）"
}

# 6) 迁移只能由 migrate 服务跑：应用入口不应内联执行迁移（防止「启动即改库」）。
$mainText = Read-Text 'apps/api/src/main.ts'
Assert-True ($mainText -notmatch 'runMigrations') 'apps/api/src/main.ts 启动时不跑迁移'

Exit-Test
