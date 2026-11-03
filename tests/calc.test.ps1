# calc 模块业务测试：通过 node 调 calc.js，断言真实返回值而不是文档契约。
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'assert.ps1')

# require('./calc.js') 按 cwd 解析，所以必须在项目根下跑 node。
Push-Location $root
try {
  $expr = "const{add}=require('./calc.js');console.log(JSON.stringify([add(1,2),add(-1,1),add(0.5,0.25)]))"
  $json = & node -e $expr
  Assert-Equal 0 $LASTEXITCODE '正常输入时 node 退出码为 0'

  $v = $json | ConvertFrom-Json
  Assert-Equal 3 $v[0] 'add(1,2) = 3'
  Assert-Equal 0 $v[1] 'add(-1,1) = 0'
  Assert-Equal 0.75 $v[2] 'add(0.5,0.25) = 0.75'

  $null = & node -e "const{add}=require('./calc.js');add('1',2)" 2>&1
  Assert-True ($LASTEXITCODE -ne 0) 'add(字符串, 数字) 抛错，而不是静默拼成 12'
} finally {
  Pop-Location
}

Exit-Test
