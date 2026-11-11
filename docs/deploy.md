# 轻单部署手册（单机 Docker Compose）

> 适用于：一台 Linux 服务器（或装了 Docker Desktop 的 Windows）跑 `postgres + api + caddy`。
> 本手册不覆盖前端（`apps/web` 暂不部署）。

## 一、前置条件

- Docker Engine 24+ 与 Compose v2（`docker compose version` 能输出 v2.x）。
- 服务器放通 80/443（无域名只用 80 也可以）；有域名时先把 A 记录指向本机。
- 仓库代码（本目录）与可写的 `ops/backups/` 目录。
- 建议 2C4G 起步；数据库卷会随业务量增长，注意磁盘余量。

## 二、首次部署

```bash
# 1. 准备环境变量（.env 不入库，里面都是真实密钥）
cp .env.example .env
#    必改：POSTGRES_PASSWORD、DATABASE_URL 里的同名密码
#    必改：PUBLIC_BASE_URL —— 填最终对外基址（如 https://qingdan.example.com；没域名时填 http://<服务器IP>）。
#          模板里是本地开发用的 http://localhost:5173，直接拿去生产 API 会拒绝启动（见第五节「上线前检查清单」）
#    可选：SITE_ADDRESS（填域名即自动 HTTPS，留空为 :80 纯 HTTP）

# 2. 只起数据库，等它 healthy
docker compose up -d postgres
docker compose ps

# 3. 跑一次性迁移（独立容器，失败能直接看到输出）
docker compose --profile tools run --rm migrate

# 4. 起 API 与反向代理
docker compose up -d api caddy
docker compose ps
curl -fsS http://127.0.0.1/api/v1/health   # 期望 {"status":"ok","version":"..."}
```

需要种子数据时（仅开发/演示库）：

```bash
docker compose --profile tools run --rm --entrypoint pnpm migrate -C apps/api seed
```

> 不要在生产库跑 seed。

## 三、备份与恢复演练

```powershell
# 备份（默认保留最近 14 份，落在 ops/backups/）
pwsh -File ops/backup.ps1
pwsh -File ops/backup.ps1 -KeepCount 30
pwsh -File ops/backup.ps1 -KeepDays 7

# 恢复演练：恢复到临时库 qingdan_restore_check 并比对 6 张关键表行数
pwsh -File ops/restore.ps1 -DumpPath ops/backups/qingdan-20261108-153000.dump
# 目标临时库已存在时需显式覆盖：
pwsh -File ops/restore.ps1 -DumpPath ops/backups/qingdan-20261108-153000.dump -Force
```

脚本最后打印 `PASS` 才算演练成功；`FAIL` 会以退出码 1 结束。演练库不会自动删除，
确认无误后按脚本提示执行 `DROP DATABASE qingdan_restore_check` 清理。

演练频率建议：上线前一次 + 每次大版本前一次；备份本身建议交给宿主机 cron / 计划任务每日跑。

## 四、按镜像 tag 回滚

部署时给镜像打上版本 tag，回滚就是把 compose 指回旧 tag：

```bash
# 发布：构建并打 tag
docker build --target runtime -t qingdan-api:2026.11.08-1 .
# 回滚：改 docker-compose.yml 里 api.build 为 image: qingdan-api:<旧tag>
docker compose up -d api
```

更省事的做法是把 `api` 服务改成 `image: qingdan-api:${API_IMAGE_TAG}`，在 `.env` 里改 tag。
**注意**：镜像回滚不自动回滚数据库；迁移是前向 only，回滚旧镜像前先确认旧代码兼容当前库结构，
必要时用备份恢复到新库验证。

## 五、上线前检查清单

每次部署/换机逐项打勾，缺一项都可能在浏览器里表现为「页面能开、一保存就 403」：

- [ ] `PUBLIC_BASE_URL` = 用户实际访问的地址（协议 + 域名或 IP，**不带结尾斜杠**）。
  - 有域名：`https://qingdan.example.com`（配 `SITE_ADDRESS=qingdan.example.com`，Caddy 自动签证书）。
  - 域名备案没下来：先 `http://<服务器公网IP>` + `SITE_ADDRESS=:80`（纯 HTTP，只用于内部联调）。
  - **不能填** `localhost` / `127.0.0.1` / `0.0.0.0` / `::1`：`NODE_ENV=production` 下 API 会直接拒绝启动
    （`apps/api/src/platform/config.ts` 的 `assertPublicBaseUrl`），这是刻意 fail-fast，不是 bug。
- [ ] `SITE_ADDRESS` 与 `PUBLIC_BASE_URL` 指向同一个对外地址（只改其中一个会让浏览器 Origin 与配置不一致）。
- [ ] `NODE_ENV=production`、`TRUST_PROXY=true`（在 Caddy 后面，用于取真实客户端 IP 与协议）。
- [ ] `POSTGRES_PASSWORD` / `DATABASE_URL` 里的密码一致且已换掉模板值；`.env` 未入库。
- [ ] 迁移已跑：`docker compose --profile tools run --rm migrate`（不随应用自启，升级时手动执行）。
- [ ] 健康检查通过：`curl -fsS http://127.0.0.1/api/v1/health` 返回 200。
  （`api` 服务只 `expose: 3000`，宿主机没有映射 3000；对外只用 Caddy 的 80/443。
  容器内自查用 `docker compose exec api node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>console.log(r.status))"`。）
- [ ] 浏览器实测一次**写操作**（新增商品/客户）：返回 200/201 而不是 403。

## 六、常见故障

| 现象 | 排查 |
| --- | --- |
| api 日志报连不上数据库 | `docker compose ps` 看 postgres 是否 healthy；`docker compose logs postgres`；确认 `.env` 的 `DATABASE_URL` 主机名是 `postgres` 而不是 `localhost` |
| 端口被占用（`bind: address already in use`） | `ss -lntp \| grep -E ':80\|:443'` 找到占用进程；或改 compose 的端口映射 |
| 证书申请失败 | 域名是否解析到本机、80/443 是否放通、`docker compose logs caddy` 看 ACME 报错；内网无域名就用 `SITE_ADDRESS=` 走 :80 |
| 迁移 checksum 不一致 | 有人改了历史迁移文件；不要改历史 SQL，改为新增迁移文件 |
| 健康检查一直 unhealthy | 容器内 `docker compose exec api node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>console.log(r.status))"` |

> 当前开发机未安装 docker，以上编排与脚本均**未做运行验证**。
