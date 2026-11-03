# 协作者接入契约测试：一键初始化入口必须齐、文档必须能自解释、各 Agent 指针必须指向真源。
# 目的：协作者（不同 Agent）clone 后只读一份文档就能完成初始化，不靠口头传话。
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'assert.ps1')

# 1) 一键初始化脚本：Windows / macOS·Linux 各一份，内容必须真的调用 hook 与测试
$bootPs1 = Join-Path $root 'bootstrap.ps1'
$bootSh = Join-Path $root 'bootstrap.sh'
Assert-True (Test-Path $bootPs1) 'bootstrap.ps1 存在（Windows / pwsh）'
Assert-True (Test-Path $bootSh) 'bootstrap.sh 存在（macOS / Linux）'

if (Test-Path $bootPs1) {
  $b = Get-Content $bootPs1 -Raw -Encoding utf8
  Assert-True $b.Contains('install-hooks.ps1') 'bootstrap.ps1 会装 hook'
  Assert-True $b.Contains('PSVersion') 'bootstrap.ps1 校验 PowerShell 版本'
  Assert-True $b.Contains('BOOTSTRAP-OK') 'bootstrap.ps1 有成功标志'
  Assert-True $b.Contains('feat/') 'bootstrap.ps1 会建 feat/<模块> 分支'
  Assert-True ($b.Contains('module-') -and $b.Contains('Module')) 'bootstrap.ps1 校验模块检查点'
}
if (Test-Path $bootSh) {
  $b = Get-Content $bootSh -Raw -Encoding utf8
  Assert-True $b.Contains('install-hooks.ps1') 'bootstrap.sh 会装 hook'
  Assert-True $b.Contains('BOOTSTRAP-OK') 'bootstrap.sh 有成功标志'
  Assert-True $b.Contains('feat/') 'bootstrap.sh 会建 feat/<模块> 分支'
}

# 2) 协作文档：单一入口，覆盖初始化/分工/必读/交付/失败处置/Agent 对照
$onboarding = Join-Path (Join-Path $root 'docs') 'ONBOARDING.md'
Assert-True (Test-Path $onboarding) 'docs/ONBOARDING.md 存在（协作者唯一入口）'
if (Test-Path $onboarding) {
  $o = Get-Content $onboarding -Raw -Encoding utf8
  foreach ($s in @(
      '## 0. 完成定义',
      '## 2. 一键初始化',
      '## 4. 分工与分支',
      '## 5. 必读文档',
      '## 6. 干活与交付',
      '## 7. 常见失败与处置',
      '## 8. 各 Agent 的入口对照'
    )) { Assert-True $o.Contains($s) "ONBOARDING 含小节 $s" }

  $modules = @('platform', 'masterdata', 'inventory', 'purchase', 'processing', 'sales', 'internal-trade', 'settlement', 'test')
  foreach ($m in $modules) {
    Assert-True ($o.Contains("``$m``") -and $o.Contains("feat/$m")) "ONBOARDING 覆盖模块 $m 与其分支"
  }
  Assert-True $o.Contains('待认领') 'ONBOARDING 分工表有认领状态列'
  Assert-True $o.Contains('DoD') 'ONBOARDING 写明完成定义（DoD）'
  Assert-True $o.Contains('decisions.md') 'ONBOARDING 指向口径真源'
}

# 3) 各 Agent 指针：全部存在且都指向 ONBOARDING（规则真源仍是 AGENTS.md）
$pointers = [ordered]@{
  'CLAUDE.md'                       = 'Claude Code'
  'GEMINI.md'                       = 'Gemini CLI'
  '.cursor\rules\qingdan.mdc'       = 'Cursor'
  '.github\copilot-instructions.md' = 'GitHub Copilot'
}
foreach ($file in $pointers.Keys) {
  $agent = $pointers[$file]
  $path = Join-Path $root $file
  Assert-True (Test-Path $path) "$agent 指针文件存在 ($file)"
  if (Test-Path $path) {
    Assert-True ((Get-Content $path -Raw -Encoding utf8).Contains('ONBOARDING.md')) "$agent 指针指向 docs/ONBOARDING.md"
  }
}

# 4) 真源与索引都指向接入流程
$agentsText = Get-Content (Join-Path $root 'AGENTS.md') -Raw -Encoding utf8
Assert-True $agentsText.Contains('docs/ONBOARDING.md') 'AGENTS.md 指向协作者接入文档'
Assert-True $agentsText.Contains('bootstrap.ps1') 'AGENTS.md 指向一键初始化脚本'
$readmeRoot = Get-Content (Join-Path $root 'README.md') -Raw -Encoding utf8
Assert-True $readmeRoot.Contains('bootstrap.ps1') 'README 写出一键初始化命令'
$docsReadme = Get-Content (Join-Path (Join-Path $root 'docs') 'README.md') -Raw -Encoding utf8
Assert-True $docsReadme.Contains('ONBOARDING.md') 'docs/README.md 索引了 ONBOARDING'

# 5) PR 模板：协作者交付时有统一检查项
$prTemplate = Join-Path (Join-Path $root '.github') 'pull_request_template.md'
Assert-True (Test-Path $prTemplate) '.github/pull_request_template.md 存在'
if (Test-Path $prTemplate) {
  $pr = Get-Content $prTemplate -Raw -Encoding utf8
  Assert-True $pr.Contains('检查项') 'PR 模板含检查项'
  Assert-True ($pr.Contains('tests') -and $pr.Contains('CI')) 'PR 模板要求本地测试 + CI'
  Assert-True $pr.Contains('docs/module-') 'PR 模板要求更新模块检查点'
}

Exit-Test
