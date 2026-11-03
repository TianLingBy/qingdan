# 安装 Git pre-commit hook。
#
# 为什么需要它：.git/hooks 不进版本控制，clone 之后 hook 是空的，测试等于没有护栏。
# 跑一次这个脚本，会把仓库里受控的 tools/pre-commit 装到 .git/hooks/pre-commit，
# 然后立刻跑一遍全量测试——装上一个跑不过的 hook 等于把自己锁在门外，必须当场发现。
#
# 用法：  pwsh -NoProfile -File install-hooks.ps1
# 重装：  直接再跑一次（幂等，覆盖安装）
# 卸载：  del .git\hooks\pre-commit

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
Set-Location $root

$src = Join-Path $root 'tools\pre-commit'
if (-not (Test-Path $src)) {
  Write-Host "缺少 tools/pre-commit：仓库里没有 hook 源文件，无法安装。" -ForegroundColor Red
  exit 1
}

# hook 目录以 git 自己报的为准：兼容 worktree / submodule（此时 .git 可能是个文件）
$hookRel = (git rev-parse --git-path hooks).Trim()
if ($LASTEXITCODE -ne 0 -or -not $hookRel) {
  Write-Host "取不到 hook 目录（git rev-parse --git-path hooks 失败），当前目录是 git 仓库吗？" -ForegroundColor Red
  exit 1
}
$hookDir = if ([System.IO.Path]::IsPathRooted($hookRel)) { $hookRel } else { Join-Path $root $hookRel }
if (-not (Test-Path $hookDir)) { New-Item -ItemType Directory -Path $hookDir -Force | Out-Null }
$dst = Join-Path $hookDir 'pre-commit'

# 强制 LF 写入：CRLF 的 shebang 会让 sh 直接报 bad interpreter（本机 core.autocrlf=true）
$text = [System.IO.File]::ReadAllText($src) -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($dst, $text, [System.Text.UTF8Encoding]::new($false))

# 可执行位：POSIX 上必须有；Windows 上 chmod 不存在，跳过
if ($env:OS -ne 'Windows_NT') {
  & chmod +x $dst
  if ($LASTEXITCODE -ne 0) { Write-Host "chmod +x 失败：$dst" -ForegroundColor Red; exit 1 }
}

$srcHash = (Get-FileHash $src -Algorithm SHA256).Hash
$dstHash = (Get-FileHash $dst -Algorithm SHA256).Hash
if ($srcHash -ne $dstHash) {
  Write-Host "安装后哈希不一致（行尾被改写了？）源=$srcHash 目标=$dstHash" -ForegroundColor Red
  exit 1
}
Write-Host "已安装 hook：$dst（SHA-256 $($srcHash.Substring(0,12))…，LF）"

# 装上就一定验证一次：跑全量测试
Write-Host "验证：运行 tests\run.ps1 …"
& pwsh -NoProfile -File (Join-Path $root 'tests\run.ps1')
if ($LASTEXITCODE -ne 0) {
  Write-Host "测试未通过。hook 已装上，但当前代码库过不了它——先修测试，否则之后所有提交都会被拦。" -ForegroundColor Red
  exit 1
}
Write-Host "hook 安装完成，测试通过，提交会被自动守护。" -ForegroundColor Green
exit 0
