# 本机真机验收记录（2026-11-12，Windows + WSL2）

补齐 `docs/acceptance-2026-11-12.md` 里因环境缺失跳过的三项：Docker 不可用、真 PostgreSQL 并发与业务集成、浏览器逐页验收。

## 环境

| 项 | 值 |
| --- | --- |
| 部署目录 | `E:\qingdan-server\app`（仓库快照 `2d6c450` + 本机 override） |
| 运行时 | WSL2 Ubuntu 26.04 + docker.io 29.1.3 + compose 2.40.3 |
| 数据库 | postgres:18-alpine，PostgreSQL 18.6，迁移 30 条，public 表 47 张 |
| 应用 | 三容器 `postgres` / `api` / `caddy`，`NODE_ENV=production`，端口固定 3000 |
| 入口 | `https://qingdan.internal`（Caddy `tls internal`，CA 已装入 Windows 根存储），80 端口 301 跳转 |
| host 映射 | `C:\Windows\System32\drivers\etc\hosts` → `127.0.0.1 qingdan.internal` |
| 测试库 | `qingdan_test`（宿主经 `172.27.161.101:5433` 访问，端口发布在 WSL 网络命名空间内，`127.0.0.1:5433` 不通） |

## 一、自动化测试（本机全量）

```powershell
$env:QINGDAN_TEST_DB = 'postgres://qingdan:<密码>@172.27.161.101:5433/qingdan_test'
pwsh -NoProfile -File tests\run.ps1
```

结果：

```text
== pnpm -r build
PASS pnpm -r build 退出码为 0 (期望 [0]，实际 [0])
== pnpm -r test
PASS pnpm -r test 退出码为 0 (期望 [0]，实际 [0])
OK 8 checks
...
ALL PASSED (7 files)
```

- 单测/渲染测试：`33` 个文件 `289` 条全绿（含 `apps/api` 11 条 HTTP 测试）。
- 注意：`db-concurrency.test.ps1` 与 `e2e-business-flow.test.ps1` 会写入固定手机号 `13900000001` 等种子数据，**不是幂等**的，重跑前需重建空库，否则报 `duplicate key value violates unique constraint "employee_phone_key"`。

## 二、L3 真 PostgreSQL 并发（`tests\db-concurrency.test.ps1`）

`5 passed 0 failed`：

1. 并发取号不重号：20 并发同时建销售单，单号样例 `E-9001-20261112-0001/0008/0005`，无重复。
2. 批次行锁：`SELECT ... FOR UPDATE` 期间第二个写者被挡住（真锁，不是应用层排队）。
3. RLS 跨租户不可见：以 `qingdan_app` 角色 + `app.tenant_id` 会话变量查询，另一租户数据 0 行。
4. 生成列：`remaining` / `available` 由库计算，直接写入被拒绝。
5. D15 跨公司校验：采购单明细引用别家公司商品，被真 PG 触发器拒绝。

输出 `OK db-concurrency`，退出码 0。

## 三、L3 端到端业务流（`tests\e2e-business-flow.test.ps1`）

`5 passed 0 failed`：

1. 登录（业主手机号 + 开发码）。
2. 建 E 单（销售单）。
3. 完成 E 单扣库存：库存流水新增 2 条，每批 `-2.5`。
4. 完成即生成 C 结算单草稿：金额 75 / 成本 75。
5. 确认结算：待确认 → 已结算，并落审计。

`SKIP A 单完成入库：该端点属于 #99（未接）`。输出 `OK e2e-business-flow`，退出码 0。

## 四、浏览器逐页（真实 Chromium，已登录）

22 条路由全部 HTTP 200、`h1` 与路由名一致、**控制台 0 error、`/api/` 无 4xx/5xx**：

```text
/workbench /flow /purchase-orders /processing-orders /sales-orders
/internal-trades /settlements /reversals /products /customers /suppliers
/processors /inventory /inventory-flows /stocktakes /employees /permissions
/companies /profit-report /audit-logs /api-integration /login
```

- 已登录访问 `/login` 自动跳 `/workbench`（符合预期）。
- **唯一占位页**是 `/profit-report`（正文「待实现…页面骨架已就位」）；`/processing-orders` 文案注明「本批不含完成/验收」；其余页面均有真实数据或正常空态。
- 有数据的页面：员工 4 人、岗位 8 个（7 预设 + 1 自定义）、公司 `0001 演示公司`、操作日志含 `platform.token.read` 等记录。

## 五、浏览器写路径（逐条实测）

| 操作 | 结果 |
| --- | --- |
| 新增商品「东北珍珠米 25kg」 | `POST 201 products`，列表出现 |
| 编辑商品改名 | `PATCH 200 products/<id>`，请求头带 `If-Match: "1"`（版本校验生效） |
| 新增客户「宏发商行」（含联系人/电话/账期 30 天） | `POST 201 customers` |
| 新增供应商「华源粮油」（供货物料「大米、食用油」） | `POST 201 suppliers` |
| 新增加工厂「顺发加工厂」 | `POST 201 processors` |
| 新建岗位「演示岗位-只读采购」，勾选「商品·查 + A 采购单·查」 | `POST 201 positions`，摘要显示「商品·查、A 采购单·查」 |
| 编辑岗位改名 | `PATCH 200 positions/<id>` |
| 采购单开单：华源粮油 / 大米 10 × ¥8.60 | `POST 201 purchase-orders`，单号 `A-0001-20261112-0001`，货款 ¥86.00 |
| 销售单「导出 CSV」 | 下载 `销售单-20261112.csv` |
| 删除接口集成页的裸 OpenAPI 链接 | 页面只剩「创建 Token」按钮 + 页脚「接口契约真源：GET /api/v1/openapi.json（公开只读）」 |

## 六、本次未覆盖 / 仍是缺口

- A 单「完成入库」端点未接（`#99`），端到端流程到 E → C 为止。
- 支付回调只有框架（`#125`），真实拉起支付等域名备案与商户号（`#101`）。
- 短信验证码未启用（`TENCENT_SMS_*` 留空，登录用 `login_code` 一次性码，见 `docs/deploy.md` 第七节）。
- 浏览器验收只有 1 租户 / 1 公司 / 4 员工；多公司切换、跨公司数据隔离的 UI 表现未验。
- `ops/backup.ps1`、`ops/restore.ps1` 依赖 Windows 侧 `docker` 命令，本机没有安装，备份/恢复用同语义的 bash 等价脚本验证（结果见 `docs/deploy.md` 第七节）。
- 手机或其它设备访问需自行加 hosts 与信任 Caddy 根证书（`E:\qingdan-server\caddy-root.crt`）。

## 七、每日自动备份（本机已启用）

`docs/deploy.md` 把「每天自动备份」留给宿主机计划任务；本机的做法是在 WSL 内用 systemd timer（Linux 侧直接有 `docker compose exec`，比从 Windows 穿一层 WSL 稳定）：

- `/usr/local/bin/qingdan-backup.sh`：`pg_dump -Fc` 落到 `E:\qingdan-server\app\ops\backups\qingdan-<时间戳>.dump`，自动保留最近 14 份。
- `qingdan-backup.timer`：每天 **03:30（Asia/Shanghai）** 触发，`Persistent=true`（错过会补跑），已 `enable`。
- 实测首次运行：

```text
Nov 13 00:06:39 qingdan-backup.sh[38884]: 2026-11-13 00:06:39 backup ok: qingdan-20261113-000638.dump 264641 bytes
NEXT                         LEFT     LAST PASSED UNIT                 ACTIVATES
Fri 2026-11-13 03:30:00 CST  3h 23min -    -      qingdan-backup.timer qingdan-backup.service
```

- 用这份自动备份做恢复演练（建临时库、还原、比对行数，最后删临时库），结果：

```text
dump=ops/backups/qingdan-20261113-000638.dump size_bytes=264641
pg_restore_exit=0
tenant 1/1  employee 4/4  product 1/1  purchase_order 1/1
sales_order 0/0  inventory_batch 0/0  payment_transaction 0/0  全部 PASS
public_tables source=47 restore=47 | schema_migrations source=30 restore=30
[restore] PASS
```

## 八、复跑方式

```powershell
# 重建测试库（非幂等测试的前提）
wsl -d Ubuntu -u root -- bash -lc "cd /mnt/e/qingdan-server/app && docker compose exec -T postgres psql -U qingdan -d postgres -c 'DROP DATABASE IF EXISTS qingdan_test' -c 'CREATE DATABASE qingdan_test OWNER qingdan'"

# 全量（含真 PG）
$env:QINGDAN_TEST_DB = 'postgres://qingdan:<密码>@172.27.161.101:5433/qingdan_test'
pwsh -NoProfile -File tests\run.ps1
```
