#!/usr/bin/env bash
# 轻单工程仓一键初始化（macOS / Linux）：装 hook、跑全量测试，可选建模块分支。幂等。
# 用法：./bootstrap.sh [模块名]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

fail() { echo "BOOTSTRAP-FAIL $1" >&2; exit 1; }
step() { echo "== $1"; }

[ -d .git ] || fail "不在仓库根（找不到 .git）：$ROOT"
[ -f package.json ] || fail "找不到 package.json，目录不对：$ROOT"

step "检查 PowerShell 7（测试入口是 .ps1）"
command -v pwsh >/dev/null 2>&1 || fail "需要 PowerShell 7+：https://learn.microsoft.com/powershell/scripting/install/installing-powershell"
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' || fail "pwsh 不可用"

step "检查 git"
git --version >/dev/null 2>&1 || fail "找不到 git"

step "安装 pre-commit hook 并跑全量测试"
[ -f install-hooks.ps1 ] || fail "缺少 install-hooks.ps1（仓库不完整？）"
pwsh -NoProfile -File ./install-hooks.ps1 || fail "hook 安装或测试未通过：先修测试，不要提交"

MODULE="${1:-}"
if [ -n "$MODULE" ]; then
  [ -d "apps/api/src/modules/$MODULE" ] || fail "模块不存在：$MODULE（见 apps/api/src/modules/）"

  BRANCH="feat/$MODULE"
  step "准备分支 $BRANCH"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git switch "$BRANCH" >/dev/null
  else
    git switch -c "$BRANCH" >/dev/null
  fi
  echo "OK 当前分支 $BRANCH"
fi

step "下一步"
echo "必读：README.md（快速开始 / 目录 / 测试 / 模块）"
echo "提交前：pwsh -NoProfile -File tests/run.ps1（hook 也会自动跑）"
echo "BOOTSTRAP-OK"
