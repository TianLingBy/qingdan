# 轻单 · 成员开工入口

**你只需要读完这一页就能开工**；更细的东西等你卡住再点。

## 第 0 步：核验你是谁

**核验没过 → 不许领任务、不许写代码。**
1. 问带你入伙的人：我的中文姓名、GitHub 账号、负责模块分别是什么？
2. 运行 `gh api user --jq .login`（没有 gh 就打开 GitHub 个人主页看用户名），须等于你报的账号。
3. 确认 `docs/members/<中文姓名>.md` 存在且档案 PR 已合并；查看 `docs/module-<模块>.md` 顶部「负责人」。
**核验通过 → 你的模块和第一个 PR 在 `docs/members/<姓名>.md` 里，照做即可。**
完整门槛与处置见 [`docs/ONBOARDING.md`](ONBOARDING.md) §0.0。

## 第 1 步：三条命令

把 `<模块名>` 换成你档案里的模块；三条命令依次执行。

| 有 gh | 没 gh |
|---|---|
| 先在终端执行 `gh auth login`，登录本人 GitHub 账号。 | 先在 GitHub 网页登录本人账号；clone 时按浏览器提示授权。 |

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan
pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>
```

末行出现 `BOOTSTRAP-OK` 才算初始化成功。

## 第 2 步：你的第一个 PR

完成标志：成员档案填满、已在模块文档登记负责人、贴出 `tests\run.ps1` 的真实成功输出，并提交 PR。
PR 标题写：`chore(members): 登记 <姓名> 的成员档案`。
合并规则见 PR 模板与 `ROLES-AND-BOUNDARIES`。
- CI 三项全绿后，**你自己点合并**（网页绿色 Merge pull request → Squash and merge），不需要等负责人；
- 若属于严重变更（契约/迁移/权限/跨模块），在 PR 上打 `需批准` 标记并 @TianLingBy，等他批。

## 第 3 步：之后怎么接活

去 [GitHub Issues](https://github.com/TianLingBy/qingdan/issues) 看你名下的 issue；没有 gh 就直接点这个网页链接，后续通知看 GitHub 邮件。
每次开工前先跑 `pwsh -NoProfile -File scripts/sync-check.ps1`，它会告诉你：有没有人在动你的依赖、口径最近改了什么、你在等谁。

## 卡住了看哪份

- 接入和排错：[`docs/ONBOARDING.md`](ONBOARDING.md)
- 你的身份与任务：`docs/members/<姓名>.md`
- 模块边界与验收：`docs/module-<模块名>.md`

**不要问「我该干什么」，你的档案第一行就写着；档案没合并 = 还没开工**
