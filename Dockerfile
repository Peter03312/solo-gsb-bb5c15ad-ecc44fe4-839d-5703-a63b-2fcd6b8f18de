# ---- 阶段 1：构建 React 前端 ----
FROM node:20-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 阶段 2：安装后端生产依赖（better-sqlite3 在 Alpine 下从源码编译） ----
FROM node:20-alpine AS server-deps
WORKDIR /app/server
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

# ---- 阶段 3：运行镜像 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DB_FILE=/data/orienteering.db
ENV PORT=3000
# 首次启动写入演示赛事；生产空白启动可在 compose 中置 SEED=0
ENV SEED=1
RUN apk add --no-cache tini libstdc++ libgcc && mkdir -p /data
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY --from=web-build /app/web/dist ./web/dist

EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.mjs"]
