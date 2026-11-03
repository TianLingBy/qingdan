# 交接完整性契约测试：需求产物必须真的在工程仓里、模块映射齐全、工程护栏可用。
# 目的：防止「迁移只在对话里发生过」——归档仓冻结后，这些文件是本仓唯一可用的需求源。
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'assert.ps1')

$docs = Join-Path $root 'docs'

# 1) 产品文档齐全（从归档仓迁入的 9 份）
$productDocs = @(
  'decisions.md'
  '轻单_接口契约第一批_v1_20261103.md'
  '轻单_接口契约第二批_v1_20261103.md'
  '轻单_接口契约第三批_v1_20261104.md'
  '轻单_业务事实问答_v1_20261103.md'
  '轻单_阻塞问题决策清单_v1_20261103.md'
  'project-context.md'
  'prototype-v0.md'
  'roadmap.md'
  'raw-protocol.md'
)
foreach ($f in $productDocs) {
  Assert-True (Test-Path (Join-Path $docs $f)) "已迁入 docs/$f"
}

# 2) 口径真源与契约冻结标记
$decisions = Get-Content (Join-Path $docs 'decisions.md') -Raw -Encoding utf8
Assert-True $decisions.Contains('D50') 'decisions.md 含 D1-D50 口径'
Assert-True $decisions.Contains('## 1. 已拍板') 'decisions.md 含已拍板总表'

$c1 = Get-Content (Join-Path $docs '轻单_接口契约第一批_v1_20261103.md') -Raw -Encoding utf8
$c2 = Get-Content (Join-Path $docs '轻单_接口契约第二批_v1_20261103.md') -Raw -Encoding utf8
Assert-True ($c1.Contains('已冻结') -and $c1.Contains('§11')) '第一批契约已冻结且保留开放项 §11'
Assert-True ($c2.Contains('已冻结') -and $c2.Contains('§4')) '第二批契约已冻结且保留开放项 §4'

$c3 = Get-Content (Join-Path $docs '轻单_接口契约第三批_v1_20261104.md') -Raw -Encoding utf8
Assert-True ($c3.Contains('操作日志') -and $c3.Contains('API Token')) '第三批契约含操作日志与 API Token'
Assert-True ($c3.Contains('开放项') -and $c3.Contains('草案')) '第三批为草案并列出开放项'
Assert-True ($decisions.Contains('D51') -and $decisions.Contains('D52')) 'decisions 含 D51（操作日志）/ D52（AI 友好）'
Assert-True $decisions.Contains('D52.1') 'decisions 含 D52.1（AI 权限不可放大）'

# 3) 原料区：只放原文，11 篇，frontmatter 五字段齐全
$rawDir = Join-Path $docs 'raw'
Assert-True (Test-Path $rawDir) 'docs/raw/ 存在'
if (Test-Path $rawDir) {
  $rawFiles = @(Get-ChildItem $rawDir -Recurse -File)
  Assert-Equal 11 $rawFiles.Count 'docs/raw/ 有 11 篇原文'
  $nonMd = @($rawFiles | Where-Object { $_.Extension -ne '.md' })
  Assert-True ($nonMd.Count -eq 0) "docs/raw/ 无非 .md 文件 (实际: $(($nonMd | ForEach-Object { $_.Name }) -join ', '))"
  $missing = @()
  foreach ($f in @($rawFiles | Where-Object { $_.Extension -eq '.md' })) {
    $txt = Get-Content $f.FullName -Raw -Encoding utf8
    foreach ($k in @('title:', 'space:', 'node_token:', 'source:', '搬出日期:')) {
      if (-not $txt.Contains($k)) { $missing += "$($f.Name)缺$k" }
    }
  }
  Assert-True ($missing.Count -eq 0) "原文 frontmatter 五字段齐全 (缺失: $($missing -join '; '))"
}

# 4) 可点击原型已迁入且不是空壳
$proto = Join-Path $root 'prototype.html'
Assert-True (Test-Path $proto) 'prototype.html 已迁入工程仓根目录'
if (Test-Path $proto) {
  Assert-True ((Get-Item $proto).Length -gt 50000) "prototype.html 内容完整 (实际 $((Get-Item $proto).Length) 字节)"
}

# 5) 模块映射：AGENTS.md 登记的每个模块都有检查点，且检查点写全了新增小节
$agentsText = Get-Content (Join-Path $root 'AGENTS.md') -Raw -Encoding utf8
$names = @([regex]::Matches($agentsText, '`([a-z0-9-]+)`\s*→\s*`docs/module-\1\.md`') | ForEach-Object { $_.Groups[1].Value })
Assert-Equal 9 $names.Count 'AGENTS.md 登记 9 个模块（8 业务 + test）'

$extraSections = @('## 范围与页面', '## 依赖', '## 开放项', '## 验收标准')
$readme = Get-Content (Join-Path $docs 'README.md') -Raw -Encoding utf8
foreach ($n in $names) {
  $cp = Join-Path $docs "module-$n.md"
  Assert-True (Test-Path $cp) "模块 $n 的检查点存在"
  if (-not (Test-Path $cp)) { continue }
  $t = Get-Content $cp -Raw -Encoding utf8
  foreach ($s in $extraSections) { Assert-True $t.Contains($s) "module-$n 含小节 $s" }
  if ($n -ne 'test') { Assert-True ($t.Contains('docs/decisions.md') -or $t.Contains('decisions.md')) "module-$n 引用了口径真源" }  # test 是基础设施模块，不对口径负责
  Assert-True $readme.Contains("module-$n.md") "docs/README.md 索引了 module-$n"
}

# 6) 脚手架不得混进业务仓
Assert-True (-not (Test-Path (Join-Path $root 'calc.js'))) 'calc 脚手架已删除'
Assert-True (-not $agentsText.Contains('module-calc')) 'AGENTS.md 不再登记 calc'

# 7) 阶段路线已切到阶段 4
$roadmap = Get-Content (Join-Path $docs 'roadmap.md') -Raw -Encoding utf8
Assert-True $roadmap.Contains('## 阶段路线') 'roadmap 含阶段路线'
Assert-True $roadmap.Contains('4 分工开发') 'roadmap 含阶段 4'
Assert-True ($roadmap.Contains('🔄 进行中') -and $roadmap.Contains('阶段 4 进行中')) 'roadmap 已标阶段 4 进行中'
Assert-True $roadmap.Contains('阶段 4 交接') 'roadmap 变更记录含交接条目'

# 8) 工程护栏：hook 可复刻（.git/hooks 不进版本控制）
$hookSrc = Join-Path (Join-Path $root 'tools') 'pre-commit'
Assert-True (Test-Path $hookSrc) 'tools/pre-commit 存在（hook 源文件已纳入 git）'
Assert-True (Test-Path (Join-Path $root 'install-hooks.ps1')) 'install-hooks.ps1 存在（新 clone 一键安装）'
$gitattr = Join-Path $root '.gitattributes'
Assert-True (Test-Path $gitattr) '.gitattributes 存在（钉死 hook 的 LF 行尾）'
if (Test-Path $gitattr) {
  Assert-True ((Get-Content $gitattr -Raw -Encoding utf8).Contains('tools/pre-commit text eol=lf')) '.gitattributes 声明 tools/pre-commit 用 LF'
}
$hookDst = Join-Path (Join-Path (Join-Path $root '.git') 'hooks') 'pre-commit'
if ((Test-Path $hookDst) -and (Test-Path $hookSrc)) {
  $hSrc = (Get-FileHash $hookSrc -Algorithm SHA256).Hash
  $hDst = (Get-FileHash $hookDst -Algorithm SHA256).Hash
  Assert-True ($hSrc -eq $hDst) "tools/pre-commit 与已安装 hook 内容一致（源 $($hSrc.Substring(0,12))…，装 $($hDst.Substring(0,12))…）"
} else {
  Write-Host 'SKIP  未安装 hook（clone 后先跑 install-hooks.ps1）'
}

# 9) 仓库说明指向正确的第一步
$readmeRoot = Get-Content (Join-Path $root 'README.md') -Raw -Encoding utf8
Assert-True $readmeRoot.Contains('install-hooks.ps1') 'README 写明 clone 第一步是 install-hooks.ps1'

Exit-Test
