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
  - **迁移必须先于新代码**：API 启动时会核对 `schema_migrations`（`apps/api/src/platform/db/schema-guard.ts`），
    缺 0026 会直接拒绝启动并打印缺失项，不会带旧库跑新代码。
  - 本次发布含 0026（结算确认时间）与 0027（采购单 D15 触发器）：执行顺序、备份、锁表风险、回填策略、
    回滚方案和自检 SQL 见 [docs/runbook-0026-settled-at.md](runbook-0026-settled-at.md)；
    发布记录里必须写明这两条迁移是「已执行」还是「待发布执行」。
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

## 七、本机（Windows + WSL2）验证记录（2026-11-12）

本手册的编排与脚本已在开发机实跑验证一遍，结论与差异如下。

**环境**

- Windows 10 19045 + WSL2 Ubuntu 26.04（发行版磁盘放在 `E:\qingdan-server\wsl\Ubuntu\ext4.vhdx`，
  用 `wsl --export` / `--import` 从 C 盘迁过去的）。
- WSL 内 `docker.io` 29.1.3 + `docker-compose-v2` 2.40.3；Windows 侧**没有** docker CLI。
- 部署目录 `E:\qingdan-server\app`（仓库快照 `2d6c450`），`ops/backups/` 有当次 dump。

**首次部署四步全部通过**

| 步骤 | 结果 |
| --- | --- |
| `docker compose up -d postgres` | `qingdan-postgres-1` healthy，`select version()` = PostgreSQL 18.6 |
| `docker compose --profile tools run --rm migrate` | `applied=30 skipped=0`（0001 基线 + 0002…0030） |
| `docker compose up -d api caddy` | api healthy（镜像 384MB）、caddy 监听 0.0.0.0:80/443 |
| `curl http://127.0.0.1/api/v1/health` | 200 `{"status":"ok","version":"0.0.0"}` |

**四项验收（全部 PASS，命令可复现）**

1. **health 200**：WSL 内 `curl -o /dev/null -w '%{http_code}' http://127.0.0.1/api/v1/health` → `200`；
   Windows 侧 `Invoke-WebRequest http://127.0.0.1/api/v1/health` → 200；局域网 `http://10.12.2.75/api/v1/health` → 200。
2. **表数量**：`select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`
   → **47**（历史记录里的 43 是迁移到 0025 时的数字，现到 0030）；`schema_migrations` 30 行。
3. **dump 恢复比对**：`pg_dump -Fc`（约 260KB）→ `pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error`
   进临时库 `qingdan_restore_check`，退出码 0；6 张关键表行数一致（tenant 1/1、employee 4/4、product 1/1、
   sales_order 0/0、inventory_batch 0/0、payment_transaction 0/0），public 表 47/47、迁移 30/30 → `PASS`。
4. **杀容器自愈**（**手法要按这个来**）：
   - `docker kill qingdan-api-1` **不会**自愈——`docker kill` 属于「手动停止」，`restart: unless-stopped` 对人工停止不重起。
   - `docker compose exec api kill -9 1` 也**不会**——PID 1 是 `dumb-init`，SIGKILL 对 PID 1 被内核忽略。
   - 正确做法：从**宿主机**杀容器内的 node 进程。`docker top qingdan-api-1 -eo pid,args` 拿到宿主 PID，
     `kill -9 <pid>` → `docker compose ps` 显示 `restart=1`，3 秒内 `running + healthy`，health 回到 200。

**重启韧性**：`wsl --shutdown` 后重新进入发行版，`systemctl is-active docker qingdan-net` 均为 active，
三个容器随 docker 服务自动拉起（`Up 16 seconds (healthy)`），health 200、product 数据、审计日志都在，
恢复演练再跑一遍仍 `PASS`。

**浏览器登录/写操作：三种访问方式的实测对照**

用真实 Chromium（Playwright）分别跑一遍「登录 → /auth/me → 新增商品」：

| 打开地址 | secureContext | 登录 | 读 /auth/me | 新增商品 POST |
| --- | --- | --- | --- | --- |
| `http://10.12.2.75`（IP + HTTP） | false | 200 | **401**（cookie 没存下来） | — |
| `http://127.0.0.1`（本地回环） | true | 200 | 200 | **403**（来源与本站不同源） |
| `https://qingdan.internal`（内网 HTTPS，做法见下） | true | 200 | 200 | **201** |

结论：**只要不是 HTTPS，浏览器里就完不成「登录后写数据」**。两条原因都不是配置写错：

- **Secure cookie**：`apps/api/src/platform/auth/cookie.ts:11` 的注释写「仅 production（本地 http 调试也能登录）」，
  但 `apps/api/src/modules/platform/usecases/login.ts:151` 实际传的是 `secure: isProduction(ctx.config)`，
  production 下即使对外是 `http://<IP>` 也带 `Secure`。浏览器只在安全上下文（HTTPS 或 localhost/127.0.0.1）才保存
  `Secure` cookie，所以 `http://<IP>` 的表现是「登录返回 200，下一个请求 401」。
- **同源校验**：写操作要求 `Origin`/`Referer` 与 `PUBLIC_BASE_URL` 完全同源（`apps/api/src/platform/auth/plugin.ts` 的
  `assertCookieRequestSameOrigin`，刻意做的 CSRF 防护，不是 bug）。它把「用哪个地址打开页面」钉死成 `.env` 里那一个：
  `PUBLIC_BASE_URL=http://10.12.2.75` 时用 `http://127.0.0.1` 打开，读接口正常、**所有写操作 403**。
- curl 侧同样验证：带 `Origin: http://10.12.2.75` + 正确 cookie 调 `POST /api/v1/products` → **201**，
  product 表落一行、`audit_log` 记 `product.create|success`。

**内网 HTTPS 的做法（本机验证采用，不需要备案也不用公网域名）**

1. `deploy/Caddyfile.local`（部署副本里的本地文件）：站点写 `{$SITE_ADDRESS:qingdan.internal}`，并加 **`tls internal`**
   让 Caddy 用自带 CA 签证书（内网名没有公网 A 记录，走 ACME 必然失败）。
2. `docker-compose.override.yml` 把 `caddy` 的 `/etc/caddy/Caddyfile` 挂到 `Caddyfile.local`。
3. `.env`：`SITE_ADDRESS=qingdan.internal`、`PUBLIC_BASE_URL=https://qingdan.internal`（两者必须同一个对外地址）。
4. `docker compose up -d --force-recreate api caddy`。caddy 日志会依次出现
   `certificate obtained successfully","identifier":"qingdan.internal","issuer":"local"`、
   `server running ... protocols:["h1","h2","h3"]`、80 端口自动 308 跳 443。
5. 客户端信任这个 CA：从容器导出 `/data/caddy/pki/authorities/local/root.crt`，
   Windows 上 `certutil -addstore -f Root <证书>`（本机实测 `CN=Caddy Local Authority - 2026 ECC Root`，有效期到 2036）；
   `hosts` 加 `127.0.0.1 qingdan.internal`。
6. **系统代理要绕行**：本机系统代理是 `127.0.0.1:7890`，绕过列表只有 `<local>`，`qingdan.internal` 会被送进代理，
   浏览器报 `ERR_CONNECTION_CLOSED`；把 `*.internal` 加进代理绕过（`ProxyOverride`）后恢复正常。
7. 端口：portproxy 要同时映射 80 与 443，防火墙入站规则 `Qingdan HTTP 80` / `Qingdan HTTPS 443`。

**HTTPS 下的实测**：`curl --ssl-no-revoke https://qingdan.internal/api/v1/health` → **200**；
Chromium 里 `login 200 → /auth/me 200（含 companyIds 与 scope）→ POST /api/v1/products 201 → 列表能查到新商品`。
（Windows 自带的 `curl.exe` 走 schannel，会因 Caddy 证书没有吊销信息报 `CRYPT_E_NO_REVOCATION_CHECK`，
加 `--ssl-no-revoke` 即可；浏览器不受影响。）

**前端 SPA 没人托管（这次最容易被当成「打不开」的坑）**

仓库的 `docker-compose.yml` 只编排了 `postgres` / `api` / `caddy` / `migrate`，**没有任何服务托管 `apps/web` 的构建产物**。
根路径 `/` 会落到 api 的鉴权中间件上，返回 `401 {"code":"UNAUTHENTICATED",...}` —— 浏览器里就是一段 JSON，
非常像「站点打不开」，其实 API 是好的。

本机做法（部署副本里的本地文件，**不入库**）：

1. 宿主机 `pnpm -C apps/web build` 产出 `apps/web/dist`；
2. `docker-compose.override.yml` 把它只读挂进 caddy：`./apps/web/dist:/srv/web:ro`；
3. `deploy/Caddyfile.local` 里 `handle /api/*` 反代 `api:3000`，其余走 `root * /srv/web` + `try_files {path} /index.html` + `file_server`（SPA 前端路由回退）。

实测（全部 200）：

```text
https://qingdan.internal/                     -> 200 text/html（index.html）
https://qingdan.internal/login                -> 200 text/html
https://qingdan.internal/assets/index-*.js    -> 200，524185 B
https://qingdan.internal/api/v1/health        -> 200 application/json
```

真服务器上线时前端应该做成独立镜像/服务（或在多阶段镜像里加一个 web 阶段 + nginx），不要挂宿主目录。

**IP / localhost 打不开是 TLS 的限制，不是证书没签**

TLS 客户端**不会为 IP 字面量发 SNI**（RFC 6066 禁止），Caddy 无法按 SNI 选证书 → 握手直接报 internal error
（Windows 侧 curl 显示 `SEC_E_ILLEGAL_MESSAGE (0x80090326)`）。所以 `https://127.0.0.1`、`https://10.12.2.75`
在协议层面就无解，签多少证书都没用。

`Caddyfile.local` 的第二个站点块只在 **80 端口**接住这些 Host，`redir https://qingdan.internal{uri} permanent`，
让它们从 HTTP 一步跳到唯一正统地址（顺带保证写操作 Origin 能过同源校验）。实测：
`http://127.0.0.1/ → 301 https://qingdan.internal/`、`https://localhost/ → 301` 同址。

**生产模式下的登录：本机没有短信通道**

`NODE_ENV=production` 时登录只认 `login_code` 表里的一次性验证码（`apps/api/src/modules/platform/usecases/login.ts:104`
的固定码直通只在非生产生效）；`TENCENT_SMS_*` 全空时点「获取验证码」返回 501「未开通短信服务」。
本机用 `E:\qingdan-server\issue-login-code.ps1` 直接往库里写一条码（`sha256(phone:code:pepper)`，与
`send-code.ts` 的 `hashLoginCode` 同算法），默认给 `10000000001` 签 `000000`、30 天有效；
**一次性**，登录成功即 `consumed_at` 置位，再登录要重跑脚本。

实测走完整 UI 链路：`https://qingdan.internal/ → 手机号 10000000001 + 000000 → 登录 → /workbench（你好，张明）→
商品资料页「新增商品」成功落库`。桌面上另放了快捷方式 `轻单.lnk`（直接打开 `https://qingdan.internal/`）。

**本机特有改动（只在部署副本里，未入库）**

本机没有直连外网，容器内 `fetch` 不认 `HTTP_PROXY`（Node 24 的 undici 默认不读环境代理），
所以在 `E:\qingdan-server\app` 放了三个**本地文件**（都不入库）：

- `Dockerfile.local`：`Dockerfile` 的副本，在 `ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0` 后插一行 `ENV NODE_USE_ENV_PROXY=1`；
- `docker-compose.override.yml`：`api` / `migrate` 的 `build.dockerfile` 指向 `Dockerfile.local`；`caddy` 挂
  `deploy/Caddyfile.local` 与前端产物 `./apps/web/dist:/srv/web:ro`；
- `deploy/Caddyfile.local`：比仓库版多三处本地专有内容——`tls internal`（内网 HTTPS）、
  `handle /api/*` + `file_server`（同时托管前端 SPA）、80 端口把 IP/localhost 301 到 `qingdan.internal`。

构建时要带代理：`HTTP_PROXY=http://<网关>:18888 HTTPS_PROXY=… docker compose --profile tools build api migrate`。
真实服务器直连外网**不需要**这些文件。宿主侧另有中转进程 `D:\tools\wsl-proxy-relay.js`（18888 → 127.0.0.1:7890），
WSL 内 `/usr/local/bin/qingdan-docker-proxy.sh` + `qingdan-net.service` 负责把网关写进 docker 的 systemd 环境。

**Windows 宿主侧**

- `ops/backup.ps1` / `ops/restore.ps1` 要求宿主机有 `docker` 命令；本机 Windows 没有，所以演练用等价的 bash 脚本做的
  （`pg_dump -Fc` / `pg_restore` / 6 表比对逻辑与脚本一致）。要在 Windows 上直接跑这两个脚本，得先装 docker CLI。
- 局域网访问靠 `netsh interface portproxy`（`0.0.0.0:80 → <WSL IP>:80`、`0.0.0.0:443 → <WSL IP>:443`）
  + 防火墙入站规则 `Qingdan HTTP 80` / `Qingdan HTTPS 443`。**WSL 的 IP 会变**，重启后要重设 portproxy；
  本机实测重启两次 IP 未变（仍是 172.27.161.101），但不能指望。
- 局域网里的**其它设备**要访问 HTTPS，需要在各自设备上把 `qingdan.internal` 指到本机 IP 并信任同一个 Caddy 根证书
  （手机没有 hosts 的话，最省事是给内网配一条 DNS 记录，或先继续用 `http://<IP>` 的接口联调方式）。

**本机当服务器：必须有个 keep-alive 顶着 WSL**

WSL2 发行版在最后一个 Windows 侧客户端进程退出后会自己停（实测：什么都不干等 90 秒，`wsl -l -v` 从
`Running` 变成 `Stopped`，容器跟着停）。所以「本机当服务器」不能只靠 `docker compose up -d`，需要三件事：

1. **keep-alive**：常驻一个 `wsl.exe -d Ubuntu -u root --exec /bin/sleep infinity`（隐藏窗口），WSL 就不会自己停；
2. **portproxy 重设**：WSL 重启后 IP 可能变（本机实测两次都是 172.27.161.101，但不能指望），`netsh interface portproxy` 要跟着更新；
3. **开机自启**：登录时跑一次启动脚本（要管理员权限改 portproxy/防火墙）。

已经落地的东西：

- `E:\qingdan-server\start-server.ps1`：依次做「拉起发行版 → 起 keep-alive → 等 docker.service active →
  容器没在跑就 `docker compose up -d` → 用当前 WSL IP 重设 80/443 两个 portproxy → 补防火墙规则/iphlpsvc →
  自检」，可重复执行，已实测输出 `http://127.0.0.1=301（期望 301）  https://qingdan.internal=200`。
- 计划任务 `QingdanServer`：`/sc onlogon /rl highest`，动作为
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "E:\qingdan-server\start-server.ps1"`。
  已用 `schtasks /run` 实测：任务 Ready（`last_result=0x0`）、发行版 Running、portproxy 在、`https://qingdan.internal/api/v1/health` → 200。
- **边界**：WSL 依赖用户登录会话，所以只能「登录后自启」，不是开机即服务；没登录时整栈是停的。
  需要真正开机即服务的话，得换 Linux 服务器或改成 Hyper-V 虚拟机 + 开机自启（不在本手册范围）。

> 结论：编排、迁移、备份恢复、自愈四项在真机环境全部可跑通；浏览器端的「登录 → 读 → 写」在
> `https://qingdan.internal`（Caddy 内置 CA）下实测全通过（200/200/201），纯 HTTP + IP 只适合接口联调。
