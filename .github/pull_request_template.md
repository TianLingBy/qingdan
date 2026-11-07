## 这个 PR 做了什么

<!-- 一句话 -->

## 范围

- 模块 / 目录：
- 变更类型：<!-- 功能 / 修复 / 重构 / 测试 / 文档 / CI -->

## 阻塞关系（必填，没有就写「无」）

- Blocked by:
- Blocks:

## 检查项

- [ ] `pnpm -r build` 通过
- [ ] `pwsh -NoProfile -File tests\run.ps1` 本地全绿（hook 也会跑）
- [ ] 契约有改动时已重新生成 `docs/api/openapi.yaml`（`pnpm openapi`）并一并提交
- [ ] 跨模块影响已在下方列清（没有就写「无」）

## 跨模块影响

<!-- 改了 packages/contracts、apps/api/src/platform、数据库迁移等共享面，必须列出受影响模块 -->

## 怎么验证

<!-- 复现步骤 / 关键输出；涉及界面给截图 -->

## 备注 / 未验证

<!-- 没验证的事写在这里，不要写「应该没问题」 -->
