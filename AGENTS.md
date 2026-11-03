# 项目级指令（自动注入）

> 由 `@deepseek-ai/dsh-agent-instructions` 在会话首次请求时自动加载。
> 加载链：`~/.dsh/AGENTS.md`（全局）→ 本文件（项目根）→ 更深层目录的 AGENTS.md（若有）。
> 越具体越优先：本项目规则与全局冲突时，以本项目为准。

## 项目信息

- 项目根：`D:\Desktop\dsh\Qingdan`
- 与本项目相关的会话，cwd 都应是这个目录（派发外部代理时工作目录随之固定）。
- 测试入口：`tests\run.ps1`。
- 模块列表（新增模块时在这里登记；格式固定为“反引号模块名 → 反引号检查点路径”，检查点测试靠它解析）：
  - `test` → `docs/module-test.md`

## 路由（引用全局，不重复定义）

全局 `~/.dsh/AGENTS.md` 的「多智能体路由」已规定：

- 深度编码、代码审查、架构第二意见 → `conductor_dispatch(agent:"claude-code")`
- 边界清晰、可验证的实现类任务 → `conductor_dispatch(agent:"codex")`
- 探索性讨论、需求澄清、写文档 → 自己做，不派发

项目内追加两条：

- 派发任务的提示里必须写项目根的绝对路径，并说明「只改本模块相关文件」。
- 派发前若不确定范围，先 `dryRun: true` 核对 cwd 与 argv。

## 检查点

- 每个模块一份 `docs/module-<模块名>.md`，模板见 `docs/module-template.md`。
- 一个工作段落结束后**立刻**更新对应检查点：已完成 / 当前状态 / 下一步 / 坑。
- 新会话开场不要依赖记忆，先读本文件 + 对应模块检查点再动手。

## 测试

- 改完跑 `pwsh -NoProfile -File tests\run.ps1`，退出码 0 才算通过。
- 新增测试 = `tests\<模块>.test.ps1`：点源 `assert.ps1`，结尾**必须**调 `Exit-Test`。忘了调 → 脚本退出码 0，失败会被静默吞掉。

## 禁止事项

- 不改项目根以外的文件（尤其不要动 `D:\Desktop\dsh\daliy` 里其他会话的东西）。
- 不在项目里放密钥明文；provider key 一律留在 `~/.codex/config.toml`、`~/.claude/settings.json`。
- 不擅自 `git init` / 删 `.git` / 改分支策略。
