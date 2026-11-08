# 轻单 API 生产镜像（多阶段构建）
# 构建：docker build -t qingdan-api:local .
# 只运行 apps/api；apps/web 当前不部署（见 docs/deploy.md）。

# ============================ builder：装全量依赖并构建 ============================
FROM node:24-bookworm-slim AS builder

# corepack 按 package.json 的 packageManager 字段取 pnpm 版本，避免镜像里写死版本号。
# 关闭下载确认，保证 docker build 非交互。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# 先只拷贝清单文件，让“依赖安装”这一层能命中缓存：业务源码改动不必重装依赖。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 再拷贝全部源码并构建所有 workspace 包。
COPY . .
RUN pnpm -r build

# 生成“只含生产依赖”的可运行目录：
# pnpm deploy 会把 workspace 内部包（@qingdan/contracts 等）按真实文件复制进来，
# 不会留下指向 monorepo 其他目录的软链，因此可直接放进 runtime 镜像。
RUN pnpm --filter @qingdan/api deploy --prod /out/api

# ============================ runtime：只带生产依赖与构建产物 ============================
FROM node:24-bookworm-slim AS runtime

# dumb-init 作为 PID 1：把 SIGTERM/SIGINT 转发给 node，main.ts 的优雅关闭才会生效。
# 这样不依赖 docker run --init 或 compose 的 init: true。
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行用户；固定 UID/GID 便于排查宿主机挂载权限问题。
RUN groupadd --system --gid 1001 qingdan \
    && useradd --system --uid 1001 --gid qingdan --create-home --shell /usr/sbin/nologin qingdan

ENV NODE_ENV=production
WORKDIR /app

# deploy 产物根目录就是 apps/api 包本身（dist/、migrations/、node_modules/），
# 放到 /app/apps/api 下，保持 monorepo 相对路径与业务代码里的相对定位一致。
COPY --from=builder --chown=qingdan:qingdan /out/api ./apps/api

USER qingdan

# 端口来自配置：apps/api/src/platform/config.ts 的 PORT，默认 3000（容器内监听 HOST=0.0.0.0）。
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
