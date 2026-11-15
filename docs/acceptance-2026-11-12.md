# 全产品验收记录（2026-11-12）

范围：当前 main 68b3154 + 本地 R/S 审计、强 ETag 修复。按 22 页路由、前端接口、后端实现和任务分工静态核查。未进行浏览器逐页操作，不作为完整上线验收通过证明。真 PostgreSQL 并发与业务集成因未设置测试数据库跳过；Docker 不可用。

## 22 页检查矩阵

| 页面 | 本轮结论 | 负责方 |
|---|---|---|
| 登录/入企 | 登录及短信发送器已实现；注册入企明确为一期不开放，真实短信未验 | 主线；页面李祖怡 |
| 工作台 | 使用 workbench-mock，待办和本人负责单据不是真实数据 | 主线提供能力；李祖怡接线 |
| 业务全流程图 | 页面已挂载，不能代替业务闭环验收 | 李祖怡 |
| 采购 A | 前端缺完成入库动作，后端已具备 | 李祖怡；主线联调 |
| 加工 B | 前端缺完成动作；后端详情固定返回空产出批次/损失记录 | 李祖怡前端；梁海俊后端 |
| 销售 E | 已有完成接口接线；仍需真实跨模块业务验收 | 李祖怡；主线 |
| 内部交易 N | 前端仅列表/创建/详情/修改/取消，缺发货和到货确认 | 李祖怡；梁海俊后端配合 |
| 结算 C | 已接页面；确认时解析提成配置，草稿提成为零不直接判缺陷 | 李祖怡；主线 |
| 冲正 R/S/I | R/S 缺完成入口；I 已有审批接线 | 李祖怡；主线联调 |
| 商品资料 | 已有页面及主数据接口，浏览器验收待做 | 梁海俊 |
| 客户 | 已有页面及接口，浏览器验收待做 | 黄锦城 |
| 供应商 | 已有页面及接口，浏览器验收待做 | 梁海俊 |
| 加工厂 | 已有页面及接口，浏览器验收待做 | 梁海俊 |
| 库存数量 | 已有页面；库存详情 pendingOccupancies 固定空数组，需确认一期边界 | 梁海俊 |
| 库存流水 | 已有页面及查询接线，跨单据实测待做 | 梁海俊 |
| 盘点 | 已有页面与审批接线，真实数据库验收待做 | 梁海俊 |
| 员工 | 权限覆盖面板仅保留本次提交记录，刷新后不可回读；岗位基线仍提示接口未上线 | 温汇敏；主线契约支持 |
| 权限设置 | 页面已挂载，需角色/公司组合浏览器验收 | 温汇敏 |
| 公司管理 | 页面已挂载；全局公司切换按钮仍禁用 | 温汇敏；李祖怡框架、主线会话口径 |
| 利润报表 | 路由存在但 IMPLEMENTED_PAGE_IDS 和组件映射均缺失，落到 PlaceholderPage | 梁海俊 |
| 操作日志 | 页面已挂载；R/S 完成审计修复尚未提交 | 温汇敏；主线 |
| API 与集成 | 页面已挂载，令牌真实权限验收待做 | 温汇敏；主线 |

## 确定缺口的代码证据

- apps/web/src/router/implemented.ts：缺 profit-report；router.tsx 的 PageForEntry 对无映射项使用 PlaceholderPage。
- apps/web/src/pages/workbench/WorkbenchPage.tsx、workbench-mock.ts：待办和进行中数据为模拟数据。
- apps/web/src/pages/purchase/purchase-api.ts、processing/processing-api.ts、internal-trades/internal-trades-api.ts、reversals/reversals-api.ts：缺上述完成/发货/到货调用。
- apps/api/src/modules/processing/usecases/processing-orders.ts:298：outputBatchId 和 lossRecord 固定 null。
- apps/web/src/layouts/AppLayout.tsx:122：公司切换禁用、提示待接口。
- apps/web/src/pages/employees/PermissionOverridePanel.tsx:252：覆盖记录刷新后不再展示。
- apps/api/src/modules/inventory/repo.ts:167：pendingOccupancies 固定空数组。注释称一期边界，暂列待确认，不直接判必须实现。

## 黄锦城/主线的下一步

1. 提交并评审本地 R/S 修复和回归测试。
2. 为工作台真实数据确认/补齐契约与服务能力，交李祖怡接线。
3. 与温汇敏明确权限覆盖回读接口、公司切换的会话语义；已有公司列表接口不应仍被页面称为未实现。
4. 组织 A/B/E/N/C/R/S/I 的真实数据库业务验收；#79/#99 暂不视为全产品已验收。
5. 督办李祖怡补 A/B/N/R/S 前端流转，梁海俊补利润报表页面及 B 详情。
6. 推进设计 #202 对齐后再放行 #153/#154；设计稿由何永上/赖皓妍负责。

部署和支付另列原任务，本记录不重复扩大范围。文档引用的 docs/decisions.md 与 docs/prototype-v0.md 在当前工作树缺失，需要主线核对产品真源。
