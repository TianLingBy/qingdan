# 轻单 · 成员开工入口

**你只需要读完这一页就能开工**；更细的东西等你卡住再点。

## 第 0 步：核验你是谁

先确认你的中文姓名、GitHub 账号、负责模块；再用成员档案和模块文档交叉核对。
拿不到答案或对不上，立即停下问带你入伙的人，不要猜、不要顶替。
完整门槛和处置只看 [`docs/ONBOARDING.md`](ONBOARDING.md) §0.0。

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

## 第 3 步：之后怎么接活

去 [GitHub Issues](https://github.com/TianLingBy/qingdan/issues) 看你名下的 issue；没有 gh 就直接点这个网页链接，后续通知看 GitHub 邮件。

## 卡住了看哪份

- 接入和排错：[`docs/ONBOARDING.md`](ONBOARDING.md)
- 你的身份与任务：`docs/members/<姓名>.md`
- 模块边界与验收：`docs/module-<模块名>.md`

**不要问「我该干什么」，你的档案第一行就写着；档案没合并 = 还没开工**
