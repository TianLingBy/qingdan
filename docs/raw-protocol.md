# docs/raw/ 搬运协议

> 本文件是**规则文档**，不放在 `docs/raw/` 里（该目录只留飞书原文）。文件名 `raw-protocol.md` 意在表明它是「raw 区的协议」。

`docs/raw/` 只放**从飞书 wiki 原样搬下来的文档**，不做改写。改写产出放 `docs/` 根下（`project-context.md`、`roadmap.md`、`module-*.md`）。
除原文 `.md` 与原文所在的子目录外，`docs/raw/` 下不允许出现任何其它文件（说明、脚本、图片、临时文件都不行）。

## 每份原文必须有的 frontmatter

```yaml
---
title: "文档标题"
space: "知识空间名"
obj_type: docx
node_token: "wiki 节点 token"
source: https://feishu.cn/wiki/<node_token>
搬出日期: 2026-11-03
---
```

缺 `source` 或 `搬出日期` 的文件视为不可追溯，整理阶段不予采信。

## 怎么搬

工具已纳入仓库，受控副本在 `tools\feishu-wiki-export.cjs`（原始位置与改动登记见 `AGENTS.md`「外部依赖登记」，**以后改这里、从这里跑**）。

```powershell
# 1) 先验权限，只列目录树不写盘
node tools\feishu-wiki-export.cjs --dry-run

# 2) 确认目录树正确后落盘
node tools\feishu-wiki-export.cjs --out D:\Desktop\dsh\轻单\docs\raw

# 3) 离线自检（不联网，验证参数解析、文件名清洗、凭证加载、frontmatter 生成）
node tools\feishu-wiki-export.cjs --self-test
```

凭证来源（二选一，都不进仓库）：

- 环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
- `~/.dsh/feishu-export.json`：`{"appId":"...","appSecret":"..."}`（**驼峰**，写成 `app_id` 会被判为未配置）

## 已知限制

- 只搬 `docx` 类型节点；表格 / 多维表格 / 附件会被列入「跳过」，需人工处理。
- 正文取 `raw_content`（纯文本），飞书里的图片、评注、内嵌块**不会**被搬下来。
- 权限不足时脚本会直接报 `code=99991672` 并提示该开哪个权限，不会静默产出空文件。
- **画板（block_type 43）内容拿不到**：`raw_content` 对画板只回标题，`/docx/v1/documents/{id}/blocks` 也只有一个 `board` 空壳，飞书没有画板转文本的接口。
- 同空间同名文档用 `node_token` 尾 8 位区分（例：两个「思维导图」→ `思维导图.md` 与 `思维导图-cblWdnQW.md`），不会互相覆盖。

## 本次搬运结果（2026-11-03）

空间「掌单产品基础功能结构」，11 个节点，全部 `docx`，跳过 0、失败 0。

| 文件 | 正文 | 说明 |
|---|---|---|
| `初步想法.md` | 334 字 | 真实文本（愿景、空间简介、常用链接） |
| `员工.md` | 456 字 | 真实文本，含权限分配表（`raw_content` 把表格拍平成纯文本，列关系需人工复原） |
| `订单结构图（非正式排版）.md` 等 9 篇 | 仅标题 | **画板**，用户已决定不补 |

9 篇画板：`订单结构图（非正式排版）`、`项目分工图`、`用户基础工作流程图`、`客户`、`仓库`、`订单`、`账号`、`思维导图`×2。

## 画板内容怎么补（已决定不补，留档备查）

1. 在飞书里把画板「转为文档」→ 存到同一 wiki 节点下 → 重跑搬运命令，空壳会被真文本覆盖。
2. 或者把画板内容写成文字 / 截图贴进会话，合并进对应 md，并在 frontmatter 追加 `board_note: 手工补录（<来源>）`。

## 采信口径

这批是**背景材料，不是需求规格**。用户已说明「这几份规划本身就不完善，只是让你大概了解项目是什么」。
因此：提炼 `docs/project-context.md` 时只取方向与词汇，不把其中任何一条当作约束或验收标准；模块规格以阶段 3 与用户确认的结果为准。

## 术语：本项目正名「轻单」（2026-11-03 用户确认）

- **轻单** 是唯一正名。产出文档（`project-context.md`、`roadmap.md`、`module-*.md`、代码注释）一律写「轻单」。
- 飞书原文里的「掌单」「掌单可视化页面」是原作者用词。**原料区不做改写**（保全可追溯性），所以目录名、frontmatter 的 `space`、正文里的「掌单」保持原样。
- 检索历史材料时「轻单」「掌单」两个词都要搜。
