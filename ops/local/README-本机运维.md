# 轻单 · 本机服务器运维说明

本机被临时当作部署环境（Windows 10 + WSL2 Ubuntu + Docker）。本文件只描述**这台机器**的做法，通用部署见仓库 `docs/deploy.md`。

> **这些文件的家在仓库 `ops/local/`**，`E:\qingdan-server\` 下的是部署副本。
> 要改就改仓库里那份，然后跑 `ops/local/sync-up.ps1` 同步过去 —— 直接改 E 盘会导致下次同步被覆盖。

## 访问

| 用途 | 地址 |
| --- | --- |
| 浏览器入口 | https://qingdan.internal/ （桌面快捷方式「轻单.lnk」） |
| 纯 HTTP | http://127.0.0.1/ 或 http://10.12.2.75/ → 301 跳到上面那个域名 |
| 健康检查 | https://qingdan.internal/api/v1/health |
| 测试库（宿主直连） | `172.27.161.101:5433` 库 `qingdan_test`（端口发布在 WSL 命名空间内，`127.0.0.1` 连不上） |

演示账号：手机号 `10000000001`，验证码由脚本现签（见下），不是固定码。

## 目录

| 路径 | 内容 |
| --- | --- |
| `E:\qingdan-server\app` | 部署副本（仓库快照 + 本机 override，**不是 git 工作树**） |
| `E:\qingdan-server\app\.env` | 环境变量（密码、pepper、PUBLIC_BASE_URL），同步时不会被覆盖 |
| `E:\qingdan-server\wsl\Ubuntu\ext4.vhdx` | WSL 发行版磁盘（Docker 数据也在这里） |
| `E:\qingdan-server\app\ops\backups` | 每日备份 `.dump`，同步时不会被覆盖 |
| `E:\qingdan-server\caddy-root.crt` | Caddy 根证书（别的设备要信任它） |
| `E:\qingdan-server\start-server.ps1` | 一键拉起（管理员）：发行版 + keep-alive + 容器 + 端口转发 + 防火墙 |
| `E:\qingdan-server\issue-login-code.ps1` | 签发一次性登录码 |

仓库侧对应：`ops/local/Dockerfile.local`、`ops/local/docker-compose.override.yml`、`ops/local/Caddyfile.local`、`ops/local/start-server.ps1`、`ops/local/issue-login-code.ps1`、`ops/local/sync-up.ps1`、本文件。

## 部署副本是怎么来的 / 怎么升级

`E:\qingdan-server\app` 是**仓库的复制品**，没有 `.git`。所以它**不会自己跟着 main 走**——2026-11-17 实测它还停在迁移 `0030`，而仓库已经到 `2026033` + 两个时间戳迁移，也就是线上落后 5 个迁移。

升级用一条命令（在仓库工作树里跑，需要管理员）：

```powershell
pwsh -File ops\local\sync-up.ps1
```

它按顺序做九件事，每步失败都会停下并说明原因：

0. **升级前验证**：在仓库里跑 `pnpm -r build` → `pnpm -r test` → `tests/run.ps1`，任一不过就停在这里，**线上一个字节都不动、连备份都不做**。负责人口径（2026-11-17）：「系统升级都先准备好，测试好才更新」。日志落在 `%TEMP%\qingdan-verify-<时间>.log`。
1. 触发一次数据库备份，并核对最新 `.dump` 不超过 10 分钟（**删列类迁移不可逆，没备份就不允许继续**）
2. `robocopy` 把仓库代码同步到 `E:\qingdan-server\app`，排除 `.env` / `.git` / `node_modules` / `dist` / `ops\backups`
3. 把 `ops/local/` 下的三个本机覆盖文件摆到 compose 会读的位置
4. `docker compose build api migrate` 重建镜像（**两个都要重建**，理由见下面「升级时踩过的坑」）
5. `docker compose --profile tools run --rm migrate` 跑迁移（**迁移从不随应用自启**）
6. `docker compose up -d`
7. `pnpm -r build` 并发布 `apps/web/dist`（Caddy 直接挂这个目录，前端改动不重建镜像）
8. 自检 `https://qingdan.internal/api/v1/health` 必须是 200

常用开关：`-SkipVerify`（跳过第 0 步，只在急着回滚时用）、`-SkipBackup`（已手动备过）、`-SkipBuild`（只改了前端或文档）、`-SkipFrontend`、`-DryRun`（只看会做什么）。

> 第 0 步是要挡住「代码刚合进 main 就直接铺到唯一能点开的环境」这件事。这一步约 4 分钟；不想等就说明这次升级是回滚，不是发布。

## 日常操作

```powershell
# 拉起整套（需管理员；登录时会由计划任务 QingdanServer 自动跑一次）
powershell -ExecutionPolicy Bypass -File E:\qingdan-server\start-server.ps1

# 看容器状态
wsl -d Ubuntu -u root -- bash -lc "cd /mnt/e/qingdan-server/app && docker compose ps"

# 看备份
wsl -d Ubuntu -u root -- systemctl list-timers qingdan-backup.timer
wsl -d Ubuntu -u root -- bash -lc "ls -lt /mnt/e/qingdan-server/app/ops/backups | head"

# 立刻备份一次
wsl -d Ubuntu -u root -- systemctl start qingdan-backup.service

# 发一个登录码（默认手机号 10000000001、码 000000、30 天有效、一次性）
powershell -ExecutionPolicy Bypass -File E:\qingdan-server\issue-login-code.ps1
```

## 改前端后怎么上线

Caddy 直接把 `E:\qingdan-server\app\apps\web\dist` 当静态目录挂着（不重建镜像），所以前端改动只需要重建并拷一份：

```powershell
cd 'D:\快捷方式\工作台\dsh\Qingdan'   # 仓库工作树（注意不是 E 盘）
pnpm -r build                          # 必须先建 @qingdan/contracts，否则 apps/web 编译不过
pnpm -C apps/web build
Remove-Item E:\qingdan-server\app\apps\web\dist -Recurse -Force
Copy-Item D:\快捷方式\工作台\dsh\Qingdan\apps\web\dist E:\qingdan-server\app\apps\web\dist -Recurse
```

或者直接用 `pwsh -File ops\local\sync-up.ps1 -SkipBackup -SkipBuild`，它把这一步也包了。

刷新浏览器即可。后端改动才需要 `docker compose build api` 并 `up -d api`。

## 备份

- `qingdan-backup.timer`（systemd，WSL 内）每天 **03:30（Asia/Shanghai）** 跑一次 `pg_dump -Fc`，落到 `ops/backups/qingdan-<时间戳>.dump`，自动保留最近 **14 份**。
- 停用：`wsl -d Ubuntu -u root -- systemctl disable --now qingdan-backup.timer`。
- 恢复演练（会建临时库、比对 7 张表行数和 47/47 表结构，最后自动删临时库）：
  `wsl -d Ubuntu -u root -- bash /mnt/c/Users/32800/AppData/Local/Temp/qingdan-restore-verify.sh`
- 仓库里的 `ops/backup.ps1`、`ops/restore.ps1` 依赖**宿主机的 docker 命令**，这台机器没有（Docker 只在 WSL 里），所以在本机跑不了，用上面的 WSL 等价命令。

## 本机特有的边界

1. **WSL 会自己睡死**：没有长连接时空闲约 90 秒整个发行版会 Stopped、容器全停。`start-server.ps1` 会用 `sleep infinity` 保活；机器重启后要靠计划任务 `QingdanServer`（登录时、最高权限）重新跑一次。
2. **端口转发会过期**：WSL2 的 IP 每次重启可能变，`netsh portproxy` 指向的是旧 IP，局域网就不通。`start-server.ps1` 每次按 `hostname -I` 重设 80/443，所以只要它以管理员身份跑过就没问题。
3. **只认 `qingdan.internal` 这个域名**：TLS 客户端不会给 IP 字面量发 SNI，`https://127.0.0.1`、`https://10.12.2.75` 必然握手失败；80 端口已统一 301 到域名。
4. **浏览器要能解析域名**：本机靠 `hosts` 里的 `127.0.0.1 qingdan.internal`；别的设备要把这个域名指到 `10.12.2.75`，并信任 `caddy-root.crt`。
5. **系统代理会拦内网域名**：Chrome 走代理时 `qingdan.internal` 会被送到 127.0.0.1:7890。已在 `ProxyOverride` 里加了 `*.internal`；换代理软件后要重新加。
6. **构建/拉镜像才需要代理**：宿主 `D:\tools\wsl-proxy-relay.js`（18888 → 本机 7890）。运行时不依赖它；日常跑服务不需要开着。`Dockerfile.local` 里设了 `NODE_USE_ENV_PROXY=1`，就是为了让镜像构建期能经代理出网。
7. **Windows 侧没有 docker 命令**：`ops/backup.ps1`、`ops/restore.ps1` 在这台机器上跑不了，用上面的 WSL 等价命令。
8. **compose override 只认根目录**：`docker-compose.override.yml` 必须放在 `E:\qingdan-server\app\` 根下才会被自动加载；仓库里它住在 `ops/local/`，由 `sync-up.ps1` 复制过去。

## 升级时踩过的坑（2026-11-17 首次真实升级记录）

**只 `docker compose build api` 会漏掉 migrate 的镜像。** compose 里 `migrate` 是独立 build（`target: builder`），不重建它就会拿四天前的旧镜像跑，而旧镜像里的迁移文件清单是旧的：

```
[migrate] 完成：applied=0 skipped=30     ← 看着像"都跑过了"，其实新迁移一个没跑
```

紧接着 api 启动被 `schema-guard` 拦下（这是它该做的），报：

```
SchemaOutOfDateError: 数据库结构落后于代码：缺少迁移 20261116043000_settlement_orders_unsettle.sql
```

然后 `dependency failed to start: container qingdan-api-1 is unhealthy`，整站 502。

**正确顺序**：`build api migrate` → `--profile tools run --rm migrate` → `up -d`。`sync-up.ps1` 已按此修正。

另外两点也记下来：

- **`up -d` 报 unhealthy 不等于失败**。api 有自己的健康检查启动期，实测等 10 秒后 `docker compose ps` 就是 `Up (healthy)`。脚本现在会在 up 失败时等 60 秒再按 `ps` 判定，不把"慢"当"坏"。
- **前端构建要先 `pnpm -r build`**。`apps/web` 依赖 `@qingdan/contracts` 的 `dist`，干净目录里直接 `pnpm -C apps/web build` 会报 `Cannot find module '@qingdan/contracts'`。