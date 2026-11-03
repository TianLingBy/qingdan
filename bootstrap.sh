#!/usr/bin/env bash
# 轻单工程仓一键初始化（macOS / Linux）。幂等，可重复跑。
# 用法： ./bootstrap.sh            只做环境（装 hook + 跑全量测试）
#        ./bootstrap.sh platform   环境 + 建 feat/platform 分支
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE="${1:-}"
cd "$ROOT"

fail() { printf 'BOOTSTRAP-FAIL %s\n' "$1" >&2; exit 1; }
step() { printf '== %s\n' "$1"; }

[ -d .git ] || fail "不在仓库根（找不到 .git）：$ROOT"
[ -f AGENTS.md ] || fail "找不到 AGENTS.md，目录不对：$ROOT"

command -v git >/dev/null 2>&1 || fail "找不到 git"
command -v pwsh >/dev/null 2>&1 || fail "需要 PowerShell 7（pwsh）。macOS: brew install --cask powershell；Ubuntu: 微软官方 apt 源"

step "安装 pre-commit hook 并跑全量测试"
pwsh -NoProfile -File "$ROOT/install-hooks.ps1" || fail "hook 安装或测试未通过：先修测试，不要提交"

if [ -n "$MODULE" ]; then
  [ -f "$ROOT/docs/module-$MODULE.md" ] || fail "模块不存在：$MODULE（见 docs/ONBOARDING.md §4 的表格）"
  case "$MODULE" in
    platform)       suffix="main-platform" ;;
    sales)          suffix="main-sales" ;;
    settlement)     suffix="main-settlement" ;;
    masterdata)     suffix="m1-masterdata" ;;
    purchase)       suffix="m1-purchase" ;;
    inventory)      suffix="m2-inventory" ;;
    processing)     suffix="m3-processing" ;;
    internal-trade) suffix="m4-internal-trade" ;;
    *) fail "模块 $MODULE 没有登记交付分支（见 docs/TEAM-PLAN.md §0）" ;;
  esac
  branch="feat/$suffix"
  step "准备分支 $branch"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git switch "$branch" >/dev/null
  else
    git switch -c "$branch" >/dev/null
  fi
  echo "OK 当前分支 $branch"
  echo "认领清单："
  echo "  1) 打开 docs/module-$MODULE.md，把「当前状态」改成：进行中（<你的名字>，YYYY-MM-DD）"
  echo "  2) 读该文件的「开放项」「验收标准」「相关文件」三节"
  echo "  3) 开放项先拍板（追加 docs/decisions.md），再写代码"
  echo "  4) 提交前跑：pwsh -NoProfile -File tests/run.ps1"
fi

step "下一步"
echo "必读：docs/ONBOARDING.md（分工/DoD/PR 模板）→ docs/README.md → docs/module-<你的模块>.md"
echo "提交前：pwsh -NoProfile -File tests/run.ps1（hook 也会自动跑）"
echo "BOOTSTRAP-OK"
