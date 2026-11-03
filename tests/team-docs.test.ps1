# 人类协作开发文档契约测试：4 人分工、里程碑、环境、DoR/DoD 必须真的写下来。
# 目的：负责人问「文档写好让同事协作开发了吗」时，这份测试就是回答——缺一块就红。
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'assert.ps1')

$docs = Join-Path $root 'docs'

# 1) 团队计划：分工 / 依赖 / 里程碑 / 首周任务 / 节奏 / DoR / DoD / 阻塞
$plan = Join-Path $docs 'TEAM-PLAN.md'
Assert-True (Test-Path $plan) 'docs/TEAM-PLAN.md 存在（四人协作计划）'
if (Test-Path $plan) {
  $p = Get-Content $plan -Raw -Encoding utf8
  foreach ($s in @(
      '## 1. 分工',
      '## 2. 依赖顺序',
      '## 3. 里程碑',
      '## 4. 第 1 周',
      '## 5. 协作节奏',
      '## 6. 开工就绪',
      '## 7. 完成定义',
      '## 8. 当前阻塞'
    )) { Assert-True $p.Contains($s) "TEAM-PLAN 含小节 $s" }

  foreach ($dev in @('Dev A', 'Dev B', 'Dev C', 'Dev D')) {
    Assert-True $p.Contains($dev) "TEAM-PLAN 有 $dev 的分工"
  }
  foreach ($m in @('platform', 'masterdata', 'inventory', 'purchase', 'processing', 'sales', 'internal-trade', 'settlement')) {
    Assert-True $p.Contains($m) "TEAM-PLAN 覆盖模块 $m"
  }
  foreach ($milestone in @('M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7')) {
    Assert-True $p.Contains($milestone) "TEAM-PLAN 含里程碑 $milestone"
  }
  Assert-True ($p.Contains('DoR') -and $p.Contains('DoD')) 'TEAM-PLAN 写明 DoR 与 DoD'
}

# 2) 开发环境：前置 / 安装 / 目录 / 运行 / 测试 / 分支 / 排错 / 缺口
$setup = Join-Path $docs 'DEV-SETUP.md'
Assert-True (Test-Path $setup) 'docs/DEV-SETUP.md 存在（环境与仓库骨架）'
if (Test-Path $setup) {
  $s = Get-Content $setup -Raw -Encoding utf8
  foreach ($sec in @(
      '## 1. 前置条件',
      '## 2. 第一次安装',
      '## 3. 仓库结构',
      '## 4. 本地运行',
      '## 5. 测试',
      '## 6. 分支与提交',
      '## 7. 常见问题',
      '## 8. 当前缺口'
    )) { Assert-True $s.Contains($sec) "DEV-SETUP 含小节 $sec" }
  foreach ($t in @('24 LTS', 'pnpm', 'PostgreSQL', 'apps/api', 'packages/contracts', 'tests\run.ps1')) {
    Assert-True $s.Contains($t) "DEV-SETUP 提到 $t"
  }
}

# 3) 技术栈 ADR（D53 候选）必须可查
$adr = Join-Path $docs 'adr-0001-tech-stack.md'
Assert-True (Test-Path $adr) 'docs/adr-0001-tech-stack.md 存在（技术栈 ADR）'
if (Test-Path $adr) {
  $a = Get-Content $adr -Raw -Encoding utf8
  foreach ($sec in @('## 背景与约束', '## 候选方案', '## 推荐方案', '## 风险与回退', '## 未决项')) {
    Assert-True $a.Contains($sec) "ADR 含小节 $sec"
  }
  Assert-True ($a.Contains('Node.js') -and $a.Contains('Fastify') -and $a.Contains('PostgreSQL')) 'ADR 写明推荐栈的关键组件'
}

# 4) 三个入口互相指向，不能让新人猜
$onboarding = Get-Content (Join-Path $docs 'ONBOARDING.md') -Raw -Encoding utf8
Assert-True ($onboarding.Contains('TEAM-PLAN.md') -and $onboarding.Contains('DEV-SETUP.md')) 'ONBOARDING 指向 TEAM-PLAN 与 DEV-SETUP'

$docsReadme = Get-Content (Join-Path $docs 'README.md') -Raw -Encoding utf8
foreach ($f in @('TEAM-PLAN.md', 'DEV-SETUP.md', 'adr-0001-tech-stack.md')) {
  Assert-True $docsReadme.Contains($f) "docs/README.md 索引了 $f"
}

$agents = Get-Content (Join-Path $root 'AGENTS.md') -Raw -Encoding utf8
Assert-True $agents.Contains('TEAM-PLAN.md') 'AGENTS.md 指向四人协作计划'

Exit-Test
