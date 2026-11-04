# 检查点契约测试：模板小节、AGENTS.md 模块登记、检查点文件三者必须一致。
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'assert.ps1')

$sections = @(
  '## 目标'
  '## 当前状态'
  '## 已完成'
  '## 进行中'
  '## 下一步'
  '## 已知问题 / 坑'
  '## 相关文件'
)

$template = Join-Path (Join-Path $root 'docs') 'module-template.md'
$agents = Join-Path $root 'AGENTS.md'
Assert-True (Test-Path $template) 'docs/module-template.md 存在'
Assert-True (Test-Path $agents) 'AGENTS.md 存在'

$templateText = Get-Content $template -Raw -Encoding utf8
foreach ($s in $sections) { Assert-True $templateText.Contains($s) "模板含小节 $s" }

# 解析 AGENTS.md 里 “`name` → `docs/module-name.md`” 形式的登记行
$agentsText = Get-Content $agents -Raw -Encoding utf8
$names = @([regex]::Matches($agentsText, '`([a-z0-9-]+)`\s*→\s*`docs/module-\1\.md`') | ForEach-Object { $_.Groups[1].Value })
Assert-True ($names.Count -gt 0) 'AGENTS.md 已登记至少一个模块'

foreach ($n in $names) {
  $cp = Join-Path (Join-Path $root 'docs') "module-$n.md"
  Assert-True (Test-Path $cp) "模块 $n 的检查点存在 (docs/module-$n.md)"
  if (-not (Test-Path $cp)) { continue }

  $t = Get-Content $cp -Raw -Encoding utf8
  foreach ($s in $sections) { Assert-True $t.Contains($s) "module-$n 含小节 $s" }

  $m = [regex]::Match($t, '## 当前状态\s*\r?\n\s*(.+?)\r?\n')
  $status = if ($m.Success) { $m.Groups[1].Value.Trim() } else { '' }
  Assert-True ($status.Length -gt 0 -and $status -notmatch '^（') "module-$n 的当前状态已填写 (实际: '$status')"
}

Exit-Test
