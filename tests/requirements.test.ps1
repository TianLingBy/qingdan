# 工程护栏契约测试：仓库结构、可点击原型、hook 可复刻、README 第一步。
# 公开仓不含内部文档（口径、契约、检查点），因此这里只校验代码仓自身必须存在的东西。
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'assert.ps1')

# 1) 工作区结构
foreach ($p in @('apps\api', 'apps\web', 'packages\contracts', 'packages\cli', 'packages\mcp', 'tests', 'tools', 'docs\api')) {
  Assert-True (Test-Path (Join-Path $root $p)) "目录存在：$p"
}

# 2) 可点击原型已迁入且不是空壳
$proto = Join-Path $root 'prototype.html'
Assert-True (Test-Path $proto) 'prototype.html 在仓库根目录'
if (Test-Path $proto) {
  Assert-True ((Get-Item $proto).Length -gt 50000) "prototype.html 内容完整 (实际 $((Get-Item $proto).Length) 字节)"
}

# 3) 接口说明书存在（由契约注册表生成，spec-drift job 会校验一致性）
$openapi = Join-Path $root 'docs\api\openapi.yaml'
Assert-True (Test-Path $openapi) 'docs/api/openapi.yaml 存在（pnpm openapi 的产物）'

# 4) 许可与协议
$license = Join-Path $root 'LICENSE'
Assert-True (Test-Path $license) 'LICENSE 存在'
if (Test-Path $license) {
  $licenseText = Get-Content $license -Raw -Encoding utf8
  Assert-True ($licenseText.Contains('GNU AFFERO GENERAL PUBLIC LICENSE')) 'LICENSE 是 AGPL-3.0 正文'
}
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
Assert-Equal 'AGPL-3.0-or-later' $pkg.license 'package.json 的 license 与 LICENSE 一致'

# 5) 脚手架不得混进业务仓
Assert-True (-not (Test-Path (Join-Path $root 'calc.js'))) 'calc 脚手架已删除'

# 6) 工程护栏：hook 可复刻（.git/hooks 不进版本控制）
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

# 7) 仓库说明指向正确的第一步
$readmeRoot = Get-Content (Join-Path $root 'README.md') -Raw -Encoding utf8
Assert-True $readmeRoot.Contains('install-hooks.ps1') 'README 写明 clone 第一步是 install-hooks.ps1'

Exit-Test
